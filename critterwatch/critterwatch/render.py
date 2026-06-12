"""Draw detection boxes + labels onto frames, and load images (incl. HEIC)."""
from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

from . import mapping
from .detection import Detection

# BGR colours per grouping category.
COLORS: dict[str, tuple[int, int, int]] = {
    mapping.HUMAN: (0, 0, 255),       # red
    mapping.DOMESTIC: (255, 0, 0),    # blue
    mapping.WILDLIFE: (0, 200, 0),    # green
    mapping.OTHER: (0, 215, 255),     # amber / yellow
    mapping.VEHICLE: (160, 160, 160), # gray
    mapping.BLANK: (120, 120, 120),
}


def load_image_bgr(path: Path) -> np.ndarray | None:
    """Load an image as a BGR ndarray. Supports HEIC/HEIF via pillow-heif."""
    ext = path.suffix.lower()
    if ext in (".heic", ".heif"):
        try:
            import pillow_heif
            from PIL import Image

            pillow_heif.register_heif_opener()
            pil = Image.open(str(path)).convert("RGB")
            return cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR)
        except Exception:
            return None
    img = cv2.imread(str(path))
    if img is not None:
        return img
    # Fallback through PIL for odd encodings.
    try:
        from PIL import Image

        pil = Image.open(str(path)).convert("RGB")
        return cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR)
    except Exception:
        return None


def _font_metrics(img_w: int, img_h: int) -> tuple[float, int]:
    base = max(img_w, img_h)
    font_scale = max(0.4, base / 1400.0)
    thickness = max(1, round(base / 700.0))
    return font_scale, thickness


def draw_detections(image: np.ndarray, detections: list[Detection]) -> np.ndarray:
    """Draw every detection (rectangle + ``label 87%``) onto ``image`` in place."""
    h, w = image.shape[:2]
    font_scale, thickness = _font_metrics(w, h)
    font = cv2.FONT_HERSHEY_SIMPLEX
    for det in detections:
        if det.category == mapping.BLANK:
            continue
        color = COLORS.get(det.category, COLORS[mapping.OTHER])
        x1, y1, x2, y2 = det.bbox.to_pixels(w, h)
        cv2.rectangle(image, (x1, y1), (x2, y2), color, thickness)

        text = f"{det.label} {det.confidence:.0%}"
        (tw, th), baseline = cv2.getTextSize(text, font, font_scale, thickness)
        # Prefer a label tab just above the box; drop inside if there's no room.
        if y1 - th - baseline - 4 >= 0:
            tab_top = y1 - th - baseline - 4
            text_y = y1 - baseline - 2
        else:
            tab_top = y1
            text_y = y1 + th + 2
        cv2.rectangle(image, (x1, tab_top), (x1 + tw + 6, tab_top + th + baseline + 4), color, -1)
        cv2.putText(image, text, (x1 + 3, text_y + (th if tab_top == y1 else 0)),
                    font, font_scale, (0, 0, 0), thickness, cv2.LINE_AA)
    return image


def save_annotated(image: np.ndarray, out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(out_path), image)
