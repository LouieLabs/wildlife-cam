"""Unit tests for the label-mapping layer (mapping.py)."""
from critterwatch import mapping


def _label(prediction: str) -> str:
    return mapping.map_taxon(prediction).label


def test_coyote_real_speciesnet_string():
    # exact string observed from the real ensemble run
    pred = "aaf3b049-36e6-46dd-9a07-8a580e9618b7;mammalia;carnivora;canidae;canis;latrans;coyote"
    ml = mapping.map_taxon(pred)
    assert ml.label == "coyote"
    assert ml.category == mapping.WILDLIFE
    assert ml.on_target_list is True


def test_mule_deer_by_common_name():
    pred = "uuid;mammalia;artiodactyla;cervidae;odocoileus;hemionus;mule deer"
    assert _label(pred) == "black-tailed (mule) deer"


def test_mountain_lion_by_binomial():
    pred = "uuid;mammalia;carnivora;felidae;puma;concolor;cougar"
    assert _label(pred) == "mountain lion"


def test_domestic_dog_is_domestic_category():
    pred = "uuid;mammalia;carnivora;canidae;canis;familiaris;domestic dog"
    ml = mapping.map_taxon(pred)
    assert ml.label == "dog"
    assert ml.category == mapping.DOMESTIC


def test_human_maps_to_human():
    ml = mapping.map_detection("human", None)
    assert ml.label == "human"
    assert ml.category == mapping.HUMAN


def test_generic_bird_catch_all():
    pred = "uuid;aves;;;;;bird"
    ml = mapping.map_taxon(pred)
    assert ml.label == "bird (any)"
    assert ml.category == mapping.WILDLIFE


def test_specific_bird_before_generic():
    # a raven is not on the target list -> kept verbatim and tagged OTHER,
    # NOT swallowed by the generic "bird (any)" rule's class match... but note
    # aves class WOULD match generic bird; ensure we still surface it as bird.
    pred = "uuid;aves;passeriformes;corvidae;corvus;corax;common raven"
    ml = mapping.map_taxon(pred)
    # corvus corax isn't a named target; the generic bird rule applies (class aves)
    assert ml.label == "bird (any)"
    assert ml.on_target_list is True


def test_off_list_species_kept_verbatim_and_other():
    # an elephant is plainly not on the list and not a bird/rodent catch-all
    pred = "uuid;mammalia;proboscidea;elephantidae;loxodonta;africana;african bush elephant"
    ml = mapping.map_taxon(pred)
    assert ml.label == "african bush elephant"   # verbatim
    assert ml.category == mapping.OTHER
    assert ml.on_target_list is False


def test_rat_by_genus():
    pred = "uuid;mammalia;rodentia;muridae;rattus;norvegicus;brown rat"
    ml = mapping.map_taxon(pred)
    assert ml.label == "rat (Rattus spp.)"
    assert ml.category == mapping.WILDLIFE


def test_woodrat_specific_before_generic_rodent():
    pred = "uuid;mammalia;rodentia;cricetidae;neotoma;fuscipes;dusky-footed woodrat"
    assert _label(pred) == "dusky-footed woodrat"


def test_generic_rodent_catch_all():
    pred = "uuid;mammalia;rodentia;;;;rodent"
    ml = mapping.map_taxon(pred)
    assert ml.label == "rodent (any other)"
    assert ml.on_target_list is True


def test_blank_is_not_drawn():
    ml = mapping.map_taxon(";;;;;;blank")
    assert ml.category == mapping.BLANK
    assert ml.on_target_list is False


def test_vehicle_category():
    ml = mapping.map_detection("vehicle", None)
    assert ml.category == mapping.VEHICLE
    assert ml.label == "vehicle"


def test_animal_box_without_prediction_kept():
    ml = mapping.map_detection("animal", None)
    assert ml.label == "animal"
    assert ml.on_target_list is False  # unknown species, but still surfaced


def test_parse_taxon_handles_sparse_string():
    t = mapping.parse_taxon(";aves;;;;;bird")
    assert t.klass == "aves"
    assert t.common == "bird"
    assert t.binomial == ""


def test_parse_taxon_single_token():
    t = mapping.parse_taxon("animal")
    assert t.common == "animal"
