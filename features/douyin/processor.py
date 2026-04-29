"""Douyin direct-URL downloader.

The companion userscript (see ``static/js/douyin-userscript.js``) collects
video metadata + direct CDN URLs from a Douyin user profile. This module
just streams those URLs to disk — no anti-bot signing, no yt-dlp.
"""
from __future__ import annotations

import re
import threading
import urllib.request
import urllib.error
from datetime import datetime
from pathlib import Path
from typing import Callable, Optional


# Same throttling pattern as the YouTube downloader: cap concurrent saves
# so we don't drown the network or trip Douyin's CDN.
_DEFAULT_CONCURRENCY = 3
_dl_sem = threading.Semaphore(_DEFAULT_CONCURRENCY)
_concurrency_lock = threading.Lock()
_current_concurrency = _DEFAULT_CONCURRENCY


def set_concurrency(n: int) -> None:
    global _dl_sem, _current_concurrency
    n = max(1, min(8, int(n)))
    with _concurrency_lock:
        if n == _current_concurrency:
            return
        _dl_sem = threading.Semaphore(n)
        _current_concurrency = n


# Browser-ish headers — Douyin's CDN happily serves these requests as long
# as the Referer says douyin.com.
_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36 Edg/118.0.0.0"
    ),
    "Referer": "https://www.douyin.com/",
    "Accept": "*/*",
    "Accept-Language": "vi,en;q=0.9",
}


_INVALID_NAME_CHARS = re.compile(r'[\\/:*?"<>|\r\n\t]')


def safe_filename(stem: str, max_len: int = 80) -> str:
    """Strip path-hostile characters and clamp length so Windows is happy."""
    cleaned = _INVALID_NAME_CHARS.sub(" ", stem).strip()
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned[:max_len].strip() or "douyin_video"


def download_url(
    url: str,
    output_path: Path,
    *,
    progress_cb: Optional[Callable[[float, str], None]] = None,
    chunk_size: int = 64 * 1024,
) -> Path:
    """Stream ``url`` to ``output_path`` with progress reporting.

    Returns the final saved path. Raises on HTTP / network errors.
    """
    output_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = output_path.with_suffix(output_path.suffix + ".part")

    req = urllib.request.Request(url, headers=_HEADERS)
    with _dl_sem:
        if progress_cb:
            progress_cb(1.0, "Connecting…")
        with urllib.request.urlopen(req, timeout=60) as resp:
            total = int(resp.headers.get("Content-Length") or 0)
            done = 0
            with tmp_path.open("wb") as f:
                while True:
                    chunk = resp.read(chunk_size)
                    if not chunk:
                        break
                    f.write(chunk)
                    done += len(chunk)
                    if progress_cb:
                        if total > 0:
                            pct = (done / total) * 100
                            progress_cb(
                                min(98.0, pct * 0.98),
                                f"{pct:.0f}% · {done / 1024 / 1024:.1f} MB",
                            )
                        else:
                            progress_cb(0.0, f"{done / 1024 / 1024:.1f} MB")
        if progress_cb:
            progress_cb(99.0, "Finalising…")
        # Atomically promote the .part file once the stream finishes.
        if output_path.exists():
            output_path.unlink()
        tmp_path.rename(output_path)

    return output_path


def _parse_create_time(create_time: str) -> Optional[datetime]:
    """Parse the ISO timestamp the userscript writes (always UTC, with
    a trailing ``Z``) and convert to the local timezone of the machine.
    Returns ``None`` if the string is missing or unparseable."""
    if not create_time:
        return None
    try:
        # Python's fromisoformat doesn't accept a trailing 'Z' until 3.11,
        # so swap it for an explicit offset for compatibility.
        dt = datetime.fromisoformat(create_time.replace("Z", "+00:00"))
    except ValueError:
        return None
    # `astimezone()` with no argument converts to the system local zone.
    return dt.astimezone()


def build_filename(video: dict, kind: str, output_dir: Path) -> Path:
    """Pick a non-clashing filename for a Douyin video/audio download.

    Naming scheme: ``YYYY-MM-DD_HH-MM-SS.<ext>`` based on the video's posting
    time (``createTime`` in the JSON), converted to local time. We tried
    embedding Chinese titles before — Windows codepages couldn't handle some
    glyphs and Explorer rendered the folder as a mess. Timestamp-based names
    sort chronologically and stay safe across filesystems. The existing
    collision handler below appends `` (2)`` / `` (3)`` for the rare case
    of two videos posted in the same second.
    """
    ext = "mp4" if kind == "video" else "mp3"

    dt = _parse_create_time(video.get("createTime") or "")
    if dt is not None:
        stem = dt.strftime("%Y-%m-%d_%H-%M-%S")
    else:
        # Fallback if the JSON didn't include a timestamp. The video id is
        # at least unique even if it's not human-readable.
        vid_id = (video.get("id") or "").replace("/", "_")
        stem = vid_id or "douyin_video"

    stem = safe_filename(stem)
    candidate = output_dir / f"{stem}.{ext}"

    if candidate.exists():
        n = 2
        while True:
            alt = output_dir / f"{stem} ({n}).{ext}"
            if not alt.exists():
                return alt
            n += 1
    return candidate


def get_url(video: dict, kind: str) -> Optional[str]:
    """Pull the right CDN URL out of a userscript-shaped video record."""
    if kind == "video":
        return video.get("videoUrl") or None
    if kind == "audio":
        return video.get("audioUrl") or None
    return None
