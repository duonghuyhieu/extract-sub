"""Speech-to-text pipeline backed by faster-whisper.

faster-whisper wraps OpenAI Whisper with CTranslate2, giving 3-5x speedup
over the reference implementation while keeping the same accuracy. PyAV is
bundled, so the engine accepts video containers directly — no separate
ffmpeg extraction step.
"""
from __future__ import annotations

import json
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional


# -----------------------------------------------------------------------
# Models + languages exposed to the UI
# -----------------------------------------------------------------------

# Models we surface in the dropdown. `large-v3-turbo` is a distilled v3 that
# runs ~4x faster with negligible quality loss — great default for non-CJK.
WHISPER_MODELS: tuple[str, ...] = (
    "tiny",
    "base",
    "small",
    "medium",
    "large-v3",
    "large-v3-turbo",
)

# Whisper supports ~99 languages; this is the curated subset we expose plus
# "auto" for autodetect. The tuple is (code, label).
WHISPER_LANGUAGES: tuple[tuple[str, str], ...] = (
    ("auto",  "Auto-detect"),
    ("en",    "English"),
    ("vi",    "Vietnamese (Tiếng Việt)"),
    ("zh",    "Chinese (中文)"),
    ("ja",    "Japanese (日本語)"),
    ("ko",    "Korean (한국어)"),
    ("fr",    "French (Français)"),
    ("de",    "German (Deutsch)"),
    ("es",    "Spanish (Español)"),
    ("it",    "Italian (Italiano)"),
    ("pt",    "Portuguese"),
    ("ru",    "Russian (Русский)"),
    ("ar",    "Arabic (العربية)"),
    ("hi",    "Hindi (हिन्दी)"),
    ("th",    "Thai (ไทย)"),
    ("id",    "Indonesian"),
    ("tr",    "Turkish (Türkçe)"),
    ("nl",    "Dutch"),
    ("pl",    "Polish"),
    ("uk",    "Ukrainian"),
)
SUPPORTED_LANGUAGES: tuple[str, ...] = tuple(c for c, _ in WHISPER_LANGUAGES)

OUTPUT_FORMATS: tuple[str, ...] = ("srt", "vtt", "txt", "json")
TASKS: tuple[str, ...] = ("transcribe", "translate")


# -----------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------

def is_cuda_available() -> bool:
    """Whether CTranslate2 can run Whisper on CUDA. Detection is lazy because
    importing faster_whisper pulls in heavy native libs."""
    try:
        import ctranslate2
    except ImportError:
        return False
    try:
        return ctranslate2.get_cuda_device_count() > 0
    except Exception:  # noqa: BLE001 — ctranslate2 may raise on systems without CUDA runtime
        return False


def _format_ts_srt(seconds: float) -> str:
    if seconds < 0:
        seconds = 0
    ms = int(round(seconds * 1000))
    h, rem = divmod(ms, 3_600_000)
    m, rem = divmod(rem, 60_000)
    s, ms = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _format_ts_vtt(seconds: float) -> str:
    return _format_ts_srt(seconds).replace(",", ".")


# -----------------------------------------------------------------------
# Transcript dataclass — the format-agnostic intermediate representation
# -----------------------------------------------------------------------

@dataclass
class TranscriptSegment:
    start: float
    end: float
    text: str
    words: Optional[list[dict]] = None     # only filled when word timestamps on


@dataclass
class Transcript:
    language: str
    language_probability: float
    duration: float
    segments: list[TranscriptSegment]


# -----------------------------------------------------------------------
# Engine cache
# -----------------------------------------------------------------------

_engine_lock = threading.Lock()
_engines: dict[str, "WhisperEngine"] = {}


def get_engine(model: str, device: str, compute_type: str) -> "WhisperEngine":
    """Cache one WhisperModel per (model, device, compute_type) tuple — first
    load downloads weights and takes a while; subsequent calls are instant."""
    key = f"{model}:{device}:{compute_type}"
    with _engine_lock:
        eng = _engines.get(key)
        if eng is None:
            eng = WhisperEngine(model=model, device=device, compute_type=compute_type)
            _engines[key] = eng
        return eng


# -----------------------------------------------------------------------
# WhisperEngine
# -----------------------------------------------------------------------

