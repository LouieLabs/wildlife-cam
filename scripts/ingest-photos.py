#!/usr/bin/env python3
"""Trail-cam ingest pipeline for the wps-1 device.

Ingests raw JPEGs + their human/animal box annotations from a borrowed WPS
trail cam into the Wildlife-cam dataset.  See docs/PLAN-trailcam-ingest.md for
the full spec; the "Execution updates" section at the top of that doc records
deviations from the locked plan (pair-by-filename, wps-1 rename, etc.).

Runs authenticated as the developer via firebase-admin — no camera-facing
HTTP endpoints are involved.

Requires the venv at scripts/.venv (see scripts/requirements.txt).  Run as:

  scripts/.venv/bin/python scripts/ingest-photos.py \\
    --raw-dir /Users/alan/Downloads/wps_raw \\
    --boxed-dir /Users/alan/Downloads/wps_boxes \\
    --camera-manufacturer WPS-Home-Guard-W5 \\
    --camera-model L5P-W \\
    --night-mode infrared \\
    --deployment "multiple spots in LL backyard" \\
    --dry-run --limit 5
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import html
import json
import random
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Optional
from zoneinfo import ZoneInfo

DEVICE_ID = "WPS-1"
GCP_PROJECT = "louielabs-animal-cams"
GCS_BUCKET = "wildlife-camera-telemetry"
GCS_PREFIX = f"prod/uploads/{DEVICE_ID}"
FIRESTORE_DATABASE_ID = "wildlife-camera-telemetry-db"
FIRESTORE_COLLECTION = "wildlife_detections"
RTDB_URL = "https://louielabs-animal-cams-default-rtdb.firebaseio.com"
DISPLAY_TZ = "America/Los_Angeles"  # user's local; filename + capturedAt
APP_ENV = "prod"

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_STATE_FILE = SCRIPT_DIR / ".ingest-state.json"
DEFAULT_OUT_DIR = SCRIPT_DIR / "out"
DEFAULT_VERIFY_DIR = DEFAULT_OUT_DIR / "verify"

# 8/64 bits: loose enough to survive drawn boxes on a matched pair, tight
# enough to catch a wildly wrong pairing.
PHASH_THRESHOLD = 8

# Camera clock timezone.  UOVision cameras ship on China Standard Time
# (UTC+8, no DST).  Verified via IR/color-vs-daylight cross-check across the
# full 236-image batch: 97% consistent with UTC+8.  Overridable via
# --camera-timezone if you have a differently-set camera.
DEFAULT_CAMERA_TZ = "Asia/Shanghai"

# Burned metadata strip is a consistent height on this camera's 480-tall
# output. Fixed crop is robust across the batch; dynamic detection was fooled
# by natural dark shadows in some images.
STRIP_HEIGHT_PX = 30

# Below this median saturation, the image body is monochrome → IR.
IR_SAT_THRESHOLD = 25

# Minimum area (px²) for a detected drawn box.  Filters out JPEG-recompression
# noise while accepting even small boxes in the far field.
MIN_BOX_AREA = 200

# OCR patterns.  MOON_RE uses the fact that the moon-phase digit sits between
# the time and the tempC in every observed strip.
_DT_RE = re.compile(r'(20\d{2})[-/](\d{1,2})[-/](\d{1,2})[\s_\W]{0,4}(\d{1,2}):(\d{1,2}):(\d{1,2})')
_TEMP_C_RE = re.compile(r'(-?\d{1,3})\s*°?\s*C\b', re.IGNORECASE)
_TEMP_F_RE = re.compile(r'(-?\d{1,3})\s*°?\s*F\b', re.IGNORECASE)
# "PIA" is a common OCR misread of "PIR" — normalize to PIR downstream.
_TRIGGER_RE = re.compile(r'\b(PIR|PIA|TIMER|USER|MOTION)\b', re.IGNORECASE)
_MOON_CTX_RE = re.compile(
    r'\d{2}:\d{2}:\d{2}[^A-Za-z°]{1,15}?(\d{1,2})[^0-9]{1,10}\d{1,3}\s*°?\s*C',
    re.IGNORECASE,
)


@dataclass
class IngestConfig:
    raw_dir: Path
    boxed_dir: Path
    camera_manufacturer: str
    camera_model: str
    night_mode: str  # 'infrared' | 'white_flash'
    deployment: str
    camera_timezone: str  # IANA TZ, e.g., 'Asia/Shanghai'
    dry_run: bool
    verify_only: bool
    register_only: bool
    upload_confirmed: bool  # --yes
    limit: Optional[int]


@dataclass
class Pair:
    raw: Path
    boxed: Path
    raw_hash: str = ""  # sha256(raw) — populated on demand for idempotency


def parse_args() -> IngestConfig:
    p = argparse.ArgumentParser(
        description="Ingest trail-cam photos into the wps-1 device stream.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("--raw-dir", required=True, type=Path,
                   help="directory of raw JPEGs")
    p.add_argument("--boxed-dir", required=True, type=Path,
                   help="directory of JPEGs with human/animal boxes drawn")
    p.add_argument("--camera-manufacturer", required=True, type=str)
    p.add_argument("--camera-model", required=True, type=str)
    p.add_argument("--night-mode", required=True,
                   choices=("infrared", "white_flash"))
    p.add_argument("--deployment", required=True, type=str,
                   help="free-text deployment description")
    p.add_argument("--camera-timezone", type=str, default=DEFAULT_CAMERA_TZ,
                   help=(f"IANA timezone the camera clock is set to "
                         f"(default '{DEFAULT_CAMERA_TZ}' — verified for this UOVision batch)"))
    p.add_argument("--dry-run", action="store_true",
                   help="run pairing + OCR + box extraction + verify page, but do NOT upload")
    p.add_argument("--verify-only", action="store_true",
                   help="only rebuild the verify page from existing state")
    p.add_argument("--register-only", action="store_true",
                   help=(f"register {DEVICE_ID} as an external camera in RTDB and exit "
                         f"(no processing, no uploads)"))
    p.add_argument("--yes", action="store_true",
                   help=("required for real cloud uploads without --dry-run — "
                         "a belt-and-suspenders safety switch"))
    p.add_argument("--limit", type=int, default=None,
                   help="cap the number of pairs processed (useful for sampling)")
    a = p.parse_args()
    return IngestConfig(
        raw_dir=a.raw_dir.expanduser().resolve(),
        boxed_dir=a.boxed_dir.expanduser().resolve(),
        camera_manufacturer=a.camera_manufacturer,
        camera_model=a.camera_model,
        night_mode=a.night_mode,
        deployment=a.deployment,
        camera_timezone=a.camera_timezone,
        dry_run=a.dry_run,
        verify_only=a.verify_only,
        register_only=a.register_only,
        upload_confirmed=a.yes,
        limit=a.limit,
    )


def content_hash(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _jpg_index(d: Path) -> dict[str, Path]:
    out: dict[str, Path] = {}
    for pattern in ("*.jpg", "*.jpeg", "*.JPG", "*.JPEG"):
        for p in d.glob(pattern):
            out[p.name] = p
    return out


def pair_by_filename(raw_dir: Path, boxed_dir: Path) -> tuple[list[Pair], list[Path]]:
    """Match raw ↔ boxed by identical filename.

    Returns (matched pairs sorted by filename, boxed orphans sorted).  See the
    "Execution updates" section of docs/PLAN-trailcam-ingest.md — the UUID
    filenames align exactly on this batch, so filename is the primary key.
    """
    raw = _jpg_index(raw_dir)
    boxed = _jpg_index(boxed_dir)
    matched = [Pair(raw=raw[n], boxed=boxed[n]) for n in sorted(raw) if n in boxed]
    orphans = sorted(boxed[n] for n in boxed if n not in raw)
    return matched, orphans


def sanity_check_pairs(pairs: list[Pair], k: int = 5, threshold: int = PHASH_THRESHOLD
                       ) -> tuple[bool, Optional[tuple[Pair, int]]]:
    """pHash-based sanity check on k random matched pairs.

    Returns (all_pass, offender_or_None).  On failure, caller should fall back
    to the plan's original pHash-across-full-set pairing.
    """
    import imagehash
    from PIL import Image
    sample = random.sample(pairs, min(k, len(pairs)))
    for pr in sample:
        rh = imagehash.phash(Image.open(pr.raw))
        bh = imagehash.phash(Image.open(pr.boxed))
        dist = rh - bh
        if dist > threshold:
            return False, (pr, dist)
    return True, None


def pair_by_phash(raw_paths: list[Path], boxed_paths: list[Path]) -> tuple[list[Pair], list[Path]]:
    """Fallback: nearest-neighbor pHash across the full set (plan §2 step 1).

    Only reached if sanity_check_pairs() trips.  Not implemented yet — filename
    primary should suffice for this batch (100% coverage on 236 raws).
    """
    raise NotImplementedError(
        "pHash fallback not implemented; filename pairing should cover this batch"
    )


def _preprocess_strip(im_rgb):
    import cv2  # deferred
    h = im_rgb.shape[0]
    strip = im_rgb[h - STRIP_HEIGHT_PX:h, :, :]
    grey = cv2.cvtColor(strip, cv2.COLOR_RGB2GRAY)
    grey = cv2.bitwise_not(grey)  # white text on black → black text on white
    grey = cv2.resize(grey, None, fx=5, fy=5, interpolation=cv2.INTER_CUBIC)
    _, grey = cv2.threshold(grey, 90, 255, cv2.THRESH_BINARY)
    return grey


def ocr_bottom_strip(raw_path: Path, camera_timezone: str) -> dict:
    """OCR the burned metadata strip and convert the timestamp to Pacific.

    Returns a dict with whatever fields could be parsed.  If date+time doesn't
    parse the returned dict has {'ocrRaw': ...} only — no capturedAt / UTC.
    Parseable fields on this camera: capturedAt (PT ISO-8601), capturedAtUtc,
    stripDt (naive camera-local), tempC, triggerReason, moonPhaseIndex.
    """
    import numpy as np
    import pytesseract
    from PIL import Image

    im = np.array(Image.open(raw_path).convert("RGB"))
    processed = _preprocess_strip(im)
    txt = pytesseract.image_to_string(processed, config="--psm 6").strip()
    out: dict = {"ocrRaw": txt}

    m = _DT_RE.search(txt)
    if m:
        y, mo, dd, hh, mi, ss = m.groups()
        try:
            naive = dt.datetime(int(y), int(mo), int(dd), int(hh), int(mi), int(ss))
            cam_dt = naive.replace(tzinfo=ZoneInfo(camera_timezone))
            out["stripDt"] = naive.isoformat()
            out["capturedAtUtc"] = cam_dt.astimezone(dt.timezone.utc).isoformat()
            out["capturedAt"] = cam_dt.astimezone(ZoneInfo(DISPLAY_TZ)).isoformat()
        except ValueError:
            pass  # bad date components; fall through with ocrRaw only

    fm = _TEMP_F_RE.search(txt)
    cm = _TEMP_C_RE.search(txt)
    if fm and cm:
        c_direct = int(cm.group(1))
        c_from_f = round((int(fm.group(1)) - 32) * 5 / 9, 1)
        # If the two disagree by more than 1.5°C, °C was misread (e.g., 12°C
        # OCR'd as "120").  Trust °F in that case.
        out["tempC"] = c_direct if abs(c_direct - c_from_f) <= 1.5 else c_from_f
    elif fm:
        out["tempC"] = round((int(fm.group(1)) - 32) * 5 / 9, 1)
    elif cm:
        out["tempC"] = int(cm.group(1))

    t = _TRIGGER_RE.search(txt)
    if t:
        raw = t.group(1).upper()
        out["triggerReason"] = "PIR" if raw == "PIA" else raw

    mo_m = _MOON_CTX_RE.search(txt)
    if mo_m:
        val = int(mo_m.group(1))
        if 0 <= val <= 15:
            out["moonPhaseIndex"] = val

    return out


def _fit_rectangles(mask, class_name: str) -> list[dict]:
    """Detect rectangles as enclosed regions in a color-mask outline.

    Pad → close small gaps → flood-fill from outside.  Whatever the flood
    cannot reach is either the outline itself or the INTERIOR of a closed
    rectangle.  Each interior connected component is one drawn rectangle.
    Nested, full-frame, and multi-sibling rectangles all fall out for free —
    no ad-hoc merging.
    """
    import cv2  # deferred
    import numpy as np
    h, w = mask.shape
    pad = 3
    padded = np.zeros((h + 2 * pad, w + 2 * pad), dtype=np.uint8)
    padded[pad:pad + h, pad:pad + w] = mask
    # Close small gaps in the drawn outline (JPEG anti-aliasing, missing pixels).
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    outline = cv2.dilate(padded, kernel, iterations=1)
    # Flood from (0,0): everything outside every outline becomes 255.
    filled = outline.copy()
    ff_mask = np.zeros((filled.shape[0] + 2, filled.shape[1] + 2), np.uint8)
    cv2.floodFill(filled, ff_mask, (0, 0), 255)
    interior = (filled == 0).astype(np.uint8) * 255
    contours, _ = cv2.findContours(interior, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    boxes = []
    for c in contours:
        x, y, cw, ch = cv2.boundingRect(c)
        # Un-pad and expand back to include the outline itself (dilation ate a few px).
        x = max(0, x - pad)
        y = max(0, y - pad)
        cw = min(cw + 2 * pad, w - x)
        ch = min(ch + 2 * pad, h - y)
        if cw * ch >= MIN_BOX_AREA:
            boxes.append({"class": class_name, "bbox": [int(x), int(y), int(cw), int(ch)]})
    return boxes


def _fraction_contained(inner, outer) -> float:
    """What fraction of inner is inside outer?"""
    ax, ay, aw, ah = inner
    bx, by, bw, bh = outer
    ix1, iy1 = max(ax, bx), max(ay, by)
    ix2, iy2 = min(ax + aw, bx + bw), min(ay + ah, by + bh)
    if ix2 <= ix1 or iy2 <= iy1:
        return 0.0
    return ((ix2 - ix1) * (iy2 - iy1)) / (aw * ah)


def _outline_shaped_components(mask, thickness: int = 15, edge_frac_min: float = 0.6,
                                min_area: int = 300, include_lines: bool = True):
    """Per-component fallback: return the bbox of each connected component
    whose shape suggests it's a drawn-rectangle piece rather than a filled blob.

    Two acceptance paths:
      1. Very thin AND long (line-like, min dim < 15 px) — used only when
         `include_lines=True`.  Skip these when flood-fill already found the
         rectangle they belong to, or they'd duplicate its edges.
      2. Non-thin with pixels concentrated along the component's own bbox
         edges (edge_frac_min) — a hollow rectangle outline.

    Rejects filled blobs (deer ear glow etc.): their pixels spread through
    the bbox interior.
    """
    import cv2
    import numpy as np
    n, _, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    out = []
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        if area < min_area:
            continue
        if min(w, h) < 15:
            if include_lines and max(w, h) >= 30:
                out.append((int(x), int(y), int(w), int(h)))
            continue
        sub = mask[y:y + h, x:x + w]
        total = int(sub.sum() / 255)
        t = min(thickness, w // 3, h // 3)
        edge_zone = np.zeros_like(sub, dtype=bool)
        edge_zone[:t, :] = True
        edge_zone[-t:, :] = True
        edge_zone[:, :t] = True
        edge_zone[:, -t:] = True
        on_edge = int(sub[edge_zone].sum() / 255)
        if total > 0 and on_edge / total >= edge_frac_min:
            out.append((int(x), int(y), int(w), int(h)))
    return out


def extract_boxes(raw_path: Path, boxed_path: Path) -> list[dict]:
    """Find drawn box rectangles via loose HSV mask + flood-fill.

    Tight RGB missed most vertical edges (only 4-8% coverage — JPEG eats
    vertical strokes disproportionately).  Loose HSV bands catch ~65% of
    outline pixels, dense enough that a 5x5 dilate closes remaining gaps.

    Flood-fill from outside recovers every closed outline's interior as a
    connected component — nested and multi-sibling rectangles fall out for
    free.  Filled blobs (backlit deer ears, natural red patches, etc.) are
    inherently rejected: they have no interior "hole" for the flood to leave.

    Full-frame boxes whose outlines touch the image edge can't be closed by
    flood-fill (any tiny gap lets flood leak in), so we fall back to
    _bbox_from_edge_outline — a CC bbox of pixels that look edge-concentrated.
    """
    import cv2
    import numpy as np
    from PIL import Image
    im = np.array(Image.open(boxed_path).convert("RGB"))
    hsv = cv2.cvtColor(im, cv2.COLOR_RGB2HSV)
    yellow = cv2.inRange(hsv, (18, 120, 120), (38, 255, 255))
    red_a = cv2.inRange(hsv, (0, 120, 100), (10, 255, 255))
    red_b = cv2.inRange(hsv, (170, 120, 100), (179, 255, 255))
    red = cv2.bitwise_or(red_a, red_b)

    results = _fit_rectangles(yellow, "animal") + _fit_rectangles(red, "human")
    # Fallback for edge-touching outlines flood-fill couldn't close.
    for mask, cls in [(yellow, "animal"), (red, "human")]:
        existing = [b["bbox"] for b in results if b["class"] == cls]
        # Only include line-shaped fragments when flood-fill found nothing —
        # otherwise they'd duplicate the edges of already-detected rectangles.
        components = _outline_shaped_components(mask, include_lines=not existing)
        if not existing and len(components) >= 2:
            # Flood-fill found nothing but multiple edge-shaped fragments exist —
            # assume they're pieces of ONE big outline that couldn't close
            # (typically a rectangle whose sides touch the image edge).
            x_min = min(x for x, y, w, h in components)
            y_min = min(y for x, y, w, h in components)
            x_max = max(x + w for x, y, w, h in components)
            y_max = max(y + h for x, y, w, h in components)
            results.append({"class": cls,
                            "bbox": [x_min, y_min, x_max - x_min, y_max - y_min]})
        else:
            for fb in components:
                # Skip if this fragment is mostly inside an existing box
                # (thin edge pieces of a rectangle we already detected).
                if not any(_fraction_contained(fb, e) > 0.7 for e in existing):
                    x, y, w, h = fb
                    results.append({"class": cls, "bbox": [x, y, w, h]})
                    existing.append([x, y, w, h])
    return results


def detect_illumination(raw_path: Path) -> str:
    """'color' or 'ir'.  IR shots are near-monochrome — low median saturation."""
    import cv2  # deferred
    import numpy as np
    from PIL import Image

    im = np.array(Image.open(raw_path).convert("RGB"))
    h = im.shape[0]
    body = im[: h - STRIP_HEIGHT_PX, :, :]
    hsv = cv2.cvtColor(body, cv2.COLOR_RGB2HSV)
    return "ir" if np.median(hsv[:, :, 1]) < IR_SAT_THRESHOLD else "color"


_VERIFY_HTML_HEAD = """<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>WPS-1 ingest verify</title>
<style>
  body{font-family:system-ui,sans-serif;background:#111;color:#eee;margin:0;padding:20px}
  h1{color:#fff;font-weight:500;margin:0 0 4px 0}
  .sub{color:#888;margin:0 0 24px 0}
  .row{display:grid;grid-template-columns:1fr 1fr 260px;gap:12px;margin-bottom:20px;
       padding:12px;background:#1a1a1a;border-radius:6px}
  .pane{background:#000}
  .pane h3{margin:0 0 6px 0;font-size:12px;color:#888;text-transform:uppercase;letter-spacing:.06em}
  .img-wrap{position:relative;line-height:0}
  .img-wrap img{width:100%;display:block}
  .img-wrap canvas{position:absolute;top:0;left:0;pointer-events:none}
  .meta{font-size:13px;line-height:1.6;color:#ccc}
  .meta code{background:#000;padding:1px 5px;border-radius:3px;color:#8f8}
  .meta .k{color:#888;display:inline-block;min-width:80px}
  .badge{display:inline-block;padding:1px 6px;border-radius:3px;font-size:11px;margin-right:4px}
  .badge.human{background:#622;color:#fbb}
  .badge.animal{background:#652;color:#fd6}
  .badge.ir{background:#334;color:#8bd}
  .badge.color{background:#353;color:#8fb}
</style></head><body>
"""

_VERIFY_HTML_TAIL = """<script>
window.addEventListener('load', () => {
  document.querySelectorAll('.row').forEach(row => {
    const boxes = JSON.parse(row.dataset.boxes);
    const img = row.querySelector('img[data-overlay]');
    const canvas = row.querySelector('canvas');
    const draw = () => {
      canvas.width = img.clientWidth;
      canvas.height = img.clientHeight;
      const sx = img.clientWidth / img.naturalWidth;
      const sy = img.clientHeight / img.naturalHeight;
      const ctx = canvas.getContext('2d');
      ctx.lineWidth = 2;  // match the source-drawn stroke weight
      boxes.forEach(b => {
        // Colors chosen to match the drawn box colors sampled from the batch.
        ctx.strokeStyle = b.class === 'human' ? 'rgb(208, 22, 24)' : 'rgb(240, 240, 70)';
        const [x, y, w, h] = b.bbox;
        ctx.strokeRect(x * sx, y * sy, w * sx, h * sy);
      });
    };
    if (img.complete) draw(); else img.addEventListener('load', draw);
    window.addEventListener('resize', draw);
  });
});
</script></body></html>
"""


def build_verify_page(entries: list[dict], out_dir: Path) -> Path:
    """Write out/verify/index.html — side-by-side pairs for eyeballing.

    v1 shows every entry; mismatch-only filtering will come once we have a
    reliable "matches source" heuristic (IoU vs. re-detected source boxes).
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    out_file = out_dir / "index.html"

    n = len(entries)
    n_h = sum(1 for e in entries for b in e["boxes"] if b["class"] == "human")
    n_a = sum(1 for e in entries for b in e["boxes"] if b["class"] == "animal")
    n_ir = sum(1 for e in entries if e["illumination"] == "ir")
    n_ocr = sum(1 for e in entries if e["strip"].get("capturedAt"))

    parts = [_VERIFY_HTML_HEAD]
    parts.append(f"<h1>WPS-1 ingest verify</h1>")
    parts.append(f"<p class='sub'>{n} pairs · {n_ocr} with OCR datetime · "
                 f"{n_a} animal boxes · {n_h} human boxes · {n_ir} IR shots. "
                 f"Left = raw with our extracted boxes drawn · "
                 f"middle = source boxed JPEG · right = parsed metadata.</p>")

    for i, e in enumerate(entries):
        strip = e.get("strip", {})
        boxes_json = html.escape(json.dumps(e.get("boxes", [])))
        raw_url = f"file://{e['raw_path']}"
        boxed_url = f"file://{e['boxed_path']}"
        nm = Path(e["raw_path"]).name

        badges = []
        if e["illumination"] == "ir":
            badges.append("<span class='badge ir'>IR</span>")
        else:
            badges.append("<span class='badge color'>COLOR</span>")
        for b in e["boxes"]:
            badges.append(f"<span class='badge {b['class']}'>{b['class']}</span>")

        meta = f"""
        <h3>#{i} · {html.escape(nm[:12])}…</h3>
        <div class="meta">
          {"".join(badges)}<br><br>
          <span class="k">captured:</span> <code>{html.escape(strip.get('capturedAt') or '—')}</code><br>
          <span class="k">strip:</span> <code>{html.escape(strip.get('stripDt') or '—')}</code><br>
          <span class="k">tempC:</span> <code>{strip.get('tempC') if strip.get('tempC') is not None else '—'}</code><br>
          <span class="k">trigger:</span> <code>{html.escape(str(strip.get('triggerReason') or '—'))}</code><br>
          <span class="k">moon:</span> <code>{strip.get('moonPhaseIndex') if strip.get('moonPhaseIndex') is not None else '—'}</code><br>
          <span class="k">boxes:</span> <code>{len(e['boxes'])}</code><br>
        </div>
        """

        parts.append(f"""
<div class="row" data-boxes='{boxes_json}'>
  <div class="pane">
    <h3>raw + extracted overlay</h3>
    <div class="img-wrap">
      <img src="{raw_url}" data-overlay="1">
      <canvas></canvas>
    </div>
  </div>
  <div class="pane">
    <h3>source boxed</h3>
    <div class="img-wrap"><img src="{boxed_url}"></div>
  </div>
  <div>{meta}</div>
</div>""")

    parts.append(_VERIFY_HTML_TAIL)
    out_file.write_text("".join(parts))
    return out_file


def classify_boxes(boxes: list[dict]) -> str:
    """CLASS suffix from the plan §5: HUMAN, ANIMAL, HUMAN_ANIMAL, or EMPTY."""
    has_h = any(b["class"] == "human" for b in boxes)
    has_a = any(b["class"] == "animal" for b in boxes)
    if has_h and has_a: return "HUMAN_ANIMAL"
    if has_h: return "HUMAN"
    if has_a: return "ANIMAL"
    return "EMPTY"


def make_filename(entry: dict, ingest_pt: dt.datetime) -> str:
    """WPS-1_YYMMDD-HHMMSS_<CLASS>.jpg (PT time from OCR) or
    WPS-1_UNKNOWN_<hash8>_<CLASS>.jpg when OCR couldn't parse the strip."""
    cls = classify_boxes(entry["boxes"])
    cap_iso = entry["strip"].get("capturedAt")
    if cap_iso:
        cap = dt.datetime.fromisoformat(cap_iso)
        return f"{DEVICE_ID}_{cap.strftime('%y%m%d-%H%M%S')}_{cls}.jpg"
    h8 = entry["raw_hash"][:8]
    return f"{DEVICE_ID}_UNKNOWN_{h8}_{cls}.jpg"


def build_firestore_doc(entry: dict, object_path: str, cfg: IngestConfig,
                        ingest_now_ms: int) -> dict:
    """Firestore record — existing fleet fields + trail-cam extensions."""
    strip = entry["strip"]
    boxes = entry["boxes"]
    has_human = any(b["class"] == "human" for b in boxes)

    if strip.get("capturedAt"):
        captured_ms = int(dt.datetime.fromisoformat(strip["capturedAt"]).timestamp() * 1000)
    else:
        captured_ms = ingest_now_ms

    temp_c = strip.get("tempC")
    temp_f = round(temp_c * 9 / 5 + 32, 1) if temp_c is not None else None

    doc = {
        # existing fleet schema (see web/app/api/capture-complete/route.ts)
        "deviceId": DEVICE_ID,
        "env": APP_ENV,
        "objectPath": object_path,
        "capturedAt": captured_ms,
        "detections": [],           # reserved for a future Gemini pass
        "analyzed": False,
        "public": not has_human,    # any human box → private
        "temperatureF": temp_f,
        "humidityPercent": None,
        "createdAt": ingest_now_ms,
        # trail-cam extensions (all optional; existing dashboard ignores them)
        "boxes": boxes,
        "illumination": entry["illumination"],
        "source": {
            "kind": "trailcam",
            "manufacturer": cfg.camera_manufacturer,
            "model": cfg.camera_model,
            "nightMode": cfg.night_mode,
            "deployment": cfg.deployment,
        },
        "overlayMetadata": {
            "capturedAtUtc": strip.get("capturedAtUtc"),
            "capturedAtLocal": strip.get("capturedAt"),
            "tempC": temp_c,
            "moonPhaseIndex": strip.get("moonPhaseIndex"),
            "triggerReason": strip.get("triggerReason"),
            "ocrRaw": strip.get("ocrRaw"),
        },
    }
    return doc


def _rtdb_token():
    """Bearer token scoped for firebase.database (mirrors lib/rtdb.ts)."""
    import google.auth
    import google.auth.transport.requests
    creds, _ = google.auth.default(scopes=[
        "https://www.googleapis.com/auth/firebase.database",
        "https://www.googleapis.com/auth/userinfo.email",
    ])
    creds.refresh(google.auth.transport.requests.Request())
    return creds.token


def rtdb_set(path: str, value) -> None:
    """PUT to Realtime Database (REST). Mirrors web/lib/rtdb.ts exactly so
    the script can register an external camera when the browser UI isn't
    available (or hasn't shipped to prod yet)."""
    import requests
    r = requests.put(
        f"{RTDB_URL}/{path}.json",
        headers={"Authorization": f"Bearer {_rtdb_token()}",
                 "Content-Type": "application/json"},
        data=json.dumps(value),
        timeout=15,
    )
    r.raise_for_status()


def rtdb_get(path: str):
    import requests
    r = requests.get(
        f"{RTDB_URL}/{path}.json",
        headers={"Authorization": f"Bearer {_rtdb_token()}"},
        timeout=15,
    )
    r.raise_for_status()
    return r.json()


def register_external_device(cfg: IngestConfig) -> None:
    """Register WPS-1 as an external camera via direct RTDB write, matching
    what web/app/api/register-device/route.ts does for cameraType=external.
    No-op if it's already registered."""
    existing = rtdb_get(f"device_meta/{DEVICE_ID}")
    if existing:
        print(f"  device_meta/{DEVICE_ID} already exists; skipping registration")
        return
    print(f"  writing device_meta/{DEVICE_ID}...")
    rtdb_set(f"device_meta/{DEVICE_ID}", {
        "mac": None,
        "cameraType": "external",
        "manufacturer": cfg.camera_manufacturer,
        "model": cfg.camera_model,
        "nightMode": cfg.night_mode,
        "deployment": cfg.deployment,
        "registeredBy": "scripts/ingest-photos.py",
        "registeredAt": int(dt.datetime.now(dt.timezone.utc).timestamp() * 1000),
        "netMode": None,
        "wifiSsid": None,
        "wifiPass": None,
        "halowSsid": None,
        "halowPsk": None,
    })


def _gcs_bucket():
    from google.cloud import storage
    return storage.Client(project=GCP_PROJECT).bucket(GCS_BUCKET)


def _firestore_client():
    from google.cloud import firestore
    return firestore.Client(project=GCP_PROJECT, database=FIRESTORE_DATABASE_ID)


def upload_and_record(entry: dict, cfg: IngestConfig, gcs_bucket, fs_client
                      ) -> tuple[str, str]:
    """Upload raw JPEG to GCS + write Firestore record. Returns (object_path, doc_id)."""
    ingest_now_ms = int(dt.datetime.now(dt.timezone.utc).timestamp() * 1000)
    ingest_pt = dt.datetime.now(ZoneInfo(DISPLAY_TZ))
    filename = make_filename(entry, ingest_pt)
    object_path = f"{GCS_PREFIX}/{filename}"

    blob = gcs_bucket.blob(object_path)
    if not blob.exists():
        blob.upload_from_filename(entry["raw_path"], content_type="image/jpeg")

    doc = build_firestore_doc(entry, object_path, cfg, ingest_now_ms)
    doc_ref = fs_client.collection(FIRESTORE_COLLECTION).add(doc)
    # firestore.add returns (write_result, doc_ref) tuple
    doc_id = doc_ref[1].id if isinstance(doc_ref, tuple) else doc_ref.id
    return object_path, doc_id


def load_state(path: Path) -> dict:
    if path.exists():
        return json.loads(path.read_text())
    return {"uploaded": {}}  # raw content-hash -> gcs object path


def save_state(path: Path, state: dict) -> None:
    path.write_text(json.dumps(state, indent=2, sort_keys=True))


ENTRIES_FILE = DEFAULT_OUT_DIR / "entries.json"
ORPHANS_FILE = DEFAULT_OUT_DIR / "boxed-orphans.txt"


def process_pair(pr: Pair, camera_timezone: str) -> dict:
    return {
        "raw_path": str(pr.raw),
        "boxed_path": str(pr.boxed),
        "strip": ocr_bottom_strip(pr.raw, camera_timezone),
        "boxes": extract_boxes(pr.raw, pr.boxed),
        "illumination": detect_illumination(pr.raw),
    }


def print_summary(entries: list[dict]) -> None:
    n = len(entries)
    n_ocr = sum(1 for e in entries if e["strip"].get("capturedAt"))
    n_ir = sum(1 for e in entries if e["illumination"] == "ir")
    n_h = sum(1 for e in entries for b in e["boxes"] if b["class"] == "human")
    n_a = sum(1 for e in entries for b in e["boxes"] if b["class"] == "animal")
    n_no_box = sum(1 for e in entries if not e["boxes"])
    print(f"\nsummary ({n} pairs):")
    print(f"  OCR datetime parsed: {n_ocr}/{n}")
    print(f"  illumination IR:     {n_ir}/{n}")
    print(f"  animal boxes:        {n_a}")
    print(f"  human boxes:         {n_h}")
    print(f"  no boxes extracted:  {n_no_box}")


def main() -> int:
    cfg = parse_args()

    if not cfg.raw_dir.is_dir():
        print(f"error: --raw-dir {cfg.raw_dir} not a directory", file=sys.stderr)
        return 2
    if not cfg.boxed_dir.is_dir():
        print(f"error: --boxed-dir {cfg.boxed_dir} not a directory", file=sys.stderr)
        return 2

    print(f"ingest-photos.py — device={DEVICE_ID}  env={APP_ENV}")
    print(f"  raw:      {cfg.raw_dir}")
    print(f"  boxed:    {cfg.boxed_dir}")
    print(f"  camera:   {cfg.camera_manufacturer} / {cfg.camera_model} / {cfg.night_mode}")
    print(f"  cam TZ:   {cfg.camera_timezone} → filename+capturedAt in {DISPLAY_TZ}")
    print(f"  deploy:   {cfg.deployment}")
    print(f"  dry_run={cfg.dry_run}  verify_only={cfg.verify_only}  limit={cfg.limit}")

    if cfg.register_only:
        print(f"\n=== REGISTERING {DEVICE_ID} (register-only, no processing) ===")
        register_external_device(cfg)
        print("done.")
        return 0

    # --verify-only: rebuild HTML from cached entries.json without re-processing.
    if cfg.verify_only:
        if not ENTRIES_FILE.exists():
            print(f"error: no cached entries at {ENTRIES_FILE} — run without "
                  f"--verify-only at least once first", file=sys.stderr)
            return 1
        entries = json.loads(ENTRIES_FILE.read_text())
        print(f"\nrebuilding verify page from {len(entries)} cached entries...")
        print_summary(entries)
        verify = build_verify_page(entries, DEFAULT_VERIFY_DIR)
        print(f"\nverify page: file://{verify}")
        return 0

    pairs, orphans = pair_by_filename(cfg.raw_dir, cfg.boxed_dir)
    print(f"pair-by-filename: {len(pairs)} matched, {len(orphans)} boxed orphans")

    if not pairs:
        print("no pairs found — check --raw-dir / --boxed-dir contents", file=sys.stderr)
        return 1

    ok, offender = sanity_check_pairs(pairs)
    if not ok:
        assert offender is not None
        pr, dist = offender
        print(f"pHash sanity check FAILED on {pr.raw.name} "
              f"(Hamming distance {dist} > {PHASH_THRESHOLD})", file=sys.stderr)
        print("falling back to pHash-across-full-set (not implemented yet)",
              file=sys.stderr)
        return 1
    print(f"pHash sanity check passed on 5 samples (all distances ≤ {PHASH_THRESHOLD})")

    if cfg.limit is not None:
        pairs = pairs[: cfg.limit]
        print(f"limited to first {len(pairs)} pairs")

    print(f"\nprocessing {len(pairs)} pairs (OCR + boxes + illumination)...")
    entries: list[dict] = []
    for i, pr in enumerate(pairs):
        entries.append(process_pair(pr, cfg.camera_timezone))
        step = 25 if len(pairs) > 25 else 5
        if (i + 1) % step == 0 or i + 1 == len(pairs):
            print(f"  ...{i+1}/{len(pairs)}")

    print_summary(entries)

    DEFAULT_OUT_DIR.mkdir(parents=True, exist_ok=True)
    ENTRIES_FILE.write_text(json.dumps(entries, indent=2))

    verify = build_verify_page(entries, DEFAULT_VERIFY_DIR)
    print(f"\nverify page: file://{verify}")
    print(f"cached entries: {ENTRIES_FILE}")

    if orphans:
        ORPHANS_FILE.write_text("\n".join(p.name for p in orphans))
        print(f"\n{len(orphans)} boxed orphans (no raw twin — not ingested):")
        for p in orphans:
            print(f"  {p.name}")
        print(f"(also written to {ORPHANS_FILE})")

    if cfg.dry_run:
        print("\n(dry-run: no upload)")
        return 0

    if not cfg.upload_confirmed:
        print("\nno upload — real uploads require --yes (safety switch).",
              file=sys.stderr)
        print(f"eyeball {verify} first, then re-run with --yes to upload.",
              file=sys.stderr)
        return 1

    # ─── Real upload path ────────────────────────────────────────────────
    print(f"\n=== REGISTERING {DEVICE_ID} ===")
    register_external_device(cfg)

    print(f"\n=== UPLOADING {len(entries)} pairs to gs://{GCS_BUCKET}/{GCS_PREFIX}/ ===")
    state = load_state(DEFAULT_STATE_FILE)
    uploaded = state.setdefault("uploaded", {})   # raw_hash -> {object_path, doc_id}
    gcs_bucket = _gcs_bucket()
    fs_client = _firestore_client()

    n_new, n_cached, n_failed = 0, 0, 0
    for i, e in enumerate(entries):
        h = e.setdefault("raw_hash", content_hash(Path(e["raw_path"])))
        if h in uploaded:
            n_cached += 1
        else:
            try:
                obj, doc_id = upload_and_record(e, cfg, gcs_bucket, fs_client)
                uploaded[h] = {"object_path": obj, "doc_id": doc_id,
                               "uploaded_at": int(dt.datetime.now(dt.timezone.utc).timestamp() * 1000)}
                n_new += 1
                # Persist state after each successful upload so a Ctrl-C is recoverable.
                save_state(DEFAULT_STATE_FILE, state)
            except Exception as ex:
                print(f"  FAIL {Path(e['raw_path']).name[:12]}: {ex}", file=sys.stderr)
                n_failed += 1
        step = 25 if len(entries) > 25 else 5
        if (i + 1) % step == 0 or i + 1 == len(entries):
            print(f"  ...{i+1}/{len(entries)}  (new={n_new}, cached={n_cached}, failed={n_failed})")

    print(f"\ndone. uploaded={n_new}, cached={n_cached}, failed={n_failed}")
    print(f"state: {DEFAULT_STATE_FILE}")
    return 0 if n_failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
