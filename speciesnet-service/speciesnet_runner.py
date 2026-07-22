"""The one file that touches the actual SpeciesNet model.

In plain words: loading SpeciesNet takes ~30-60 seconds and hundreds of MB of
RAM, so we do it exactly ONCE per container and reuse it for every request.
Everything heavy (torch, the speciesnet package) is imported lazily inside
get_model(), so importing this module stays instant — that keeps /healthz and
the unit tests fast, and lets Cloud Run's startup probe pass before the model
is loaded.
"""

from __future__ import annotations

import functools
import tempfile
from pathlib import Path


@functools.lru_cache(maxsize=1)
def get_model():
    """Load the SpeciesNet ensemble once (detector + classifier + geofence)."""
    from speciesnet import DEFAULT_MODEL, SpeciesNet  # heavy import, kept lazy

    return SpeciesNet(DEFAULT_MODEL, components="all", geofence=True)


def model_loaded() -> bool:
    """True once get_model() has run (without triggering a load)."""
    return get_model.cache_info().currsize == 1


def run_prediction(image_bytes: bytes, country: str = "USA", admin1_region: str = "CA") -> dict:
    """Run the ensemble on one JPEG and return its raw prediction record.

    predict() takes file paths, not bytes, so we park the image in a temp file
    for the duration of the call. Geofencing (country/region) sharply improves
    species accuracy by ruling out animals that don't occur here.
    """
    model = get_model()
    with tempfile.TemporaryDirectory(prefix="speciesnet-") as td:
        frame = Path(td) / "frame.jpg"
        frame.write_bytes(image_bytes)
        result = model.predict(
            filepaths=[str(frame)],
            country=country,
            admin1_region=admin1_region,
            run_mode="single_thread",  # one image at a time; no pool overhead
            progress_bars=False,
        )
    predictions = (result or {}).get("predictions") or []
    if not predictions:
        raise RuntimeError("SpeciesNet returned no prediction record")
    return predictions[0]