class WhisperEngine:
    def __init__(
        self,
        model: str = "large-v3-turbo",
        device: str = "auto",
        compute_type: str = "auto",
    ):
        """
        model: any key in WHISPER_MODELS
        device: 'cpu' | 'cuda' | 'auto'
        compute_type: 'int8' | 'int8_float16' | 'float16' | 'float32' | 'auto'
            'auto' picks int8 on CPU and float16 on CUDA.
        """
        from faster_whisper import WhisperModel

        if model not in WHISPER_MODELS:
            raise ValueError(
                f"Unsupported model {model!r}. Valid: {', '.join(WHISPER_MODELS)}"
            )

        if device == "auto":
            device = "cuda" if is_cuda_available() else "cpu"
        if device == "cuda" and not is_cuda_available():
            raise RuntimeError(
                "CUDA not available. Install with: uv sync --extra gpu-cuda "
                "(requires NVIDIA GPU + cuDNN). Falling back: pick CPU."
            )

        if compute_type == "auto":
            compute_type = "float16" if device == "cuda" else "int8"

        self.model_name = model
        self.device = device
        self.compute_type = compute_type

        self.model = WhisperModel(
            model,
            device=device,
            compute_type=compute_type,
        )
        # WhisperModel internally serializes inference, but a process-level
        # lock guards us against concurrent jobs stepping on each other.
        self._lock = threading.Lock()

    def transcribe(
        self,
        media_path: Path,
        *,
        language: str = "auto",
        task: str = "transcribe",
        vad_filter: bool = True,
        word_timestamps: bool = False,
        beam_size: int = 5,
        initial_prompt: Optional[str] = None,
        progress_cb: Optional[Callable[[float, str], None]] = None,
    ) -> Transcript:
        if task not in TASKS:
            raise ValueError(f"task must be one of {TASKS}")

        lang_arg = None if language == "auto" else language

        if progress_cb:
            progress_cb(2.0, f"Loading {self.model_name} on {self.device}…")

        with self._lock:
            segments_iter, info = self.model.transcribe(
                str(media_path),
                language=lang_arg,
                task=task,
                vad_filter=vad_filter,
                word_timestamps=word_timestamps,
                beam_size=beam_size,
                initial_prompt=initial_prompt or None,
            )

            duration = float(info.duration) if info.duration else 0.0
            if progress_cb:
                detected = info.language or lang_arg or "?"
                progress_cb(
                    5.0,
                    f"Detected language: {detected} "
                    f"({float(info.language_probability or 0):.0%}) — transcribing…",
                )

            collected: list[TranscriptSegment] = []
            for seg in segments_iter:
                collected.append(
                    TranscriptSegment(
                        start=float(seg.start),
                        end=float(seg.end),
                        text=(seg.text or "").strip(),
                        words=(
                            [
                                {"start": float(w.start), "end": float(w.end),
                                 "word": w.word, "prob": float(w.probability)}
                                for w in (seg.words or [])
                            ]
                            if word_timestamps else None
                        ),
                    )
                )
                if progress_cb and duration > 0:
                    pct = min(99.0, 5.0 + (seg.end / duration) * 94.0)
                    progress_cb(pct, f"{len(collected)} segments · {seg.end:.0f}s / {duration:.0f}s")

        return Transcript(
            language=info.language or (lang_arg or "?"),
            language_probability=float(info.language_probability or 0.0),
            duration=duration,
            segments=collected,
        )


# -----------------------------------------------------------------------
# Output writers
# -----------------------------------------------------------------------

def write_transcript(transcript: Transcript, path: Path, fmt: str) -> None:
    if fmt not in OUTPUT_FORMATS:
        raise ValueError(f"Unsupported output format: {fmt}")
    path.parent.mkdir(parents=True, exist_ok=True)
    writer = {
        "srt": _write_srt,
        "vtt": _write_vtt,
        "txt": _write_txt,
        "json": _write_json,
    }[fmt]
    writer(transcript, path)


def _write_srt(t: Transcript, path: Path) -> None:
    with path.open("w", encoding="utf-8") as f:
        for i, seg in enumerate(t.segments, 1):
            f.write(f"{i}\n")
            f.write(f"{_format_ts_srt(seg.start)} --> {_format_ts_srt(seg.end)}\n")
            f.write(f"{seg.text}\n\n")


def _write_vtt(t: Transcript, path: Path) -> None:
    with path.open("w", encoding="utf-8") as f:
        f.write("WEBVTT\n\n")
        for seg in t.segments:
            f.write(f"{_format_ts_vtt(seg.start)} --> {_format_ts_vtt(seg.end)}\n")
            f.write(f"{seg.text}\n\n")


def _write_txt(t: Transcript, path: Path) -> None:
    with path.open("w", encoding="utf-8") as f:
        f.write("\n".join(seg.text for seg in t.segments) + "\n")


def _write_json(t: Transcript, path: Path) -> None:
    payload = {
        "language": t.language,
        "language_probability": t.language_probability,
        "duration": t.duration,
        "segments": [
            {
                "start": seg.start,
                "end": seg.end,
                "text": seg.text,
                **({"words": seg.words} if seg.words is not None else {}),
            }
            for seg in t.segments
        ],
    }
    with path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
