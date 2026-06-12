"""Video processing: sample frames, detect, draw, and summarize."""
from __future__ import annotations

import logging
import tempfile
from pathlib import Path
from typing import TYPE_CHECKING, Any

import cv2

from .config import Config
from .detection import Detection, DetectionResult
from .render import draw_detections

if TYPE_CHECKING:  # avoid importing the heavy ensemble for type checking only
    from .pipeline import EnsembleRunner, Logger

log = logging.getLogger("critterwatch.video")


def _summarize(summary: dict[str, dict[str, Any]], dets: list[Detection], t_seconds: float) -> None:
    """Fold one sampled frame's detections into the running per-species summary."""
    for d in dets:
        entry = summary.setdefault(d.label, {
            "label": d.label,
            "category": d.category,
            "on_target_list": d.on_target_list,
            "max_confidence": 0.0,
            "first_seen_s": t_seconds,
            "last_seen_s": t_seconds,
            "frames_seen": 0,
        })
        entry["max_confidence"] = max(entry["max_confidence"], round(d.confidence, 4))
        entry["first_seen_s"] = min(entry["first_seen_s"], round(t_seconds, 2))
        entry["last_seen_s"] = max(entry["last_seen_s"], round(t_seconds, 2))
        entry["frames_seen"] += 1


def process_video(path: Path, runner: "EnsembleRunner", config: Config,
                  output_dir: Path, logger: "Logger") -> dict[str, Any]:
    """Detect on a video by sampling frames; write annotated mp4 + summary.

    Boxes from each sampled frame are carried forward onto the intermediate
    frames until the next sample, so playback looks continuous.
    """
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise ValueError(f"could not open video: {path}")

    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    sample_every = max(1, round(fps / max(0.01, config.frame_sample_fps)))

    out_path = output_dir / f"{path.stem}_annotated.mp4"
    output_dir.mkdir(parents=True, exist_ok=True)
    writer = cv2.VideoWriter(str(out_path), cv2.VideoWriter_fourcc(*"mp4v"), fps, (width, height))

    summary: dict[str, dict[str, Any]] = {}
    current: list[Detection] = []
    all_rows_result = DetectionResult([], width, height)  # accumulates for CSV/sidecar
    frame_idx = 0
    sampled = 0

    with tempfile.TemporaryDirectory(prefix="cw_frames_") as tmp:
        tmp_frame = Path(tmp) / "frame.jpg"
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if frame_idx % sample_every == 0:
                t = frame_idx / fps
                cv2.imwrite(str(tmp_frame), frame)
                try:
                    result = runner.detect_path(tmp_frame, width, height)
                    current = result.detections
                    _summarize(summary, current, t)
                    all_rows_result.detections.extend(current)
                    sampled += 1
                except Exception:
                    log.exception("detection failed on frame %d of %s", frame_idx, path.name)
                    current = []
            draw_detections(frame, current)
            writer.write(frame)
            frame_idx += 1

    cap.release()
    writer.release()

    species_summary = sorted(summary.values(), key=lambda e: e["max_confidence"], reverse=True)
    logger.append_rows(path, "video", all_rows_result)
    logger.write_sidecar(
        path, "video", all_rows_result, out_path,
        extra={
            "fps": round(fps, 3),
            "frames_total": frame_idx,
            "frames_sampled": sampled,
            "sample_every_n_frames": sample_every,
            "species_summary": species_summary,
        },
    )
    log.info("video %s -> %d frames, %d sampled, species: %s",
             path.name, frame_idx, sampled,
             ", ".join(e["label"] for e in species_summary) or "none")
    return {"annotated": str(out_path), "species_summary": species_summary}
