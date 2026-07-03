#!/usr/bin/env python3
"""SpeciesNet analyzer worker — fills in the animal labels on the dashboard.

In plain words: the cameras upload photos, but nothing identifies the animals
in them (captures sit at analyzed:false with an empty detections list). This
script is the missing "AI step": it asks the web backend for unanalyzed photos,
runs Google's open-source SpeciesNet camera-trap model on them LOCALLY (no
per-image cloud fees, ~2000 species), and posts the labels + bounding boxes
back. The dashboard then shows "deer 0.93" instead of "no animals detected",
and draws the boxes over the photo.

Privacy gate: the server (POST /api/detections) sets public:true only when the
labels contain no person/dog — this worker just reports honestly what the
model saw, including people.

Pipeline position (see web/app/api/capture-complete/route.ts):
    camera -> upload -> capture-complete (analyzed:false)
           -> THIS WORKER: GET /api/analysis-queue -> run SpeciesNet
           -> POST /api/detections {id, detections, boxes} (analyzed:true)

Setup (its own venv — SpeciesNet pulls in PyTorch, keep it out of the ingest venv):

  python3 -m venv scripts/.venv-speciesnet
  scripts/.venv-speciesnet/bin/pip install -r scripts/requirements-speciesnet.txt

Run (needs the backend URL + the CAMERA_API_KEY that guards the pipeline routes):

  export CAMERA_API_KEY=...       # same value as the web backend's env var
  scripts/.venv-speciesnet/bin/python scripts/speciesnet-worker.py \
      --backend https://wildlife-dashboard-ee47ntxftq-uw.a.run.app \
      --country USA --admin1-region CA \
      --loop 60

  --loop N   poll every N seconds forever (omit for a single pass)
  --dry-run  analyze but don't post results back
  --min-conf detection confidence floor (default 0.20)

The first run downloads the model weights (a few hundred MB, cached under
~/.cache). CPU-only is fine for a trickle of camera-trap photos.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

# Pillow ships with speciesnet's deps; used to convert normalized boxes -> pixels.
from PIL import Image

# SpeciesNet detection categories (MegaDetector lineage).
CATEGORY_LABELS = {"1": "animal", "2": "person", "3": "vehicle"}

# Predictions whose ensemble label is one of these mean "nothing to report".
NON_ANIMAL_PREDICTIONS = {"blank", "no cv result", "unknown"}


def http_json(url: str, api_key: str, payload: dict | None = None) -> dict:
    """GET (payload=None) or POST json against the backend. Raises on HTTP errors."""
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "x-camera-api-key": api_key,
            "Content-Type": "application/json",
        },
        method="POST" if payload is not None else "GET",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode())


def download(url: str, dest: Path) -> None:
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=120) as resp, open(dest, "wb") as f:
        f.write(resp.read())


def common_name(prediction: str) -> str:
    """SpeciesNet labels are taxonomy strings like
    'uuid;mammalia;cetartiodactyla;cervidae;odocoileus;hemionus;mule deer' —
    the last non-empty segment is the human-friendly name."""
    parts = [p.strip() for p in prediction.split(";") if p.strip()]
    return parts[-1] if parts else prediction


def run_speciesnet(folder: Path, out_json: Path, country: str | None, admin1: str | None) -> None:
    """Invoke the model CLI on a folder of JPEGs. Weights auto-download on first use."""
    cmd = [
        sys.executable, "-m", "speciesnet.scripts.run_model",
        "--folders", str(folder),
        "--predictions_json", str(out_json),
    ]
    # Geofencing sharply improves species accuracy (rules out impossible species).
    if country:
        cmd += ["--country", country]
    if admin1:
        cmd += ["--admin1_region", admin1]
    subprocess.run(cmd, check=True)


def to_payload(pred: dict, image_path: Path, min_conf: float) -> tuple[list, list]:
    """Convert one SpeciesNet prediction into the backend's wire shape.

    Returns (detections, boxes):
      detections: [{label, confidence, box:[x,y,w,h] pixels}]  — Firestore shape
      boxes:      [{class:'human'|'animal', bbox:[x,y,w,h]}]   — what the
                  dashboard's canvas already draws (red = human, yellow = animal)
    """
    with Image.open(image_path) as im:
        img_w, img_h = im.size

    # The ensemble species call for the whole image (best available name for
    # any animal-category detection box).
    prediction = pred.get("prediction") or ""
    pred_name = common_name(prediction)
    species = None if pred_name.lower() in NON_ANIMAL_PREDICTIONS else pred_name

    detections, boxes = [], []
    for det in pred.get("detections", []):
        conf = float(det.get("conf", 0))
        if conf < min_conf:
            continue
        cat = str(det.get("category", "1"))
        # SpeciesNet bbox: [xmin, ymin, width, height], normalized 0..1.
        # Dashboard boxes: pixels (canvas scales by naturalWidth/Height).
        try:
            xmin, ymin, bw, bh = det["bbox"]
        except (KeyError, ValueError, TypeError):
            continue
        px_box = [
            round(xmin * img_w),
            round(ymin * img_h),
            round(bw * img_w),
            round(bh * img_h),
        ]
        base = CATEGORY_LABELS.get(cat, "animal")
        # An animal box gets the species name when the classifier produced one.
        label = species if (base == "animal" and species) else base
        detections.append({"label": label, "confidence": round(conf, 3), "box": px_box})
        boxes.append({"class": "human" if base == "person" else "animal", "bbox": px_box})

    return detections, boxes


def process_batch(args: argparse.Namespace, api_key: str) -> int:
    """One poll->analyze->report cycle. Returns how many captures were handled."""
    queue = http_json(f"{args.backend}/api/analysis-queue", api_key)
    pending = queue.get("pending", [])
    if not pending:
        return 0
    print(f"[queue] {len(pending)} capture(s) pending analysis")

    with tempfile.TemporaryDirectory(prefix="speciesnet-") as td:
        tdir = Path(td)
        by_stem: dict[str, dict] = {}
        for item in pending:
            stem = item["id"]
            dest = tdir / f"{stem}.jpg"
            try:
                download(item["imageUrl"], dest)
                by_stem[stem] = item
            except Exception as e:  # a vanished object shouldn't sink the batch
                print(f"[skip] {item['objectPath']}: download failed ({e})")

        if not by_stem:
            return 0

        out_json = tdir / "predictions.json"
        run_speciesnet(tdir, out_json, args.country, args.admin1_region)
        predictions = json.loads(out_json.read_text()).get("predictions", [])

        handled = 0
        for pred in predictions:
            stem = Path(pred.get("filepath", "")).stem
            item = by_stem.get(stem)
            if not item:
                continue
            detections, boxes = to_payload(pred, tdir / f"{stem}.jpg", args.min_conf)
            summary = ", ".join(f"{d['label']} {d['confidence']}" for d in detections) or "nothing"
            print(f"[found] {item['objectPath']}: {summary}")
            if args.dry_run:
                handled += 1
                continue
            resp = http_json(
                f"{args.backend}/api/detections",
                api_key,
                {
                    "id": item["id"],
                    "deviceId": item.get("deviceId") or "unknown",
                    "objectPath": item["objectPath"],
                    "detections": detections,
                    "boxes": boxes,
                },
            )
            print(f"[saved] {item['id']} public={resp.get('public')}")
            handled += 1
        return handled


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--backend", required=True, help="web app base URL (no trailing slash)")
    ap.add_argument("--country", default=None, help="ISO 3166-1 alpha-3, e.g. USA (geofences species)")
    ap.add_argument("--admin1-region", default=None, help="US state code for --country USA, e.g. CA")
    ap.add_argument("--min-conf", type=float, default=0.20, help="detection confidence floor")
    ap.add_argument("--loop", type=int, default=0, metavar="SECONDS", help="poll forever at this interval")
    ap.add_argument("--dry-run", action="store_true", help="analyze but don't post results")
    args = ap.parse_args()
    args.backend = args.backend.rstrip("/")

    api_key = os.environ.get("CAMERA_API_KEY", "")
    if not api_key:
        print("ERROR: set the CAMERA_API_KEY env var (same value as the web backend).", file=sys.stderr)
        return 2

    while True:
        try:
            n = process_batch(args, api_key)
            if n == 0:
                print("[queue] nothing pending")
        except urllib.error.HTTPError as e:
            print(f"[error] backend said HTTP {e.code}: {e.read().decode()[:200]}", file=sys.stderr)
        except subprocess.CalledProcessError as e:
            print(f"[error] speciesnet run failed (exit {e.returncode})", file=sys.stderr)
        if not args.loop:
            return 0
        time.sleep(args.loop)


if __name__ == "__main__":
    raise SystemExit(main())
