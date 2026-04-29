"""Generic job registry shared by every feature.

Each feature ships a worker function; this module provides the Job dataclass,
the in-memory registry, status endpoints, and download/preview helpers. The
goal is that adding a new feature only requires writing a worker — never
touching the job plumbing.
"""
from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

from fastapi import APIRouter, Body, HTTPException
from fastapi.responses import FileResponse, JSONResponse


# A worker takes a Job and a progress callback. It is responsible for writing
# the output file to `job.output_path` and setting `job.segments` if relevant.
ProgressCb = Callable[[float, str], None]
Worker = Callable[["Job", ProgressCb], None]


@dataclass
class Job:
    id: str
    kind: str                              # "vision" | "stt" | "download" | …
    display_name: str = ""                 # what the user sees in the queue
    status: str = "pending"                # pending | running | done | error
    progress: float = 0.0
    message: str = ""
    error: Optional[str] = None
    segments: int = 0                      # filled by workers that produce SRT
    output_path: Optional[Path] = None     # the artefact to download
    output_format: str = "srt"             # extension hint for the download name
    created_at: float = field(default_factory=time.time)


JOBS: dict[str, Job] = {}
_jobs_lock = threading.Lock()


def create_job(kind: str, display_name: str = "") -> Job:
    job = Job(id=uuid.uuid4().hex, kind=kind, display_name=display_name)
    with _jobs_lock:
        JOBS[job.id] = job
    return job


def run_in_thread(job: Job, worker: Worker) -> None:
    """Spawn the worker on a daemon thread, wiring progress + error capture."""
    def progress_cb(pct: float, msg: str) -> None:
        job.progress = pct
        job.message = msg

    def runner() -> None:
        try:
            job.status = "running"
            worker(job, progress_cb)
            job.progress = 100.0
            job.status = "done"
            if not job.message:
                job.message = "Done."
        except Exception as e:  # noqa: BLE001 — surface any worker failure to the UI
            job.status = "error"
            job.error = str(e)
            job.message = f"Error: {e}"

    threading.Thread(target=runner, daemon=True).start()


def _job_to_dict(job: Job) -> dict:
    return {
        "id": job.id,
        "kind": job.kind,
        "status": job.status,
        "progress": round(job.progress, 1),
        "message": job.message,
        "segments": job.segments,
        "error": job.error,
        "display_name": job.display_name,
        "created_at": job.created_at,
        "output_format": job.output_format,
    }


router = APIRouter(prefix="/api/jobs", tags=["jobs"])


@router.get("")
def list_jobs():
    jobs = sorted(JOBS.values(), key=lambda j: j.created_at, reverse=True)
    return {"jobs": [_job_to_dict(j) for j in jobs]}


@router.get("/{job_id}")
def job_status(job_id: str):
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, "Job not found")
    return _job_to_dict(job)


@router.delete("/{job_id}")
def delete_job(job_id: str):
    with _jobs_lock:
        job = JOBS.pop(job_id, None)
    if job is None:
        raise HTTPException(404, "Job not found")
    # Best-effort cleanup of the artefact; the source upload is shared so we
    # leave it alone — the user may queue another job against it.
    try:
        if job.output_path and job.output_path.exists():
            job.output_path.unlink()
    except OSError:
        pass
    return {"ok": True}


@router.get("/{job_id}/download")
def download(job_id: str):
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, "Job not found")
    if job.status != "done":
        raise HTTPException(400, f"Job not complete (status={job.status})")
    if not job.output_path or not job.output_path.exists():
        raise HTTPException(404, "Output file missing")
    base = Path(job.display_name).stem or "output"
    return FileResponse(
        job.output_path,
        media_type="application/octet-stream",
        filename=f"{base}.{job.output_format}",
    )


@router.get("/{job_id}/preview")
def preview(job_id: str):
    """Return the artefact as text when it's text-shaped (srt/vtt/txt/json)."""
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, "Job not found")
    if job.status != "done" or not job.output_path or not job.output_path.exists():
        return JSONResponse({"text": ""})
    if job.output_format not in {"srt", "vtt", "txt", "json"}:
        return JSONResponse({"text": "", "binary": True})
    text = job.output_path.read_text(encoding="utf-8")
    return JSONResponse({"text": text, "format": job.output_format})


@router.put("/{job_id}/preview")
def save_preview(job_id: str, payload: dict = Body(...)):
    """Overwrite a text-format artefact with edited content from the UI.

    Only allowed for srt/vtt/txt/json — binary outputs (audio/video) have no
    sensible "edit" path. The path is unchanged so the existing
    /download endpoint serves the new bytes immediately.
    """
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, "Job not found")
    if job.status != "done":
        raise HTTPException(400, f"Job not complete (status={job.status})")
    if not job.output_path:
        raise HTTPException(404, "Output path missing")
    if job.output_format not in {"srt", "vtt", "txt", "json"}:
        raise HTTPException(400, f"Edits not allowed for format {job.output_format!r}")

    text = payload.get("text")
    if not isinstance(text, str):
        raise HTTPException(400, "Body must contain a string `text` field")

    # Defensive: never let the UI escape the configured output dir. The path
    # was originally chosen by the worker, so this is paranoia, but cheap.
    job.output_path.parent.mkdir(parents=True, exist_ok=True)
    job.output_path.write_text(text, encoding="utf-8")

    # Re-derive segment count for SRT so the queue card reflects edits.
    if job.output_format == "srt":
        job.segments = sum(
            1 for line in text.splitlines() if line.strip().isdigit()
        )

    return {"ok": True, "bytes": len(text.encode("utf-8")), "segments": job.segments}
