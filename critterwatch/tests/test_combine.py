"""Unit tests for COCO mapping + SpeciesNet/YOLO detection merging."""
from critterwatch import mapping
from critterwatch.detection import BBox, Detection


def _sp(label, category, conf, box=(0.1, 0.1, 0.2, 0.2), **kw):
    return Detection(BBox(*box), label, category, conf, "animal", conf, **kw)


def _yolo(label, category, conf, box=(0.1, 0.1, 0.2, 0.2)):
    return Detection(BBox(*box), label, category, conf, f"yolo:{label}", conf)


# ---- COCO mapping ----

def test_coco_dog():
    ml = mapping.map_coco("dog")
    assert ml.label == "dog" and ml.category == mapping.DOMESTIC and ml.on_target_list


def test_coco_person():
    assert mapping.map_coco("person").label == "human"


def test_coco_bear():
    assert mapping.map_coco("bear").label == "black bear"


def test_coco_unknown_is_other():
    ml = mapping.map_coco("toaster")
    assert ml.category == mapping.OTHER and ml.on_target_list is False


def test_coco_keep_set():
    assert "dog" in mapping.COCO_KEEP and "car" not in mapping.COCO_KEEP


# ---- IoU ----

def test_iou_identical():
    b = BBox(0.1, 0.1, 0.2, 0.2)
    assert abs(mapping.bbox_iou(b, b) - 1.0) < 1e-9


def test_iou_disjoint():
    assert mapping.bbox_iou(BBox(0, 0, 0.1, 0.1), BBox(0.5, 0.5, 0.1, 0.1)) == 0.0


# ---- combine ----

def test_yolo_dog_beats_speciesnet_human_same_box():
    # the core bug: a dog boxed as "human" by MegaDetector
    box = (0.3, 0.3, 0.2, 0.2)
    sp = [_sp("human", mapping.HUMAN, 0.84, box)]
    yo = [_yolo("dog", mapping.DOMESTIC, 0.6, box)]
    out = mapping.combine_detections(sp, yo)
    assert len(out) == 1
    assert out[0].label == "dog"


def test_speciesnet_coyote_beats_yolo_dog_same_box():
    # a real coyote YOLO mislabels as "dog" must stay "coyote"
    box = (0.3, 0.3, 0.2, 0.2)
    sp = [_sp("coyote", mapping.WILDLIFE, 0.9, box)]
    yo = [_yolo("dog", mapping.DOMESTIC, 0.8, box)]
    out = mapping.combine_detections(sp, yo)
    assert len(out) == 1
    assert out[0].label == "coyote"


def test_non_overlapping_boxes_all_kept():
    sp = [_sp("coyote", mapping.WILDLIFE, 0.9, (0.0, 0.0, 0.2, 0.2))]
    yo = [_yolo("dog", mapping.DOMESTIC, 0.8, (0.6, 0.6, 0.2, 0.2))]
    out = mapping.combine_detections(sp, yo)
    assert len(out) == 2
    assert {d.label for d in out} == {"coyote", "dog"}


def test_yolo_dog_added_when_speciesnet_missed_it():
    # SpeciesNet found a person elsewhere; YOLO adds the dog
    sp = [_sp("human", mapping.HUMAN, 0.8, (0.0, 0.0, 0.2, 0.3))]
    yo = [_yolo("dog", mapping.DOMESTIC, 0.7, (0.5, 0.4, 0.2, 0.2))]
    out = mapping.combine_detections(sp, yo)
    assert {d.label for d in out} == {"human", "dog"}


def test_duplicate_person_not_double_counted():
    box = (0.1, 0.1, 0.2, 0.4)
    sp = [_sp("human", mapping.HUMAN, 0.8, box)]
    yo = [_yolo("human", mapping.HUMAN, 0.9, box)]
    out = mapping.combine_detections(sp, yo)
    assert len(out) == 1
    assert out[0].label == "human"


def test_generic_animal_loses_to_yolo_dog():
    box = (0.3, 0.3, 0.2, 0.2)
    sp = [_sp("animal", mapping.OTHER, 0.5, box, on_target_list=False)]
    yo = [_yolo("dog", mapping.DOMESTIC, 0.4, box)]
    out = mapping.combine_detections(sp, yo)
    assert out[0].label == "dog"
