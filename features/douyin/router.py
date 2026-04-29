"""HTTP endpoints for the Douyin scraper feature."""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Body, HTTPException

from core.jobs import Job, ProgressCb, create_job, run_in_thread
from features.downloader import settings as dl_settings

from . import auto_fetch as af
from .processor import (
    build_filename,
    download_url,
    get_url,
    set_concurrency,
)


router = APIRouter(prefix="/api/douyin", tags=["douyin"])


# ---------- Capabilities ----------

@router.get("/capabilities")
def capabilities():
    """Tell the UI whether auto-fetch is on the table."""
    return {"playwright": af.is_available()}


# ---------- Auto-fetch (Playwright) ----------

@router.post("/auto-fetch")
def auto_fetch(payload: dict = Body(...)):
    """Spawn a job that opens Chromium → runs the fetch script → writes the
    resulting JSON to disk. The frontend polls the standard job endpoints
    and grabs the file via /api/jobs/<id>/preview when status=done."""
    user_url = (payload.get("user_url") or "").strip()
    if not user_url:
        raise HTTPException(400, "user_url is required")
    if "/user/" not in user_url:
        raise HTTPException(400, "user_url must be a Douyin /user/ profile URL")
    if not af.is_available():
        raise HTTPException(
            501,
            "Playwright is not installed. Run `pip install playwright` then "
            "`playwright install chromium`.",
        )

    job = create_job(kind="douyin-fetch", display_name=f"[Douyin] auto-fetch {user_url}")
    job.output_format = "json"

    def worker(job: Job, progress: ProgressCb) -> None:
        progress(0.0, "Queued…")
        videos = af.auto_fetch(user_url, progress_cb=progress)
        path = af.write_result_file(job.id, videos)
        job.output_path = path
        job.message = f"{len(videos)} videos"

    run_in_thread(job, worker)
    return {"job_id": job.id}


@router.post("/start")
def start_downloads(payload: dict = Body(...)):
    """Spawn one job per video. ``items`` is the userscript JSON shape:
    list of dicts with at least ``id``, ``title``, ``videoUrl``, optionally
    ``audioUrl`` and ``createTime``. ``kind`` is ``"video"`` (default) or
    ``"audio"``."""
    items = payload.get("items") or []
    if not items:
        raise HTTPException(400, "items must be a non-empty list")

    kind = payload.get("kind") or "video"
    if kind not in {"video", "audio"}:
        raise HTTPException(400, "kind must be 'video' or 'audio'")

    cur = dl_settings.load()
    set_concurrency(cur.get("concurrent_downloads", 3))

    output_dir = Path(payload.get("download_path") or cur["download_path"]).expanduser()
    # Drop everything into a `douyin/` subfolder so it doesn't mix with
    # YouTube downloads.
    output_dir = output_dir / "douyin"
    output_dir.mkdir(parents=True, exist_ok=True)

    job_ids: list[str] = []
    skipped: list[dict] = []

    for item in items:
        url = get_url(item, kind)
        if not url:
            skipped.append({"id": item.get("id"), "reason": f"no {kind} URL"})
            continue

        title = item.get("title") or item.get("desc") or item.get("id") or "douyin_video"
        target = build_filename(item, kind, output_dir)

        job = create_job(kind="download", display_name=f"[Douyin] {title}")
        job.output_format = "video" if kind == "video" else "audio"

        def make_worker(url: str, target: Path):
            def worker(job: Job, progress: ProgressCb) -> None:
                progress(0.0, "Queued…")
                final = download_url(url, target, progress_cb=progress)
                job.output_path = final
                job.message = f"Saved → {final}"
            return worker

        run_in_thread(job, make_worker(url, target))
        job_ids.append(job.id)

    return {
        "job_ids": job_ids,
        "count": len(job_ids),
        "skipped": skipped,
        "output_dir": str(output_dir),
    }
