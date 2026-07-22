"""SpeciesNet detection service — the camera-trap specialist behind the dashboard.

In plain words: the web backend POSTs a photo here and gets back "what animals
are in it, and where" from Google's open-source SpeciesNet model (the same
MegaDetector family used by real wildlife researchers). The backend uses the
answer to decide whether the photo is empty, private (person/dog), or worth
asking Gemini to fine-label.

Security model (why this file contains NO auth code): the service is deployed
with --no-allow-unauthenticated, so Cloud Run's own IAM layer rejects anyone
who isn't the dashboard backend BEFORE a request ever reaches this container.
There is no API key to distribute, no password to leak, and no public surface
— this is what fixes the objection that reverted the original SpeciesNet
worker (PR #39/#40).

Endpoints:
  POST /detect   body = raw JPEG bytes (Content-Type: image/jpeg)
                 optional ?country=USA&admin1_region=CA (defaults shown)
  GET  /healthz  cheap liveness — never forces a model load
"""

from __future__ import annotations

import io
import logging
from importlib import metadata

from flask import Flask, jsonify, request
from PIL import Image, UnidentifiedImageError

import parsing
import speciesnet_runner

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("speciesnet-service")

app = Flask(__name__)

try:
    SPECIESNET_PACKAGE = metadata.version("speciesnet")
except metadata.PackageNotFoundError:  # pragma: no cover — always installed in the image
    SPECIESNET_PACKAGE = "unknown"


@app.get("/healthz")
def healthz():
    # modelLoaded reports without loading — Cloud Run probes must stay cheap.
    return jsonify({"ok": True, "modelLoaded": speciesnet_runner.model_loaded()})


@app.post("/detect")
def detect():
    if request.content_type != "image/jpeg":
        return jsonify({"error": "Content-Type must be image/jpeg"}), 415

    body = request.get_data()
    if not body:
        return jsonify({"error": "Empty body"}), 400

    try:
        with Image.open(io.BytesIO(body)) as im:
            img_w, img_h = im.size
    except UnidentifiedImageError:
        return jsonify({"error": "Body is not a decodable image"}), 400

    country = request.args.get("country", "USA")
    admin1_region = request.args.get("admin1_region", "CA")

    try:
        record = speciesnet_runner.run_prediction(body, country=country, admin1_region=admin1_region)
    except Exception:
        log.exception("model prediction failed")
        return jsonify({"error": "Model prediction failed"}), 500

    response = parsing.record_to_response(record, img_w, img_h, speciesnet_package=SPECIESNET_PACKAGE)
    log.info(
        "detect: %dx%d -> %d detection(s), species=%s",
        img_w, img_h, len(response["detections"]), response["species"],
    )
    return jsonify(response)


if __name__ == "__main__":  # local dev only; Cloud Run uses gunicorn (Dockerfile CMD)
    import os

    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8080")))
