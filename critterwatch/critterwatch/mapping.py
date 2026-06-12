"""Map SpeciesNet taxonomy predictions onto critterwatch's target label set.

SpeciesNet ensemble predictions are semicolon-delimited, general -> specific::

    "<uuid>;<class>;<order>;<family>;<genus>;<species>;<common_name>"

with sparse variants such as ``";;;;;;blank"``, ``";;;;;;animal"`` or
``";mammalia;rodentia;;;;rodent"``. The last field is the most specific common
name available. This module turns such a string (plus the MegaDetector category)
into a display label, a colour/grouping category, and an on-target flag.

Rule: a detection is NEVER dropped. Anything not on the curated target list is
labelled with its taxon verbatim and tagged ``OTHER``.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from .detection import BBox, Detection

# Colour / grouping buckets (consumed by render.py).
HUMAN = "human"        # red
DOMESTIC = "domestic"  # dog, cat -> blue
WILDLIFE = "wildlife"  # green
OTHER = "other"        # yellow
VEHICLE = "vehicle"    # gray
BLANK = "blank"        # not drawn


@dataclass
class MappedLabel:
    label: str
    category: str
    on_target_list: bool


@dataclass
class Taxon:
    """Parsed SpeciesNet prediction string."""

    uuid: str
    klass: str
    order: str
    family: str
    genus: str
    species: str
    common: str
    raw: str

    @property
    def binomial(self) -> str:
        return f"{self.genus} {self.species}".strip()


def parse_taxon(prediction: str) -> Taxon:
    """Parse a SpeciesNet prediction string into a :class:`Taxon` (lower-cased)."""
    raw = prediction or ""
    parts = [p.strip().lower() for p in raw.split(";")]
    while len(parts) < 7:
        parts.append("")
    uuid, klass, order, family, genus, species, common = parts[:7]
    # Single-token labels with no ';' (e.g. "animal", "human") land in `uuid`.
    if ";" not in raw and raw.strip():
        uuid, common = "", raw.strip().lower()
    return Taxon(uuid, klass, order, family, genus, species, common, raw)


def _common_has(*subs: str) -> Callable[[Taxon], bool]:
    return lambda t: any(s in t.common for s in subs)


def _is_binomial(*names: str) -> Callable[[Taxon], bool]:
    targets = {n.lower() for n in names}
    return lambda t: t.binomial in targets


def _any(*preds: Callable[[Taxon], bool]) -> Callable[[Taxon], bool]:
    return lambda t: any(p(t) for p in preds)


# Ordered rules: (canonical_label, category, predicate). First match wins, so
# specific species precede the generic "bird"/"rodent" catch-alls.
_RULES: list[tuple[str, str, Callable[[Taxon], bool]]] = [
    ("human", HUMAN, _any(_common_has("human", "person"), _is_binomial("homo sapiens"))),
    ("dog", DOMESTIC, _any(_common_has("domestic dog"), _is_binomial("canis familiaris", "canis lupus familiaris"),
                           lambda t: t.common == "dog")),
    ("domestic cat", DOMESTIC, _any(_common_has("domestic cat"), _is_binomial("felis catus"),
                                    lambda t: t.common == "cat")),
    ("black-tailed (mule) deer", WILDLIFE,
     _any(_common_has("mule deer", "black-tailed deer", "black tailed deer"),
          _is_binomial("odocoileus hemionus"))),
    ("mountain lion", WILDLIFE,
     _any(_common_has("mountain lion", "puma", "cougar"), _is_binomial("puma concolor"))),
    ("bobcat", WILDLIFE, _any(_common_has("bobcat"), _is_binomial("lynx rufus"))),
    ("coyote", WILDLIFE, _any(_common_has("coyote"), _is_binomial("canis latrans"))),
    ("gray fox", WILDLIFE,
     _any(_common_has("gray fox", "grey fox"), _is_binomial("urocyon cinereoargenteus"))),
    ("raccoon", WILDLIFE, _any(_common_has("raccoon"), _is_binomial("procyon lotor"))),
    ("striped skunk", WILDLIFE, _any(_common_has("striped skunk"), _is_binomial("mephitis mephitis"))),
    ("Virginia opossum", WILDLIFE,
     _any(_common_has("virginia opossum", "opossum"), _is_binomial("didelphis virginiana"))),
    ("brush rabbit", WILDLIFE, _any(_common_has("brush rabbit"), _is_binomial("sylvilagus bachmani"))),
    ("black-tailed jackrabbit", WILDLIFE,
     _any(_common_has("black-tailed jackrabbit", "black tailed jackrabbit", "jackrabbit"),
          _is_binomial("lepus californicus"))),
    ("western gray squirrel", WILDLIFE,
     _any(_common_has("western gray squirrel", "western grey squirrel"), _is_binomial("sciurus griseus"))),
    ("California ground squirrel", WILDLIFE,
     _any(_common_has("california ground squirrel"),
          _is_binomial("otospermophilus beecheyi", "spermophilus beecheyi"))),
    ("dusky-footed woodrat", WILDLIFE,
     _any(_common_has("dusky-footed woodrat", "dusky footed woodrat", "woodrat"),
          _is_binomial("neotoma fuscipes"))),
    ("rat (Rattus spp.)", WILDLIFE, _any(_common_has("rat"), lambda t: t.genus == "rattus")),
    ("wild pig", WILDLIFE,
     _any(_common_has("wild pig", "wild boar", "feral pig", "feral hog", "wild hog"),
          _is_binomial("sus scrofa"))),
    ("black bear", WILDLIFE,
     _any(_common_has("black bear", "american black bear"), _is_binomial("ursus americanus"))),
    ("wild turkey", WILDLIFE, _any(_common_has("wild turkey", "turkey"), _is_binomial("meleagris gallopavo"))),
    # generic catch-alls (still on the target list):
    ("bird (any)", WILDLIFE, lambda t: t.klass == "aves" or t.common == "bird"),
    ("rodent (any other)", WILDLIFE, lambda t: t.order == "rodentia" or t.common == "rodent"),
]


def map_taxon(prediction: str) -> MappedLabel:
    """Map a SpeciesNet prediction string to a :class:`MappedLabel`."""
    taxon = parse_taxon(prediction)

    if taxon.common in ("blank", ""):
        return MappedLabel("blank", BLANK, False)
    if taxon.common in ("no cv result", "no_cv_result", "unknown"):
        return MappedLabel(taxon.common, OTHER, False)

    for label, category, predicate in _RULES:
        if predicate(taxon):
            return MappedLabel(label, category, True)

    # Not on the curated list: keep the most specific name we have, verbatim.
    verbatim = taxon.common or taxon.binomial or "animal"
    return MappedLabel(verbatim, OTHER, False)


def map_detection(det_category: str, prediction: str | None) -> MappedLabel:
    """Map a MegaDetector box (+ optional SpeciesNet taxon) to a label.

    ``det_category`` is MegaDetector's class: ``animal``/``1``, ``human``/``2``
    or ``vehicle``/``3``. Human and vehicle boxes are labelled directly; animal
    boxes defer to the SpeciesNet taxonomy.
    """
    dc = (det_category or "").strip().lower()
    if dc in ("human", "person", "2"):
        return MappedLabel("human", HUMAN, True)
    if dc in ("vehicle", "3"):
        return MappedLabel("vehicle", VEHICLE, False)
    if prediction:
        return map_taxon(prediction)
    return MappedLabel("animal", OTHER, False)


# --------------------------------------------------------------------------- #
# YOLO (COCO) label mapping + merging YOLO detections with SpeciesNet's.
# --------------------------------------------------------------------------- #

# COCO classes we keep, mapped to (label, category). Everything else (cars,
# furniture, ...) is ignored by the YOLO runner.
_COCO_MAP: dict[str, tuple[str, str]] = {
    "person": ("human", HUMAN),
    "dog": ("dog", DOMESTIC),
    "cat": ("domestic cat", DOMESTIC),
    "bird": ("bird (any)", WILDLIFE),
    "bear": ("black bear", WILDLIFE),
    # other COCO animals: unlikely locally, but label rather than drop.
    "horse": ("horse", OTHER),
    "cow": ("cow", OTHER),
    "sheep": ("sheep", OTHER),
    "elephant": ("elephant", OTHER),
    "zebra": ("zebra", OTHER),
    "giraffe": ("giraffe", OTHER),
}
COCO_KEEP = set(_COCO_MAP)


def map_coco(coco_label: str) -> MappedLabel:
    """Map a COCO class name (e.g. ``"dog"``) to a :class:`MappedLabel`."""
    label, category = _COCO_MAP.get(coco_label.strip().lower(), (coco_label, OTHER))
    return MappedLabel(label, category, on_target_list=(category != OTHER))


# Labels that are generic (not a specific species) — they lose to anything specific.
_GENERIC_LABELS = {"animal"}


def bbox_iou(a: BBox, b: BBox) -> float:
    """Intersection-over-union of two normalized [x, y, w, h] boxes."""
    ax2, ay2, bx2, by2 = a.x + a.w, a.y + a.h, b.x + b.w, b.y + b.h
    ix1, iy1 = max(a.x, b.x), max(a.y, b.y)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
    union = a.w * a.h + b.w * b.h - inter
    return inter / union if union > 0 else 0.0


def _priority_speciesnet(d: Detection) -> int:
    # SpeciesNet's strength is naming specific wild species; trust that most.
    if d.category == WILDLIFE and d.label not in _GENERIC_LABELS:
        return 4
    if d.label == "human":
        return 2
    if d.label == "animal":
        return 1
    return 2


def _priority_yolo(d: Detection) -> int:
    # YOLO's strength is dog/cat/person/bird/bear up close.
    if d.category in (DOMESTIC, HUMAN, WILDLIFE):
        return 3
    return 1  # other COCO animal (horse/cow/...)


def combine_detections(
    speciesnet_dets: list[Detection],
    yolo_dets: list[Detection],
    iou_threshold: float = 0.45,
) -> list[Detection]:
    """Merge SpeciesNet + YOLO detections, keeping the more trustworthy label.

    Priority: a specific wild species from SpeciesNet > dog/cat/person/bird from
    YOLO > a generic "human" box > a generic "animal" box. Detections are taken
    highest-priority first; a lower-priority box overlapping an already-kept one
    (IoU >= ``iou_threshold``) is dropped as a duplicate.

    So a pet dog YOLO sees becomes "dog" even when SpeciesNet said "human" /
    "animal"; a real coyote SpeciesNet identifies stays "coyote" even when YOLO
    called it "dog".
    """
    ranked = [(_priority_speciesnet(d), d) for d in speciesnet_dets]
    ranked += [(_priority_yolo(d), d) for d in yolo_dets]
    ranked.sort(key=lambda pd: (pd[0], pd[1].confidence), reverse=True)

    kept: list[Detection] = []
    for _, d in ranked:
        if all(bbox_iou(d.bbox, k.bbox) < iou_threshold for k in kept):
            kept.append(d)
    return kept
