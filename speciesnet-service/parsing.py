"""Pure helpers: turn a SpeciesNet prediction record into our JSON response.

In plain words: SpeciesNet answers with a dense "record" — taxonomy strings
like "uuid;mammalia;...;mule deer", normalized boxes, category numbers. This
file translates that into the plain shape the web backend expects. Everything
here is a pure function (no model, no torch, no network), so the tests run in
under a second on any machine.

IMPORTANT: we do NOT filter out low-confidence detections here. The web
backend needs the RAW list — a faint "maybe a person" at 0.05 confidence must
still reach the privacy gate, even though it's far below any display floor.
Filtering is the caller's job.
"""

from __future__ import annotations

# MegaDetector-lineage detection categories.
CATEGORY_LABELS = {"1": "animal", "2": "person", "3": "vehicle"}

# Ensemble predictions that mean "no species to report".
NON_ANIMAL_PREDICTIONS = {"blank", "no cv result", "unknown"}


def common_name(prediction: str) -> str:
    """The human-friendly tail of a SpeciesNet taxonomy string.

    'uuid;mammalia;cetartiodactyla;cervidae;odocoileus;hemionus;mule deer'
    -> 'mule deer'
    """
    parts = [p.strip() for p in (prediction or "").split(";") if p.strip()]
    return parts[-1] if parts else (prediction or "")


def record_to_response(
    record: dict,
    img_w: int,
    img_h: int,
    speciesnet_package: str = "",
) -> dict:
    """Convert one SpeciesNet prediction record into the /detect response body.

    Detection shape (per the contract with web/lib/speciesnetClient.ts):
      category:  'animal' | 'person' | 'vehicle'
      label:     species common name for animal boxes (null if the classifier
                 said blank/unknown); the detector's own word otherwise
      confidence: 0..1
      box:       [x, y, w, h] in PIXELS, top-left origin (dashboard-native)
      boxNorm:   [x, y, w, h] normalized 0..1 (for the Gemini prompt hints)
    """
    prediction = record.get("prediction") or ""
    name = common_name(prediction)
    species = None if name.lower() in NON_ANIMAL_PREDICTIONS else (name or None)

    detections = []
    for det in record.get("detections", []):
        try:
            conf = float(det.get("conf", 0))
            xmin, ymin, bw, bh = det["bbox"]
        except (KeyError, ValueError, TypeError):
            continue  # malformed entry — skip it, don't sink the response
        category = CATEGORY_LABELS.get(str(det.get("category", "1")), "animal")
        if category == "animal":
            # The ensemble names one species per image; every animal box gets it.
            label = species
        else:
            # MegaDetector's own word for the box ("human"/"vehicle"), if present.
            raw_label = det.get("label")
            label = raw_label.strip() if isinstance(raw_label, str) and raw_label.strip() else None
        detections.append(
            {
                "category": category,
                "label": label,
                "confidence": round(conf, 3),
                "box": [
                    round(xmin * img_w),
                    round(ymin * img_h),
                    round(bw * img_w),
                    round(bh * img_h),
                ],
                "boxNorm": [round(v, 6) for v in (xmin, ymin, bw, bh)],
            }
        )

    return {
        "modelVersion": str(record.get("model_version", "")),
        "speciesnetPackage": speciesnet_package,
        "imageWidth": img_w,
        "imageHeight": img_h,
        # Provenance/debug: the raw ensemble answer for the whole image.
        "prediction": prediction,
        "predictionScore": record.get("prediction_score"),
        "predictionSource": record.get("prediction_source"),
        "species": species,
        "detections": detections,
    }
