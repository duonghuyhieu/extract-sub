"""yt-dlp wrappers — channel/playlist scanning + per-video download.

Two functions here, both small:

* :func:`scan` extracts a flat listing of a URL (channel, playlist, or single
  video). Uses ``extract_flat='in_playlist'`` so a 1000-video channel comes
  back in one request without per-video metadata fetches.
* :func:`download` pulls a single video to disk and reports progress through
  the standard ``Job`` progress callback.
"""
from __future__ import annotations

import threading
from pathlib import Path
from typing import Callable, Optional


# Cap concurrent yt-dlp downloads to avoid hammering the network and tripping
# rate-limits. The Semaphore is reused across all jobs.
_DEFAULT_CONCURRENCY = 2
_dl_sem = threading.Semaphore(_DEFAULT_CONCURRENCY)
_concurrency_lock = threading.Lock()
_current_concurrency = _DEFAULT_CONCURRENCY


def set_concurrency(n: int) -> None:
    """Reset the concurrency limit. Safe to call between jobs; in-flight ones
    keep their existing slot until they release."""
    global _dl_sem, _current_concurrency
    n = max(1, min(8, int(n)))
    with _concurrency_lock:
        if n == _current_concurrency:
            return
        _dl_sem = threading.Semaphore(n)
        _current_concurrency = n


# ----------------------------------------------------------------------
# Scan — return a uniform list of entries regardless of URL type
# ----------------------------------------------------------------------

def scan(url: str) -> dict:
    """Resolve a URL to a list of downloadable entries.

    Returns ``{ "title": str, "kind": "channel"|"playlist"|"video", "entries": [...] }``
    where each entry has ``id``, ``title``, ``url``, ``duration``, ``uploader``,
    ``thumbnail``, ``upload_date``, ``view_count`` (any may be ``None``).
    """
    import yt_dlp

    ydl_opts = {
        "extract_flat": "in_playlist",   # don't recurse into each video
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": False,
        "ignoreerrors": True,
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=False)
    if info is None:
        raise RuntimeError("yt-dlp returned no info — URL not recognised?")

    if info.get("_type") in {"playlist", "multi_video"} or "entries" in info:
        kind = "channel" if (info.get("channel") or info.get("uploader_id")) else "playlist"
        entries = [_normalize_entry(e) for e in (info.get("entries") or []) if e]
        return {
            "title": info.get("title") or info.get("uploader") or url,
            "uploader": info.get("uploader") or info.get("channel"),
            "kind": kind,
            "entries": entries,
        }

    # Single video.
    return {
        "title": info.get("title") or url,
        "uploader": info.get("uploader") or info.get("channel"),
        "kind": "video",
        "entries": [_normalize_entry(info)],
    }


def _normalize_entry(e: dict) -> dict:
    vid = e.get("id")
    # extract_flat doesn't always populate `webpage_url`; reconstruct from id
    # for YouTube so downloads can re-fetch.
    url = e.get("url") or e.get("webpage_url")
    if vid and (not url or not url.startswith("http")):
        if e.get("ie_key") == "Youtube" or e.get("extractor") == "youtube":
            url = f"https://www.youtube.com/watch?v={vid}"
        else:
            url = url or vid

    thumb = e.get("thumbnail")
    if not thumb and vid and (e.get("ie_key") == "Youtube" or e.get("extractor") == "youtube"):
        thumb = f"https://img.youtube.com/vi/{vid}/mqdefault.jpg"

    return {
        "id":           vid,
        "title":        e.get("title") or "(untitled)",
        "url":          url,
        "duration":     e.get("duration"),
        "uploader":     e.get("uploader") or e.get("channel"),
        "thumbnail":    thumb,
        "upload_date":  e.get("upload_date"),
        "view_count":   e.get("view_count"),
    }


# ----------------------------------------------------------------------
# Download — single video
# ----------------------------------------------------------------------

def download(
    url: str,
    output_dir: Path,
    format_spec: str,
    *,
    output_template: str = "%(title)s.%(ext)s",
    merge_output_format: str = "mp4",
    progress_cb: Optional[Callable[[float, str], None]] = None,
) -> Path:
    """Download one video to ``output_dir``. Returns the final saved path.

    Throttled by the module-level semaphore so spawning 50 jobs at once still
    only hits the network from N at a time.
    """
    import yt_dlp

    output_dir = Path(output_dir).expanduser()
    output_dir.mkdir(parents=True, exist_ok=True)

    # Track the actual file path written to disk. yt-dlp reports it via the
    # progress hook on the final 'finished' event after any merging.
    saved_paths: list[Path] = []

    def hook(d: dict) -> None:
        status = d.get("status")
        if status == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            done = d.get("downloaded_bytes") or 0
            speed = d.get("speed") or 0
            eta = d.get("eta")
            if progress_cb:
                if total > 0:
                    pct = (done / total) * 100
                    msg = f"{pct:.0f}% · {speed / 1024 / 1024:.1f} MB/s"
                    if eta:
                        msg += f" · ETA {int(eta)}s"
                    # Reserve last 5% for post-processing.
                    progress_cb(min(95.0, pct * 0.95), msg)
                else:
                    progress_cb(0.0, f"{done / 1024 / 1024:.1f} MB · {speed / 1024 / 1024:.1f} MB/s")
        elif status == "finished":
            fn = d.get("filename") or d.get("info_dict", {}).get("_filename")
            if fn:
                saved_paths.append(Path(fn))
            if progress_cb:
                progress_cb(96.0, "Post-processing…")

    def pp_hook(d: dict) -> None:
        if d.get("status") == "finished":
            fn = d.get("info_dict", {}).get("filepath")
            if fn:
                saved_paths.append(Path(fn))

    ydl_opts = {
        "format":              format_spec,
        "outtmpl":             str(output_dir / output_template),
        "merge_output_format": merge_output_format,
        "progress_hooks":      [hook],
        "postprocessor_hooks": [pp_hook],
        "quiet":               True,
        "no_warnings":         True,
        "noprogress":          True,    # we route progress through our hook
        "concurrent_fragment_downloads": 4,
        "retries":             5,
        "fragment_retries":    5,
    }

    with _dl_sem:
        if progress_cb:
            progress_cb(1.0, "Starting download…")
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            # Most reliable way to get the final filename — covers post-merge.
            try:
                guessed = Path(ydl.prepare_filename(info))
                if guessed.exists():
                    saved_paths.append(guessed)
                else:
                    merged = guessed.with_suffix(f".{merge_output_format}")
                    if merged.exists():
                        saved_paths.append(merged)
            except Exception:
                pass

    # Pick the most recently observed existing path.
    for p in reversed(saved_paths):
        if p.exists():
            return p
    # Last resort: scan output_dir for the newest file.
    files = sorted(output_dir.glob("*"), key=lambda p: p.stat().st_mtime, reverse=True)
    if files:
        return files[0]
    raise RuntimeError("Download finished but no file was found on disk.")
