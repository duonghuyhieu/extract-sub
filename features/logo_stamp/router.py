"""HTTP endpoints for the logo-stamp feature."""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Body, HTTPException
from fastapi.responses import FileResponse

from core.config import BASE_DIR
from core.jobs import Job, ProgressCb, create_job, run_in_thread

from .processor import POSITIONS, find_videos, stamp

router = APIRouter(prefix="/api/logo-stamp", tags=["logo_stamp"])

LOGO_PATH = BASE_DIR / "assets" / "logo.png"


@router.get("/logo")
def serve_logo():
    if not LOGO_PATH.exists():
        raise HTTPException(404, "Logo file not found")
    return FileResponse(LOGO_PATH, media_type="image/png")


@router.get("/positions")
def get_positions():
    return {"positions": list(POSITIONS.keys())}


@router.post("/list-videos")
def list_videos(payload: dict = Body(...)):
    folder = (payload.get("folder") or "").strip()
    if not folder:
        raise HTTPException(400, "folder is required")
    p = Path(folder)
    if not p.is_dir():
        raise HTTPException(400, f"Not a directory: {folder}")
    videos = find_videos(p)
    return {
        "videos": [{"name": v.name, "path": str(v)} for v in videos],
        "count": len(videos),
    }


@router.post("/stamp")
def start_stamp(payload: dict = Body(...)):
    """Stamp logo onto one or more videos. Each video is a separate job."""
    paths = payload.get("paths") or []
    position = (payload.get("position") or "bottom-right").strip()
    logo_scale = float(payload.get("logo_scale") or 0.15)

    if not paths:
        raise HTTPException(400, "paths must be a non-empty list")
    if position not in POSITIONS:
        raise HTTPException(400, f"Invalid position. Choose from: {list(POSITIONS)}")
    if not (0.02 <= logo_scale <= 0.8):
        raise HTTPException(400, "logo_scale must be between 0.02 and 0.8")

    job_ids: list[str] = []
    for path_str in paths:
        video_path = Path(path_str)
        if not video_path.exists():
            continue

        job = create_job(kind="logo-stamp", display_name=video_path.name)

        def make_worker(vp: Path, pos: str, scale: float):
            def worker(job: Job, progress: ProgressCb) -> None:
                progress(0.0, "Queued…")
                stamp(vp, pos, logo_scale=scale, progress_cb=progress)
                job.message = f"Done → {vp.name}"
            return worker

        run_in_thread(job, make_worker(video_path, position, logo_scale))
        job_ids.append(job.id)

    return {"job_ids": job_ids, "count": len(job_ids)}
