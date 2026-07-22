"""Tests for the pure parsing helpers + the Flask routes (model faked).

Runs anywhere in under a second: no torch, no weights, no network. The
fixture is a REAL prediction record from a real camera frame (a person at a
desk — the exact photo lives in the maintainer's test set), so the pixel math
asserts against numbers SpeciesNet actually produced.
"""

import io
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import parsing  # noqa: E402

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "predictions_sample.json").read_text())


# ---------- common_name ----------

def test_common_name_full_taxonomy():
    assert parsing.common_name(
        "uuid;mammalia;cetartiodactyla;cervidae;odocoileus;hemionus;mule deer"
    ) == "mule deer"


def test_common_name_single_token():
    assert parsing.common_name("animal") == "animal"


def test_common_name_empty():
    assert parsing.common_name("") == ""


def test_common_name_sparse_blank_form():
    # Real "blank" predictions look like 'uuid;;;;;;blank' — empty middle fields.
    assert parsing.common_name("f1856211-cfb7-4a5b-9158-c0f72fd09ee6;;;;;;blank") == "blank"


# ---------- record_to_response ----------

def test_real_record_pixel_math_and_shape():
    resp = parsing.record_to_response(FIXTURE, 640, 480, speciesnet_package="5.0.5")

    assert resp["modelVersion"] == "4.0.3a"
    assert resp["speciesnetPackage"] == "5.0.5"
    assert resp["imageWidth"] == 640 and resp["imageHeight"] == 480
    assert resp["species"] == "human"
    assert resp["predictionSource"] == "detector"

    person, vehicle = resp["detections"]
    assert person["category"] == "person"
    assert person["label"] == "human"
    assert person["confidence"] == 0.705
    # 0.6875*640=440, 0.0*480=0, 0.3125*640=200, 0.3979*480=190.99→191
    assert person["box"] == [440, 0, 200, 191]
    assert person["boxNorm"] == [0.6875, 0.0, 0.3125, 0.3979]

    assert vehicle["category"] == "vehicle"
    assert vehicle["label"] == "vehicle"
    assert vehicle["box"] == [0, 0, 640, 480]


def test_no_confidence_filtering_faint_detections_survive():
    # The privacy gate upstream needs RAW output: a 0.05 person must come through.
    record = {
        "prediction": "uuid;;;;;;blank",
        "detections": [{"category": "2", "conf": 0.05, "bbox": [0.1, 0.1, 0.2, 0.2]}],
        "model_version": "4.0.3a",
    }
    resp = parsing.record_to_response(record, 100, 100)
    assert len(resp["detections"]) == 1
    assert resp["detections"][0]["confidence"] == 0.05


def test_blank_prediction_gives_null_species_and_null_animal_label():
    record = {
        "prediction": "f1856211-cfb7-4a5b-9158-c0f72fd09ee6;;;;;;blank",
        "detections": [{"category": "1", "conf": 0.4, "bbox": [0.0, 0.0, 0.5, 0.5]}],
        "model_version": "4.0.3a",
    }
    resp = parsing.record_to_response(record, 200, 100)
    assert resp["species"] is None
    assert resp["detections"][0]["category"] == "animal"
    assert resp["detections"][0]["label"] is None
    assert resp["detections"][0]["box"] == [0, 0, 100, 50]


def test_animal_box_gets_species_common_name():
    record = {
        "prediction": "uuid;mammalia;carnivora;procyonidae;procyon;lotor;raccoon",
        "detections": [{"category": "1", "conf": 0.88, "bbox": [0.25, 0.5, 0.5, 0.4]}],
        "model_version": "4.0.3a",
    }
    resp = parsing.record_to_response(record, 640, 480)
    assert resp["species"] == "raccoon"
    assert resp["detections"][0]["label"] == "raccoon"
    assert resp["detections"][0]["box"] == [160, 240, 320, 192]


def test_malformed_bbox_skipped_not_fatal():
    record = {
        "prediction": "uuid;;;;;;unknown",
        "detections": [
            {"category": "1", "conf": 0.9, "bbox": [0.1, 0.1]},  # wrong arity
            {"category": "1", "conf": 0.8},                        # missing bbox
            {"category": "1", "conf": 0.7, "bbox": [0.0, 0.0, 1.0, 1.0]},
        ],
        "model_version": "4.0.3a",
    }
    resp = parsing.record_to_response(record, 10, 10)
    assert len(resp["detections"]) == 1
    assert resp["detections"][0]["confidence"] == 0.7


def test_unknown_category_defaults_to_animal():
    record = {
        "prediction": "uuid;;;;;;unknown",
        "detections": [{"category": "9", "conf": 0.5, "bbox": [0, 0, 1, 1]}],
    }
    resp = parsing.record_to_response(record, 10, 10)
    assert resp["detections"][0]["category"] == "animal"


# ---------- Flask routes (model monkeypatched — never loaded) ----------

@pytest.fixture()
def client(monkeypatch):
    import app as app_module

    monkeypatch.setattr(app_module.speciesnet_runner, "run_prediction", lambda body, **kw: FIXTURE)
    app_module.app.config["TESTING"] = True
    with app_module.app.test_client() as c:
        yield c


def _tiny_jpeg() -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (640, 480), (10, 20, 30)).save(buf, format="JPEG")
    return buf.getvalue()


def test_healthz_does_not_load_model(client):
    resp = client.get("/healthz")
    assert resp.status_code == 200
    assert resp.get_json() == {"ok": True, "modelLoaded": False}


def test_detect_wrong_content_type_415(client):
    resp = client.post("/detect", data=b"x", content_type="application/json")
    assert resp.status_code == 415


def test_detect_empty_body_400(client):
    resp = client.post("/detect", data=b"", content_type="image/jpeg")
    assert resp.status_code == 400


def test_detect_undecodable_body_400(client):
    resp = client.post("/detect", data=b"not a jpeg at all", content_type="image/jpeg")
    assert resp.status_code == 400


def test_detect_happy_path(client):
    resp = client.post("/detect", data=_tiny_jpeg(), content_type="image/jpeg")
    assert resp.status_code == 200
    body = resp.get_json()
    assert body["species"] == "human"
    assert body["imageWidth"] == 640
    assert [d["category"] for d in body["detections"]] == ["person", "vehicle"]
    assert body["detections"][0]["box"] == [440, 0, 200, 191]


def test_detect_model_error_500(client, monkeypatch):
    import app as app_module

    def boom(body, **kw):
        raise RuntimeError("torch exploded")

    monkeypatch.setattr(app_module.speciesnet_runner, "run_prediction", boom)
    resp = client.post("/detect", data=_tiny_jpeg(), content_type="image/jpeg")
    assert resp.status_code == 500
