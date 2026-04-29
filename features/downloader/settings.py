"""User-configurable downloader settings, persisted as JSON next to app.py.

Kept tiny on purpose — only the things a user genuinely cares about between
sessions: where files land, default quality, audio-only toggle.
"""
from __future__ import annotations

import json
import threading
from pathlib import Path

from core.config import BASE_DIR

SETTINGS_FILE = BASE_DIR / "downloader_settings.json"

# yt-dlp format strings — keys here are what the UI shows, values are what
# yt-dlp consumes. The default avoids ffmpeg-merging so users without ffmpeg
# still get a usable file out of the box.
FORMAT_PRESETS: dict[str, str] = {
    "best":           "bestvideo+bestaudio/best",
    "1080p":          "bestvideo[height<=1080]+bestaudio/best",
    "720p":           "best[height<=720][ext=mp4]/best[height<=720]",
    "480p":           "best[height<=480][ext=mp4]/best[height<=480]",
    "360p":           "best[height<=360][ext=mp4]/best[height<=360]",
    "audio":          "bestaudio[ext=m4a]/bestaudio",
}

DEFAULTS: dict = {
    "download_path": str(Path.home() / "Downloads" / "MediaToolkit"),
    "format_preset": "720p",
    "merge_output_format": "mp4",   # used when format requires merging
    "concurrent_downloads": 2,
    "output_template": "%(title)s.%(ext)s",
}

_lock = threading.Lock()


def load() -> dict:
    """Read settings from disk, falling back to defaults for any missing key."""
    if SETTINGS_FILE.exists():
        try:
            data = json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
            return {**DEFAULTS, **data}
        except (json.JSONDecodeError, OSError):
            pass
    return DEFAULTS.copy()


def save(updates: dict) -> dict:
    """Merge updates into the on-disk settings and return the new full dict."""
    with _lock:
        cur = load()
        # Validate format_preset against the catalogue, ignore unknown keys.
        if "format_preset" in updates and updates["format_preset"] not in FORMAT_PRESETS:
            raise ValueError(f"Unknown format_preset: {updates['format_preset']!r}")
        if "concurrent_downloads" in updates:
            n = int(updates["concurrent_downloads"])
            if not 1 <= n <= 8:
                raise ValueError("concurrent_downloads must be 1..8")
            updates["concurrent_downloads"] = n
        cur.update({k: v for k, v in updates.items() if k in DEFAULTS})
        SETTINGS_FILE.write_text(
            json.dumps(cur, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
        return cur


def resolve_format(preset: str) -> str:
    """Map a UI preset key to yt-dlp's format spec string."""
    return FORMAT_PRESETS.get(preset, FORMAT_PRESETS["720p"])
