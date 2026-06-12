"""The detection pipeline: load the ensemble, run it, parse, render, log.

Parsing is written against SpeciesNet 5.x's observed ``predict`` output. Each
prediction record looks like::

    {
      "filepath": "...",
      "detections": [{"category": "1", "label": "animal", "conf": 0.84,
                      "bbox": [x, y, w, h]}],          # x,y,w,h normalized, top-left
      "prediction": "uuid;class;order;family;genus;species;common",
      "prediction_score": 0.99,
      "prediction_source": "classifier",
      "classifications": {"classes": [...], "scores": [...]},
      "model_version": "4.0.3a",
    }

MegaDetector (category 1=animal, 2=human, 3=vehicle) supplies the boxes;
SpeciesNet's image-level ``prediction`` supplies the species, applied to the
animal box(es). No detection is ever dropped.
"""
from __future__ import annotations

import csv
import datetime as _dt
import json
import logging
from pathlib import Path
from typing import Any, Optional

from . import mapping, render
from .config import Config, resolve_device
from .detection import BBox, Detection, DetectionResult

log = logging.getLogger("critterwatch.pipeline")

# MegaDetector category codes.
_CAT_ANIMAL, _CAT_HUMAN, _CAT_VEHICLE = "1", "2", "3"


class EnsembleRunner:
    """Loads the MegaDetector + SpeciesNet ensemble once and runs it on files."""

    def __init__(self, config: Config) -> None:
        self.config = config
        self.device = resolve_device(config.device)
        print(f"[critterwatch] compute device: {self.device}")
        from speciesnet import DEFAULT_MODEL, SpeciesNet

        log.info("loading SpeciesNet ensemble (%s)...", DEFAULT_MODEL)
        self.model = SpeciesNet(DEFAULT_MODEL, components="all", geofence=True)
        self.model_name = DEFAULT_MODEL
        log.info("ensemble ready")

    def predict_record(self, path: Path) -> dict[str, Any]:
        """Run the ensemble on one file and return its prediction record."""
        result = self.model.predict(
            filepaths=[str(path)],
            country=self.config.country,
            admin1_region=self.config.state,
        )
        preds = result.get("predictions") if isinstance(result, dict) else None
        if not preds:
            raise RuntimeError(f"ensemble returned no prediction for {path}")
        return preds[0]

    def parse_record(self, record: dict[str, Any]) -> list[Detection]:
        """Turn a SpeciesNet prediction record into Detection objects."""
        prediction = record.get("prediction", "") or ""
        pred_score = float(record.get("prediction_score", 0.0) or 0.0)
        det_thresh = self.config.detector_confidence_threshold
        cls_thresh = self.config.classifier_confidence_threshold

        detections: list[Detection] = []
        for det in record.get("detections", []):
            conf = float(det.get("conf", 0.0) or 0.0)
            if conf < det_thresh:
                continue
            raw_box = det.get("bbox") or [0.0, 0.0, 0.0, 0.0]
            bbox = BBox(*(float(v) for v in raw_box[:4]))
            category = str(det.get("category", _CAT_ANIMAL))

            if category == _CAT_HUMAN:
                ml = mapping.map_detection("human", None)
                detections.append(Detection(bbox, ml.label, ml.category, conf,
                                            "human", conf, on_target_list=ml.on_target_list))
            elif category == _CAT_VEHICLE:
                ml = mapping.map_detection("vehicle", None)
                detections.append(Detection(bbox, ml.label, ml.category, conf,
                                            "vehicle", conf, on_target_list=ml.on_target_list))
            else:  # animal -> use the species prediction
                if prediction and pred_score >= cls_thresh:
                    ml = mapping.map_taxon(prediction)
                    if ml.category == mapping.BLANK:  # never drop a real animal box
                        label, cat, on_target = "animal", mapping.OTHER, False
                    else:
                        label, cat, on_target = ml.label, ml.category, ml.on_target_list
                    disp_conf, cls_conf = pred_score, pred_score
                else:
                    # below the classifier threshold: keep the box, label generically
                    label, cat, on_target = "animal", mapping.OTHER, False
                    disp_conf = conf
                    cls_conf = pred_score if prediction else None
                detections.append(Detection(
                    bbox, label, cat, disp_conf, "animal", conf,
                    raw_taxonomy=prediction, classifier_confidence=cls_conf,
                    on_target_list=on_target,
                ))
        return detections

    def detect_path(self, path: Path, img_w: int, img_h: int) -> DetectionResult:
        record = self.predict_record(path)
        dets = self.parse_record(record)
        return DetectionResult(dets, img_w, img_h,
                               model_version=str(record.get("model_version", "")),
                               raw=record)


