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
