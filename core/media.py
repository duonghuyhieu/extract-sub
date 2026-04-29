"""Upload + serve endpoints shared by every feature that consumes media."""
from __future__ import annotations

import shutil
import uuid
from pathlib import Path

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse

from core.config import MEDIA_EXTS, UPLOAD_DIR

router = APIRouter(prefix="/api", tags=["media"])


@router.get("/capabilities")
def capabilities():
    """Report which acceleration backends are usable so the UI can offer the
    right device toggles without guessing."""
    from features.vision_ocr.processor import is_directml_available
    from features.speech_to_text.processor import is_cuda_available

    return {
        "directml": is_directml_available(),
        "cuda": is_cuda_available(),
    }


@router.post("/upload")
async def upload_media(file: UploadFile = File(...)):
    if not file.filename:
        raise HTTPException(400, "No filename")
    suffix = Path(file.filename).suffix.lower()
    if suffix not in MEDIA_EXTS:
        raise HTTPException(400, f"Unsupported format: {suffix}")

    media_id = uuid.uuid4().hex
    dest = UPLOAD_DIR / f"{media_id}{suffix}"
    with dest.open("wb") as f:
        shutil.copyfileobj(file.file, f)

    return {
        "media_id": media_id,
        "filename": dest.name,
        "original_name": file.filename,
        "size": dest.stat().st_size,
        "kind": "video" if suffix in {".mp4", ".mkv", ".mov", ".avi", ".webm",
                                       ".flv", ".m4v", ".ts"} else "audio",
    }


@router.get("/media/{filename}")
def serve_media(filename: str):
    path = UPLOAD_DIR / filename
    if not path.exists() or not path.is_file():
        raise HTTPException(404, "Not found")
    if UPLOAD_DIR.resolve() not in path.resolve().parents:
        raise HTTPException(403, "Forbidden")
    return FileResponse(path)