class Logger:
    """Writes per-file JSON sidecars and appends rows to detections.csv."""

    CSV_HEADER = ["timestamp", "filename", "media_type", "label", "category",
                  "confidence", "on_target_list", "bbox_pixels", "bbox_normalized"]

    def __init__(self, output_dir: Path, json_dir: Optional[Path] = None) -> None:
        # output_dir: annotated media + detections.csv
        # json_dir:   per-file .json sidecars (defaults to output_dir)
        self.output_dir = output_dir
        self.json_dir = json_dir or output_dir
        self.csv_path = output_dir / "detections.csv"
        output_dir.mkdir(parents=True, exist_ok=True)
        self.json_dir.mkdir(parents=True, exist_ok=True)
        if not self.csv_path.exists():
            with self.csv_path.open("w", newline="") as fh:
                csv.writer(fh).writerow(self.CSV_HEADER)

    @staticmethod
    def _now() -> str:
        return _dt.datetime.now().astimezone().isoformat(timespec="seconds")

    def write_sidecar(self, source: Path, media_type: str, result: DetectionResult,
                      annotated_path: Path, extra: Optional[dict] = None) -> Path:
        data = {
            "source_file": str(source.resolve()),
            "annotated_file": str(annotated_path.resolve()),
            "media_type": media_type,
            "processed_at": self._now(),
            "model_version": result.model_version,
            "model_name": "speciesnet ensemble (MegaDetector + SpeciesNet)",
            "image_width": result.image_width,
            "image_height": result.image_height,
            "num_detections": len(result.detections),
            "detections": [d.to_dict(result.image_width, result.image_height)
                           for d in result.detections],
        }
        if extra:
            data.update(extra)
        sidecar = self.json_dir / (source.stem + ".json")
        sidecar.write_text(json.dumps(data, indent=2))
        return sidecar

    def append_rows(self, source: Path, media_type: str, result: DetectionResult) -> int:
        ts = self._now()
        rows = []
        for d in result.detections:
            x1, y1, x2, y2 = d.bbox.to_pixels(result.image_width, result.image_height)
            rows.append([
                ts, source.name, media_type, d.label, d.category,
                round(d.confidence, 4), d.on_target_list,
                f"{x1},{y1},{x2},{y2}",
                ",".join(f"{v:.5f}" for v in d.bbox.as_list()),
            ])
        with self.csv_path.open("a", newline="") as fh:
            csv.writer(fh).writerows(rows)
        return len(rows)


def process_image(path: Path, runner: EnsembleRunner, config: Config,
                  output_dir: Path, logger: Logger) -> DetectionResult:
    """Detect on a still image; write annotated copy + sidecar + CSV rows."""
    image = render.load_image_bgr(path)
    if image is None:
        raise ValueError(f"could not read image: {path}")
    h, w = image.shape[:2]
    result = runner.detect_path(path, w, h)
    render.draw_detections(image, result.detections)

    heic = path.suffix.lower() in (".heic", ".heif")
    out_path = output_dir / f"{path.stem}_annotated{'.jpg' if heic else path.suffix}"
    render.save_annotated(image, out_path)

    logger.write_sidecar(path, "image", result, out_path)
    logger.append_rows(path, "image", result)
    log.info("image %s -> %d detection(s): %s", path.name, len(result.detections),
             ", ".join(f"{d.label} {d.confidence:.0%}" for d in result.detections) or "none")
    return result


def process_file(path: Path, runner: EnsembleRunner, config: Config,
                 output_dir: Path, logger: Logger) -> None:
    """Dispatch a file to the image or video pipeline based on its extension."""
    if config.is_image(path):
        process_image(path, runner, config, output_dir, logger)
    elif config.is_video(path):
        from . import video  # lazy import (pulls cv2 video stack)

        video.process_video(path, runner, config, output_dir, logger)
    else:
        log.warning("unsupported file type, skipping: %s", path)
