"""HTTP endpoints for the vision-OCR feature."""
from __future__ import annotations

import threading

from fastapi import APIRouter, Form, HTTPException

from core.config import OUTPUT_DIR, UPLOAD_DIR
from core.jobs import Job, ProgressCb, create_job, run_in_thread

from .processor import (
    SUPPORTED_LANGUAGES,
    Box,
    SubtitleExtractor,
    is_directml_available,
)


router = APIRouter(prefix="/api/vision", tags=["vision_ocr"])


# OCR model loads are expensive (hundreds of MB, ~10s on first call). Reuse
# the engine across jobs that share the same (language, variant, device).
_extractor_lock = threading.Lock()
_extractors: dict[str, SubtitleExtractor] = {}


def _get_extractor(language: str, model_variant: str, device: str) -> SubtitleExtractor:
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


@router.post("/extract")
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

    job = create_job(kind="vision", display_name=display_name or video_path.name)
    job.output_path = OUTPUT_DIR / f"{job.id}.srt"
    job.output_format = "srt"

    box = Box(x=x, y=y, w=w, h=h)

    def worker(job: Job, progress: ProgressCb) -> None:
        progress(0.0, f"Loading OCR model ({model_variant} / {device})…")
        extractor = _get_extractor(language, model_variant, device)
        segments = extractor.extract(
            video_path=video_path,
            box=box,
            output_srt=job.output_path,
            sample_fps=sample_fps,
            progress_cb=progress,
        )
        job.segments = len(segments)
        job.message = f"Extracted {len(segments)} subtitle segments."

    run_in_thread(job, worker)
    return {"job_id": job.id}
