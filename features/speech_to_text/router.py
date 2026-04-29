"""HTTP endpoints for the speech-to-text feature."""
from __future__ import annotations

from fastapi import APIRouter, Form, HTTPException

from core.config import OUTPUT_DIR, UPLOAD_DIR
from core.jobs import Job, ProgressCb, create_job, run_in_thread

from .processor import (
    OUTPUT_FORMATS,
    SUPPORTED_LANGUAGES,
    TASKS,
    WHISPER_LANGUAGES,
    WHISPER_MODELS,
    get_engine,
    is_cuda_available,
    write_transcript,
)


router = APIRouter(prefix="/api/stt", tags=["speech_to_text"])


@router.get("/options")
def options():
    """Expose the model/language/format catalogue so the frontend stays in
    sync without hard-coding the same lists in two places."""
    return {
        "models": list(WHISPER_MODELS),
        "languages": [{"code": c, "label": l} for c, l in WHISPER_LANGUAGES],
        "formats": list(OUTPUT_FORMATS),
        "tasks": list(TASKS),
        "cuda": is_cuda_available(),
    }


@router.post("/transcribe")
async def start_transcription(
    filename: str = Form(...),
    model: str = Form("large-v3-turbo"),
    language: str = Form("auto"),
    task: str = Form("transcribe"),
    device: str = Form("auto"),         # cpu | cuda | auto
    compute_type: str = Form("auto"),   # int8 | int8_float16 | float16 | float32 | auto
    output_format: str = Form("srt"),
    vad_filter: bool = Form(True),
    word_timestamps: bool = Form(False),
    beam_size: int = Form(5),
    initial_prompt: str = Form(""),
    display_name: str = Form(""),
):
    if model not in WHISPER_MODELS:
        raise HTTPException(400, f"Unsupported model: {model}")
    if language not in SUPPORTED_LANGUAGES:
        raise HTTPException(400, f"Unsupported language: {language}")
    if task not in TASKS:
        raise HTTPException(400, f"task must be one of {TASKS}")
    if device not in {"cpu", "cuda", "auto"}:
        raise HTTPException(400, "device must be cpu | cuda | auto")
    if device == "cuda" and not is_cuda_available():
        raise HTTPException(
            400,
            "CUDA not available. Install: uv sync --extra gpu-cuda (NVIDIA only).",
        )
    if output_format not in OUTPUT_FORMATS:
        raise HTTPException(400, f"output_format must be one of {OUTPUT_FORMATS}")
    if not (1 <= beam_size <= 10):
        raise HTTPException(400, "beam_size must be between 1 and 10")

    media_path = UPLOAD_DIR / filename
    if not media_path.exists():
        raise HTTPException(404, "Media not found — please re-upload.")

    job = create_job(kind="stt", display_name=display_name or media_path.name)
    job.output_path = OUTPUT_DIR / f"{job.id}.{output_format}"
    job.output_format = output_format

    def worker(job: Job, progress: ProgressCb) -> None:
        progress(0.0, f"Loading {model} ({device}/{compute_type})…")
        engine = get_engine(model=model, device=device, compute_type=compute_type)
        transcript = engine.transcribe(
            media_path=media_path,
            language=language,
            task=task,
            vad_filter=vad_filter,
            word_timestamps=word_timestamps,
            beam_size=beam_size,
            initial_prompt=initial_prompt or None,
            progress_cb=progress,
        )
        write_transcript(transcript, job.output_path, output_format)
        job.segments = len(transcript.segments)
        job.message = (
            f"{len(transcript.segments)} segments · "
            f"detected '{transcript.language}' "
            f"({transcript.language_probability:.0%})"
        )

    run_in_thread(job, worker)
    return {"job_id": job.id}
