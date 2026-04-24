"""FastAPI server for the local subtitle extractor."""
from __future__ import annotations

import shutil
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from processor import Box, SubtitleExtractor, is_directml_available, SUPPORTED_LANGUAGES

BASE_DIR = Path(__file__).parent
UPLOAD_DIR = BASE_DIR / "uploads"
OUTPUT_DIR = BASE_DIR / "outputs"
STATIC_DIR = BASE_DIR / "static"
UPLOAD_DIR.mkdir(exist_ok=True)
OUTPUT_DIR.mkdir(exist_ok=True)

app = FastAPI(title="Local Subtitle Extractor")


@dataclass
class Job:
    id: str
    video_path: Path
    srt_path: Path
    display_name: str = ""           # original filename the user uploaded
    status: str = "pending"          # pending | running | done | error
    progress: float = 0.0
    message: str = ""
    error: Optional[str] = None
    segments: int = 0
    created_at: float = field(default_factory=time.time)


JOBS: dict[str, Job] = {}
_extractor_lock = threading.Lock()
_extractors: dict[str, SubtitleExtractor] = {}


def get_extractor(language: str, model_variant: str, device: str) -> SubtitleExtractor:
    """Lazy cache — OCR model load is expensive, reuse per (variant, device)."""
    key = f"{language}:{model_variant}:{device}"
    with _extractor_lock:
        ext = _extractors.get(key)
        if ext is None:
            ext = SubtitleExtractor(
                language=language,
                model_variant=model_variant,
                device=device,
            )
            _extractors[key] = ext
        return ext


@app.get("/api/capabilities")
def capabilities():
    """Report which execution providers/engines the backend supports, so the
    UI can show the correct device options without guessing."""
    return {
        "directml": is_directml_available(),
    }


@app.post("/api/upload")
async def upload_video(file: UploadFile = File(...)):
    if not file.filename:
        raise HTTPException(400, "No filename")
    suffix = Path(file.filename).suffix.lower()
    if suffix not in {".mp4", ".mkv", ".mov", ".avi", ".webm", ".flv", ".m4v", ".ts"}:
        raise HTTPException(400, f"Unsupported video format: {suffix}")

    video_id = uuid.uuid4().hex
    dest = UPLOAD_DIR / f"{video_id}{suffix}"
    with dest.open("wb") as f:
        shutil.copyfileobj(file.file, f)

    return {
        "video_id": video_id,
        "filename": dest.name,
        "original_name": file.filename,
        "size": dest.stat().st_size,
    }


@app.get("/api/video/{filename}")
def serve_video(filename: str):
    path = UPLOAD_DIR / filename
    if not path.exists() or not path.is_file():
        raise HTTPException(404, "Not found")
    # Resolve safety: ensure path stays inside UPLOAD_DIR
    if UPLOAD_DIR.resolve() not in path.resolve().parents:
        raise HTTPException(403, "Forbidden")
    return FileResponse(path)


def _run_job(
    job: Job,
    box: Box,
    language: str,
    model_variant: str,
    device: str,
    sample_fps: float,
):
    def progress(pct: float, msg: str):
        job.progress = pct
        job.message = msg

    try:
        job.status = "running"
        job.message = f"Loading OCR model ({model_variant} / {device})..."
        extractor = get_extractor(language, model_variant, device)
        segments = extractor.extract(
            video_path=job.video_path,
            box=box,
            output_srt=job.srt_path,
            sample_fps=sample_fps,
            progress_cb=progress,
        )
        job.segments = len(segments)
        job.progress = 100.0
        job.status = "done"
        job.message = f"Extracted {len(segments)} subtitle segments."
    except Exception as e:  # noqa: BLE001
        job.status = "error"
        job.error = str(e)
        job.message = f"Error: {e}"


@app.post("/api/extract")
async def start_extraction(
    filename: str = Form(...),
    x: float = Form(...),
    y: float = Form(...),
    w: float = Form(...),
    h: float = Form(...),
    language: str = Form("ch"),
    model_variant: str = Form("server"),
    device: str = Form("cpu"),
    sample_fps: float = Form(2.0),
    display_name: str = Form(""),
):
    if language not in SUPPORTED_LANGUAGES:
        raise HTTPException(400, f"Unsupported language {language!r}")
    if model_variant not in {"server", "mobile"}:
        raise HTTPException(400, "model_variant must be 'server' or 'mobile'")
    if device not in {"cpu", "directml"}:
        raise HTTPException(400, "device must be 'cpu' or 'directml'")
    if device == "directml" and not is_directml_available():
        raise HTTPException(
            400,
            "DirectML not available. Install with: uv sync --extra gpu-directml",
        )
    video_path = UPLOAD_DIR / filename
    if not video_path.exists():
        raise HTTPException(404, "Video not found — please re-upload.")

    if not (0 <= x <= 1 and 0 <= y <= 1 and 0 < w <= 1 and 0 < h <= 1):
        raise HTTPException(400, "Invalid region — must be normalized 0..1")

    job_id = uuid.uuid4().hex
    srt_path = OUTPUT_DIR / f"{job_id}.srt"
    job = Job(
        id=job_id,
        video_path=video_path,
        srt_path=srt_path,
        display_name=display_name or video_path.name,
    )
    JOBS[job_id] = job

    box = Box(x=x, y=y, w=w, h=h)
    t = threading.Thread(
        target=_run_job,
        args=(job, box, language, model_variant, device, sample_fps),
        daemon=True,
    )
    t.start()

    return {"job_id": job_id}


def _job_to_dict(job: Job) -> dict:
    return {
        "id": job.id,
        "status": job.status,
        "progress": round(job.progress, 1),
        "message": job.message,
        "segments": job.segments,
        "error": job.error,
        "display_name": job.display_name,
        "created_at": job.created_at,
    }


@app.get("/api/jobs")
def list_jobs():
    # Newest first — most recent actions on top in the UI.
    jobs = sorted(JOBS.values(), key=lambda j: j.created_at, reverse=True)
    return {"jobs": [_job_to_dict(j) for j in jobs]}


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str):
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, "Job not found")
    return _job_to_dict(job)


@app.delete("/api/jobs/{job_id}")
def delete_job(job_id: str):
    job = JOBS.pop(job_id, None)
    if job is None:
        raise HTTPException(404, "Job not found")
    # Best-effort cleanup of output file; keep the uploaded video in case
    # the user wants to re-process it (it's shared across jobs anyway).
    try:
        if job.srt_path.exists():
            job.srt_path.unlink()
    except OSError:
        pass
    return {"ok": True}


@app.get("/api/jobs/{job_id}/download")
def download_srt(job_id: str):
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, "Job not found")
    if job.status != "done":
        raise HTTPException(400, f"Job not complete (status={job.status})")
    if not job.srt_path.exists():
        raise HTTPException(404, "SRT file missing")
    # Name the download after the original uploaded video when we have it;
    # fall back to the server-side filename otherwise.
    base = Path(job.display_name or job.video_path.name).stem or "subtitles"
    return FileResponse(
        job.srt_path,
        media_type="text/plain",
        filename=f"{base}.srt",
    )


@app.get("/api/jobs/{job_id}/preview")
def preview_srt(job_id: str):
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, "Job not found")
    if job.status != "done" or not job.srt_path.exists():
        return JSONResponse({"text": ""})
    text = job.srt_path.read_text(encoding="utf-8")
    return JSONResponse({"text": text})


# Static frontend — mounted last so API routes take precedence
app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="127.0.0.1", port=8000, reload=False)
