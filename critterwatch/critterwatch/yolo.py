"""YOLO (COCO) detector — the generalist that knows dog/cat/person up close.

SpeciesNet is a wildlife camera-trap model and is weak on household pets and
people in everyday photos. YOLO's COCO classes include ``person``, ``dog``,
``cat``, ``bird`` and ``bear`` directly, so it covers exactly that gap. The two
are merged in :func:`critterwatch.mapping.combine_detections`.
"""
from __future__ import annotations

import logging
from pathlib import Path

from . import mapping
from .config import Config, resolve_device
from .detection import BBox, Detection

log = logging.getLogger("critterwatch.yolo")


class YoloRunner:
    """Runs an ultralytics YOLO model and returns mapped :class:`Detection`s."""

    def __init__(self, config: Config) -> None:
        from ultralytics import YOLO  # heavy import, kept lazy

        self.config = config
        self.device = resolve_device(config.device)
        self.conf = config.yolo_confidence
        # Downloads the weights (~tens of MB) into the ultralytics cache on first use.
        self.model = YOLO(config.yolo_model)
        log.info("loaded YOLO (%s) on %s", config.yolo_model, self.device)

    def detect(self, path: Path, img_w: int, img_h: int) -> list[Detection]:
        """Detect COCO animals/people in ``path``; return mapped detections.

        Only the animal/person COCO classes we care about are kept (see
        ``mapping.COCO_KEEP``); furniture, cars, etc. are ignored.
        """
        results = self.model.predict(str(path), conf=self.conf, verbose=False,
                                     device=self.device)
        dets: list[Detection] = []
        if not results:
            return dets
        r = results[0]
        names = r.names  # {class_id: name}
        for box in r.boxes:
            cls_id = int(box.cls[0])
            name = (names.get(cls_id) if isinstance(names, dict) else names[cls_id]) or str(cls_id)
            if name.lower() not in mapping.COCO_KEEP:
                continue
            conf = float(box.conf[0])
            x1, y1, x2, y2 = (float(v) for v in box.xyxyn[0])  # normalized corners
            bbox = BBox(x1, y1, max(0.0, x2 - x1), max(0.0, y2 - y1))
            ml = mapping.map_coco(name)
            dets.append(Detection(
                bbox, ml.label, ml.category, conf,
                det_category=f"yolo:{name}", det_confidence=conf,
                on_target_list=ml.on_target_list,
            ))
        return dets
