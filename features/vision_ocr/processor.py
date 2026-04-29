"""Video subtitle extraction pipeline.

Reads a video, samples frames at a configurable rate, crops each frame to a
user-supplied bounding box, runs OCR over the crop, then collapses consecutive
similar strings into SRT segments.

The pipeline has two phases:

1. Sampling + OCR — produces raw Segment objects by grouping consecutive
   frames whose recognised text is similar.
2. Post-processing — removes garbage/watermark text, merges split sentences
   caused by OCR jitter, and enforces a readable minimum duration.
"""
from __future__ import annotations

import re
import threading
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

import cv2
import numpy as np
from rapidfuzz import fuzz


# ---------------------------------------------------------------------------
# Language routing
# ---------------------------------------------------------------------------

# Every language RapidOCR's PP-OCR family ships a recognition model for, with
# the best version available for each. Detection uses Chinese v5 for CJK-ish
# scripts (works for Latin text too) and the multilingual v3/v4 detector for
# everything else.
_LANG_ROUTING: dict[str, tuple[str, str, str]] = {
    # lang        -> (rec_version, det_lang, det_version)
    "ch":          ("PP-OCRv5", "ch",    "PP-OCRv5"),
    "ch_doc":      ("PP-OCRv4", "ch",    "PP-OCRv5"),
    "chinese_cht": ("PP-OCRv4", "ch",    "PP-OCRv5"),
    "en":          ("PP-OCRv5", "ch",    "PP-OCRv5"),
    "japan":       ("PP-OCRv4", "multi", "PP-OCRv4"),
    "korean":      ("PP-OCRv5", "multi", "PP-OCRv4"),
    "latin":       ("PP-OCRv5", "multi", "PP-OCRv4"),
    "arabic":      ("PP-OCRv5", "multi", "PP-OCRv4"),
    "cyrillic":    ("PP-OCRv5", "multi", "PP-OCRv4"),
    "eslav":       ("PP-OCRv5", "multi", "PP-OCRv4"),
    "devanagari":  ("PP-OCRv5", "multi", "PP-OCRv4"),
    "th":          ("PP-OCRv5", "multi", "PP-OCRv4"),
    "el":          ("PP-OCRv5", "multi", "PP-OCRv4"),
    "ta":          ("PP-OCRv5", "multi", "PP-OCRv4"),
    "te":          ("PP-OCRv5", "multi", "PP-OCRv4"),
    "ka":          ("PP-OCRv4", "multi", "PP-OCRv4"),
}
SUPPORTED_LANGUAGES = tuple(_LANG_ROUTING.keys())

# Only `ch` and `ch_doc` ship a heavier "server" recognition weight. For every
# other language, "server" silently falls back to "mobile".
_SERVER_CAPABLE_LANGS = {"ch", "ch_doc"}


# Per-language script expectation. OCR hits that don't contain at least one
# character in the expected script are almost always background noise
# (component labels, logos, UI chrome). Latin-only languages skip this check.
_SCRIPT_CHECK: dict[str, "re.Pattern[str]"] = {
    "ch":          re.compile(r"[㐀-鿿豈-﫿]"),
    "ch_doc":      re.compile(r"[㐀-鿿豈-﫿]"),
    "chinese_cht": re.compile(r"[㐀-鿿豈-﫿]"),
    "japan":       re.compile(r"[぀-ヿ㐀-鿿･-ﾟ]"),
    "korean":      re.compile(r"[가-힯ᄀ-ᇿ㄰-㆏]"),
    "arabic":      re.compile(r"[؀-ۿݐ-ݿ]"),
    "cyrillic":    re.compile(r"[Ѐ-ӿ]"),
    "eslav":       re.compile(r"[Ѐ-ӿ]"),
    "devanagari":  re.compile(r"[ऀ-ॿ]"),
    "th":          re.compile(r"[฀-๿]"),
    "el":          re.compile(r"[Ͱ-Ͽἀ-῿]"),
    "ta":          re.compile(r"[஀-௿]"),
    "te":          re.compile(r"[ఀ-౿]"),
    "ka":          re.compile(r"[ಀ-೿]"),
}


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class Box:
    """Normalized bbox in [0..1] image coordinates."""
    x: float
    y: float
    w: float
    h: float

    def to_pixels(self, width: int, height: int) -> tuple[int, int, int, int]:
        x1 = max(0, int(self.x * width))
        y1 = max(0, int(self.y * height))
        x2 = min(width, int((self.x + self.w) * width))
        y2 = min(height, int((self.y + self.h) * height))
        return x1, y1, x2, y2


