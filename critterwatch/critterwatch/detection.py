"""Core data structures shared across critterwatch modules."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional


@dataclass
class BBox:
    """A bounding box in MegaDetector convention.

    Stored normalized to [0, 1] as ``[x, y, w, h]`` where ``(x, y)`` is the
    top-left corner and ``(w, h)`` the width/height fraction of the image.
    """

    x: float
    y: float
    w: float
    h: float

    def to_pixels(self, img_w: int, img_h: int) -> tuple[int, int, int, int]:
        """Return integer ``(x1, y1, x2, y2)`` pixel corners, clamped to the image."""
        x1 = max(0, min(img_w, round(self.x * img_w)))
        y1 = max(0, min(img_h, round(self.y * img_h)))
        x2 = max(0, min(img_w, round((self.x + self.w) * img_w)))
        y2 = max(0, min(img_h, round((self.y + self.h) * img_h)))
        return x1, y1, x2, y2

    def as_list(self) -> list[float]:
        return [self.x, self.y, self.w, self.h]


@dataclass
class Detection:
    """One detected object: a box plus its best available label and provenance."""

    bbox: BBox
    label: str                       # display label (mapped target name or verbatim taxon)
    category: str                    # color/grouping bucket (see mapping.py)
    confidence: float                # final confidence used for display
    det_category: str                # MegaDetector class: animal | human | vehicle
    det_confidence: float            # MegaDetector confidence
    raw_taxonomy: str = ""           # raw SpeciesNet prediction string
    classifier_confidence: Optional[float] = None
    on_target_list: bool = True

    def to_dict(self, img_w: int, img_h: int) -> dict[str, Any]:
        x1, y1, x2, y2 = self.bbox.to_pixels(img_w, img_h)
        return {
            "label": self.label,
            "category": self.category,
            "confidence": round(self.confidence, 4),
            "on_target_list": self.on_target_list,
            "detector_category": self.det_category,
            "detector_confidence": round(self.det_confidence, 4),
            "classifier_confidence": (
                round(self.classifier_confidence, 4)
                if self.classifier_confidence is not None
                else None
            ),
            "raw_taxonomy": self.raw_taxonomy,
            "bbox_normalized": [round(v, 6) for v in self.bbox.as_list()],
            "bbox_pixels": [x1, y1, x2, y2],
        }


@dataclass
class DetectionResult:
    """Everything produced for a single still image (or a single video frame)."""

    detections: list[Detection]
    image_width: int
    image_height: int
    model_version: str = ""
    raw: Optional[dict] = None        # the untouched SpeciesNet prediction record
