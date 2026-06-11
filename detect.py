#!/usr/bin/env python3
"""detect.py - animal / human detection with bounding boxes on saved captures.

Runs a YOLO object detector over a photo OR a recording, draws labeled bounding
boxes, writes an annotated copy, and logs every detection to a CSV.

Targets: people, dogs, rats, and Santa Cruz Mountains wildlife (deer, coyote,
bobcat, mountain lion, raccoon, gray fox, striped skunk, wild turkey, squirrel,
opossum, rabbit, snake ...).

    pip install ultralytics opencv-python
    python3 detect.py photo.jpg
    python3 detect.py clip.mp4 --conf 0.35
    python3 detect.py photo.jpg --model path/to/wildlife.pt   # species model

------------------------------------------------------------------------------
MODEL COVERAGE - READ THIS:
The default model (yolo11n.pt, trained on the COCO dataset) only knows ~80
everyday classes. From your list it reliably detects: person, dog, cat, bird,
bear, horse, cow, sheep. It does NOT know deer, coyote, bobcat, mountain lion,
raccoon, fox, skunk, or rat. To detect those you must pass a wildlife-trained
model with --model (e.g. MegaDetector, or a species-trained YOLO). See README.
No detector is 100% accurate; treat low-confidence boxes with suspicion.
------------------------------------------------------------------------------
"""
import argparse
import csv
import os
import sys

import cv2
from ultralytics import YOLO

# Labels we keep. Lowercase. Includes COCO names (work now) plus the names a
# wildlife model is likely to emit (work once you load such a model).
TARGET = {
    # already in the default COCO model:
    "person", "dog", "cat", "bird", "bear", "horse", "cow", "sheep",
    # Santa Cruz Mountains wildlife (need a wildlife model to actually fire):
    "deer", "mule deer", "black-tailed deer", "elk",
    "coyote", "bobcat", "mountain lion", "puma", "cougar",
    "raccoon", "gray fox", "red fox", "fox", "striped skunk", "skunk",
    "opossum", "virginia opossum", "wild turkey", "turkey",
    "squirrel", "rabbit", "rat", "mouse", "rodent", "snake",
}

GREEN = (0, 220, 0)
RED = (0, 0, 220)


def color_for(name):
    return RED if name.lower() in ("person",) else GREEN


def draw_box(img, box, label, conf):
    x1, y1, x2, y2 = map(int, box)
    color = color_for(label)
    cv2.rectangle(img, (x1, y1), (x2, y2), color, 2)
    txt = f"{label} {conf:.0%}"
    (tw, th), _ = cv2.getTextSize(txt, cv2.FONT_HERSHEY_SIMPLEX, 0.6, 2)
    ytop = max(0, y1 - th - 8)
    cv2.rectangle(img, (x1, ytop), (x1 + tw + 6, ytop + th + 8), color, -1)
    cv2.putText(img, txt, (x1 + 3, ytop + th + 2),
                cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 2)


def keep(name, allow_all):
    return allow_all or name.lower() in TARGET


def detect_frame(model, frame, conf, allow_all):
    """Run the model on one image; draw boxes; return list of detection tuples."""
    res = model(frame, conf=conf, verbose=False)[0]
    found = []
    for b in res.boxes:
        name = model.names[int(b.cls)]
        if not keep(name, allow_all):
            continue
        xyxy = b.xyxy[0].tolist()
        c = float(b.conf)
        draw_box(frame, xyxy, name, c)
        found.append((name, round(c, 3), *[round(v, 1) for v in xyxy]))
    return found


def run_image(model, path, conf, out, allow_all):
    img = cv2.imread(path)
    if img is None:
        sys.exit(f"cannot read image: {path}")
    found = detect_frame(model, img, conf, allow_all)
    cv2.imwrite(out, img)
    return [(None, *f) for f in found]   # (frame=None, ...)


def run_video(model, path, conf, out, allow_all):
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        sys.exit(f"cannot open video: {path}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 12.0
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    writer = cv2.VideoWriter(out, cv2.VideoWriter_fourcc(*"mp4v"), fps, (w, h))
    rows = []
    n = 0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        for f in detect_frame(model, frame, conf, allow_all):
            rows.append((n, *f))
        writer.write(frame)
        n += 1
    cap.release()
    writer.release()
    return rows


def main():
    ap = argparse.ArgumentParser(description="Animal/human detection with bounding boxes.")
    ap.add_argument("input", help="image (.jpg/.png) or video (.mp4/.mov/.webm)")
    ap.add_argument("--model", default="yolo11n.pt",
                    help="YOLO weights. Use a wildlife model for species coverage.")
    ap.add_argument("--conf", type=float, default=0.35, help="confidence threshold (0-1)")
    ap.add_argument("-o", "--output", default=None, help="annotated output path")
    ap.add_argument("--all", action="store_true",
                    help="keep every detected class, not just the target list")
    args = ap.parse_args()

    if not os.path.exists(args.input):
        sys.exit(f"no such file: {args.input}")

    model = YOLO(args.model)   # weights auto-download on first run

    stem, ext = os.path.splitext(args.input)
    is_video = ext.lower() in (".mp4", ".mov", ".avi", ".mkv", ".webm")
    out = args.output or f"{stem}_detected{'.mp4' if is_video else ext}"

    if is_video:
        rows = run_video(model, args.input, args.conf, out, args.all)
        header = ["frame", "label", "conf", "x1", "y1", "x2", "y2"]
    else:
        rows = run_image(model, args.input, args.conf, out, args.all)
        header = ["frame", "label", "conf", "x1", "y1", "x2", "y2"]

    csv_path = f"{stem}_detections.csv"
    with open(csv_path, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(rows)

    print(f"annotated  -> {out}")
    print(f"detections -> {csv_path}  ({len(rows)} boxes)")
    if not rows:
        print("nothing kept. tip: lower --conf, add --all, or use a wildlife --model.")


if __name__ == "__main__":
    main()
