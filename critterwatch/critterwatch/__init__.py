"""critterwatch - watch a folder and run wildlife detection on new captures.

Pipeline: watchdog watcher -> MegaDetector (boxes) + SpeciesNet (species) ->
label mapping -> annotated media + JSON sidecars + detections.csv.
"""
__version__ = "0.1.0"