@dataclass
class Segment:
    start: float
    end: float
    text: str
    samples: int = 1
    # (text, confidence_score) per contributing sample — used to pick the
    # representative text when closing the segment.
    all_texts: list[tuple[str, float]] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_WHITESPACE_RE = re.compile(r"\s+")


def _format_timestamp(seconds: float) -> str:
    if seconds < 0:
        seconds = 0
    ms_total = int(round(seconds * 1000))
    hours, rem = divmod(ms_total, 3_600_000)
    minutes, rem = divmod(rem, 60_000)
    secs, millis = divmod(rem, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def _normalize(text: str) -> str:
    return _WHITESPACE_RE.sub(" ", text.strip())


def _looks_like_subtitle(text: str, language: str) -> bool:
    """Reject OCR hits that don't contain any character in the expected
    script. Latin-only languages (en, latin) skip this filter."""
    if not text:
        return False
    pattern = _SCRIPT_CHECK.get(language)
    if pattern is None:
        return True
    return bool(pattern.search(text))


def _alnum_ratio(text: str) -> float:
    """Fraction of characters that are letters or digits (Unicode-aware).
    Low ratios usually indicate OCR garbage like '..--,,' or '!@#$%'."""
    if not text:
        return 0.0
    good = sum(1 for c in text if c.isalnum())
    return good / len(text)


def _similar(a: str, b: str, threshold: int = 80) -> bool:
    if not a or not b:
        return a == b
    if a == b:
        return True
    return fuzz.ratio(a, b) >= threshold


def _mergeable(a: str, b: str, threshold: int = 75) -> bool:
    """Looser check used to merge segments across a small time gap. Uses
    partial_ratio so that 'Hello world' matches 'Hello wor' (OCR cut-off)."""
    if not a or not b:
        return False
    if a == b:
        return True
    return fuzz.partial_ratio(a, b) >= threshold


def _pick_best_text(samples: list[tuple[str, float]]) -> str:
    """Pick the representative text for a segment by summing confidence
    scores per unique text — one high-confidence read beats several
    low-confidence ones."""
    if not samples:
        return ""
    score_sum: dict[str, float] = {}
    for text, score in samples:
        if not text:
            continue
        score_sum[text] = score_sum.get(text, 0.0) + max(0.01, score)
    if not score_sum:
        return ""
    best = sorted(score_sum.items(), key=lambda kv: (-kv[1], -len(kv[0])))[0][0]
    return best


def is_directml_available() -> bool:
    """Check whether onnxruntime can use DirectML (AMD/Intel GPU on Windows)."""
    try:
        import onnxruntime as ort
    except ImportError:
        return False
    return "DmlExecutionProvider" in ort.get_available_providers()


# ---------------------------------------------------------------------------
# Post-processing
# ---------------------------------------------------------------------------

def _postprocess(
    segments: list[Segment],
    *,
    max_merge_gap_ms: int = 500,
    merge_threshold: int = 75,
    min_alnum_ratio: float = 0.45,
    min_text_len: int = 2,
    watermark_min_count: int = 5,
    watermark_min_ratio: float = 0.35,
    min_segment_ms: int = 800,
    max_segment_ms: int = 7000,
) -> list[Segment]:
    """Tidy up raw segments before writing to SRT.

    Filters:
    * watermark/spam — texts that appear in a suspiciously large share of
      segments (e.g. channel logos, banner ads) are removed wholesale.
    * garbage — segments with too-short or too-symbolic text are dropped.

    Merges:
    * split sentences — adjacent segments with very similar text across a
      small gap are joined (handles OCR hiccups where one subtitle becomes
      two timestamps).

    Timing:
    * min duration — extends short segments to ``min_segment_ms`` so the
      viewer has time to read.
    * max duration — clips anything beyond ``max_segment_ms`` (guards
      against one bad frame ballooning a segment).
    """
    if not segments:
        return segments

    # 1. Watermark / spam detection. Any text that appears in a large fraction
    #    of the video is almost always not a real subtitle.
    if len(segments) >= watermark_min_count:
        counts = Counter(s.text for s in segments)
        total = len(segments)
        watermarks = {
            t for t, c in counts.items()
            if c >= watermark_min_count and (c / total) >= watermark_min_ratio
        }
        if watermarks:
            segments = [s for s in segments if s.text not in watermarks]

    # 2. Garbage filter — reject clearly nonsensical segments.
    segments = [
        s for s in segments
        if len(s.text) >= min_text_len and _alnum_ratio(s.text) >= min_alnum_ratio
    ]

    # 3. Merge split sentences.
    merged: list[Segment] = []
    for seg in segments:
        if merged:
            prev = merged[-1]
            gap_ms = (seg.start - prev.end) * 1000
            if gap_ms <= max_merge_gap_ms and _mergeable(prev.text, seg.text, merge_threshold):
                prev.end = seg.end
                prev.samples += seg.samples
                prev.all_texts.extend(seg.all_texts)
                prev.text = _pick_best_text(prev.all_texts)
                continue
        merged.append(seg)

    # 4. Enforce readable duration bounds.
    for seg in merged:
        dur_ms = (seg.end - seg.start) * 1000
        if dur_ms < min_segment_ms:
            seg.end = seg.start + (min_segment_ms / 1000)
        elif dur_ms > max_segment_ms:
            seg.end = seg.start + (max_segment_ms / 1000)

    # 5. Prevent timestamp overlap after extending short ones.
    for i in range(len(merged) - 1):
        if merged[i].end > merged[i + 1].start:
            merged[i].end = merged[i + 1].start

    return merged


# ---------------------------------------------------------------------------
# Main class
# ---------------------------------------------------------------------------

class SubtitleExtractor:
    def __init__(
        self,
        language: str = "ch",
        model_variant: str = "server",
        device: str = "cpu",
    ):
        """
        language: any key in :data:`SUPPORTED_LANGUAGES` — e.g. 'ch',
            'chinese_cht', 'japan', 'korean', 'latin', 'arabic', …
        model_variant: 'server' (best, only for `ch`/`ch_doc`) or 'mobile'.
            Silently downgraded to 'mobile' when the chosen language has no
            server weights available.
        device: 'cpu' (default) or 'directml' for AMD/Intel GPU on Windows.
        """
        from rapidocr import LangDet, LangRec, ModelType, OCRVersion, RapidOCR

        if language not in _LANG_ROUTING:
            raise ValueError(
                f"Unsupported language {language!r}. "
                f"Valid: {', '.join(SUPPORTED_LANGUAGES)}"
            )

        if model_variant == "server" and language not in _SERVER_CAPABLE_LANGS:
            model_variant = "mobile"

        self.language = language
        self.device = device

        rec_version, det_lang, det_version = _LANG_ROUTING[language]
        mt = ModelType.SERVER if model_variant == "server" else ModelType.MOBILE

        params = {
            "Det.model_type":  mt,
            "Det.ocr_version": OCRVersion(det_version),
            "Det.lang_type":   LangDet(det_lang),
            "Rec.model_type":  mt,
            "Rec.ocr_version": OCRVersion(rec_version),
            "Rec.lang_type":   LangRec(language),
        }
        if device == "directml":
            if not is_directml_available():
                raise RuntimeError(
                    "DirectML is not available. Install onnxruntime-directml "
                    "with: `uv sync --extra gpu-directml`"
                )
            params["EngineConfig.onnxruntime.use_dml"] = True
        self.ocr = RapidOCR(params=params)
        # Serialize OCR calls — RapidOCR's inference sessions are safe to
        # reuse but concurrent calls can interleave preprocessing state on
        # the shared engine. A lock keeps multiple parallel extraction jobs
        # from stepping on each other while still letting I/O overlap.
        self._ocr_lock = threading.Lock()

    # ------------------------------------------------------------------
    # Extraction
    # ------------------------------------------------------------------
    def extract(
        self,
        video_path: str | Path,
        box: Box,
        output_srt: str | Path,
        sample_fps: float = 2.0,
        similarity_threshold: int = 80,
        min_segment_ms: int = 250,
        min_confidence: float = 0.55,
        progress_cb: Optional[Callable[[float, str], None]] = None,
    ) -> list[Segment]:
        video_path = Path(video_path)
        output_srt = Path(output_srt)

        cap = cv2.VideoCapture(str(video_path))
        if not cap.isOpened():
            raise RuntimeError(f"Could not open video: {video_path}")

        try:
            fps = cap.get(cv2.CAP_PROP_FPS) or 0
            total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
            width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
            height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

            if fps <= 0 or total_frames <= 0:
                raise RuntimeError("Invalid video metadata (fps/frame count).")

            duration = total_frames / fps
            step = max(1, int(round(fps / max(0.1, sample_fps))))
            sample_period = step / fps          # gap between consecutive samples (s)
            half_period = sample_period / 2     # midpoint correction — see below
            x1, y1, x2, y2 = box.to_pixels(width, height)

            if x2 <= x1 or y2 <= y1:
                raise RuntimeError("Subtitle region is empty.")

            segments: list[Segment] = []
            current: Optional[Segment] = None

            frame_idx = 0
            processed = 0

            while True:
                cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
                ok, frame = cap.read()
                if not ok:
                    break

                ts = frame_idx / fps
                # A sample taken at `ts` could equally represent any moment in
                # the surrounding sample interval, so a subtitle first detected
                # here was almost certainly already on screen *before* `ts`.
                # Bias every segment boundary backward by half a sample period
                # — that centres the timing error on zero instead of leaving
                # subtitles consistently late by up to one full period.
                ts_eff = max(0.0, ts - half_period)

                crop = frame[y1:y2, x1:x2]
                text, score = self._ocr_crop(crop)
                text = _normalize(text)

                if score < min_confidence:
                    text = ""
                if text and not _looks_like_subtitle(text, self.language):
                    text = ""

                if current is None:
                    if text:
                        current = Segment(
                            start=ts_eff, end=ts_eff, text=text,
                            all_texts=[(text, score)],
                        )
                else:
                    if text and _similar(text, current.text, similarity_threshold):
                        current.end = ts_eff
                        current.samples += 1
                        current.all_texts.append((text, score))
                    else:
                        current.end = ts_eff
                        current.text = _pick_best_text(current.all_texts)
                        if (current.end - current.start) * 1000 >= min_segment_ms:
                            segments.append(current)
                        current = Segment(
                            start=ts_eff, end=ts_eff, text=text,
                            all_texts=[(text, score)],
                        ) if text else None

                processed += 1
                if progress_cb and processed % 5 == 0:
                    pct = min(99.0, (frame_idx / total_frames) * 100)
                    progress_cb(
                        pct,
                        f"Frame {frame_idx}/{total_frames} — {len(segments)} segments",
                    )

                frame_idx += step
                if frame_idx >= total_frames:
                    break

            if current is not None:
                current.end = min(duration, current.end + (step / fps))
                current.text = _pick_best_text(current.all_texts)
                if (current.end - current.start) * 1000 >= min_segment_ms:
                    segments.append(current)

        finally:
            cap.release()

        if progress_cb:
            progress_cb(99.5, f"Cleaning up {len(segments)} raw segments...")
        segments = _postprocess(segments)

        self._write_srt(segments, output_srt)
        if progress_cb:
            progress_cb(100.0, f"Done. {len(segments)} segments written.")
        return segments

    # ------------------------------------------------------------------
    # OCR + preprocessing
    # ------------------------------------------------------------------
    def _ocr_crop(self, crop: np.ndarray) -> tuple[str, float]:
        if crop is None or crop.size == 0:
            return "", 0.0

        crop = self._preprocess(crop)
        with self._ocr_lock:
            result = self.ocr(crop)

        txts = getattr(result, "txts", None)
        scores = getattr(result, "scores", None) or []
        if not txts:
            return "", 0.0

        parts = [t for t in txts if t]
        if not parts:
            return "", 0.0
        joined = " ".join(parts)
        avg_score = float(sum(scores) / len(scores)) if scores else 0.0
        return joined, avg_score

    @staticmethod
    def _preprocess(crop: np.ndarray) -> np.ndarray:
        """Upscale small crops and normalize local contrast (CLAHE) so OCR
        has a cleaner signal."""
        h, w = crop.shape[:2]
        target_h = 96
        if h < target_h:
            scale = target_h / h
            crop = cv2.resize(
                crop, (int(w * scale), target_h),
                interpolation=cv2.INTER_CUBIC,
            )
        try:
            lab = cv2.cvtColor(crop, cv2.COLOR_BGR2LAB)
            l, a, b = cv2.split(lab)
            clahe = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(8, 8))
            l = clahe.apply(l)
            lab = cv2.merge((l, a, b))
            crop = cv2.cvtColor(lab, cv2.COLOR_LAB2BGR)
        except cv2.error:
            pass
        return crop

    # ------------------------------------------------------------------
    # Output
    # ------------------------------------------------------------------
    @staticmethod
    def _write_srt(segments: list[Segment], path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("w", encoding="utf-8") as f:
            for i, seg in enumerate(segments, 1):
                f.write(f"{i}\n")
                f.write(f"{_format_timestamp(seg.start)} --> {_format_timestamp(seg.end)}\n")
                f.write(f"{seg.text}\n\n")
