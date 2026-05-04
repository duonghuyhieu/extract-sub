"""Logo stamping processor — overlays assets/logo.png onto a video using ffmpeg."""
from __future__ import annotations

import subprocess
import shutil
from pathlib import Path
from typing import Callable, Optional

from core.config import BASE_DIR

LOGO_PATH = BASE_DIR / "assets" / "logo.png"

# Position presets map to ffmpeg overlay expressions.
# x/y are relative to the video frame; pad adds some breathing room.
_PAD = 20
POSITIONS: dict[str, str] = {
    "top-left":     f"x={_PAD}:y={_PAD}",
    "top-right":    f"x=W-w-{_PAD}:y={_PAD}",
    "bottom-left":  f"x={_PAD}:y=H-h-{_PAD}",
    "bottom-right": f"x=W-w-{_PAD}:y=H-h-{_PAD}",
    "center":       "x=(W-w)/2:y=(H-h)/2",
}

VIDEO_EXTS = {".mp4", ".mkv", ".mov", ".avi", ".webm", ".flv", ".m4v", ".ts"}


def find_videos(folder: Path) -> list[Path]:
    """Return all video files directly inside *folder* (non-recursive)."""
    return sorted(
        p for p in folder.iterdir()
        if p.is_file() and p.suffix.lower() in VIDEO_EXTS
    )


def stamp(
    video_path: Path,
    position: str,
    *,
    logo_scale: float = 0.15,
    progress_cb: Optional[Callable[[float, str], None]] = None,
) -> Path:
    """Overlay the logo onto *video_path* in-place (overwrite).

    *logo_scale* is the logo width as a fraction of the video width.
    Returns the same path on success.
    """
    if not LOGO_PATH.exists():
        raise FileNotFoundError(f"Logo not found: {LOGO_PATH}")
    if position not in POSITIONS:
        raise ValueError(f"Invalid position {position!r}. Choose from: {list(POSITIONS)}")

    if shutil.which("ffmpeg") is None:
        raise RuntimeError(
            "ffmpeg is not on PATH. Install ffmpeg and make sure it is accessible."
        )

    overlay_expr = POSITIONS[position]
    # Scale logo to logo_scale fraction of the video width, keep aspect ratio.
    scale_filter = f"[1:v]scale=iw*{logo_scale}:-1[logo]"
    filter_complex = f"{scale_filter};[0:v][logo]overlay={overlay_expr}"

    tmp_path = video_path.with_suffix(".logo_tmp" + video_path.suffix)

    if progress_cb:
        progress_cb(5.0, "Starting ffmpeg…")

    cmd = [
        "ffmpeg", "-y",
        "-i", str(video_path),
        "-i", str(LOGO_PATH),
        "-filter_complex", filter_complex,
        "-codec:a", "copy",
        "-preset", "fast",
        str(tmp_path),
    ]

    proc = subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    if proc.returncode != 0:
        err = proc.stderr.decode(errors="replace")
        raise RuntimeError(f"ffmpeg failed:\n{err[-800:]}")

    if progress_cb:
        progress_cb(95.0, "Replacing original…")

    tmp_path.replace(video_path)

    if progress_cb:
        progress_cb(100.0, f"Done → {video_path.name}")

    return video_path
