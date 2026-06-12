"""Configuration loading/saving and runtime compute-device selection."""
from __future__ import annotations

from dataclasses import asdict, dataclass, field, fields
from pathlib import Path
from typing import Any

import yaml

# Extensions we treat as images vs videos.
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".heic"}
VIDEO_EXTENSIONS = {".mp4", ".mov"}
DEFAULT_EXTENSIONS = [".jpg", ".jpeg", ".png", ".heic", ".mp4", ".mov"]


@dataclass
class Config:
    """All tunables. Auto-written to config.yaml on first run; CLI flags override."""

    frame_sample_fps: float = 1.0
    detector_confidence_threshold: float = 0.2
    classifier_confidence_threshold: float = 0.5
    country: str = "USA"
    state: str = "CA"
    watched_extensions: list[str] = field(default_factory=lambda: list(DEFAULT_EXTENSIONS))
    device: str = "auto"  # auto | cuda | mps | cpu

    @classmethod
    def load(cls, path: Path) -> "Config":
        """Load ``config.yaml``; create it with defaults if it does not exist."""
        if not path.exists():
            cfg = cls()
            cfg.save(path)
            return cfg
        data = yaml.safe_load(path.read_text()) or {}
        known = {f.name for f in fields(cls)}
        return cls(**{k: v for k, v in data.items() if k in known})

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(yaml.safe_dump(asdict(self), sort_keys=False))

    def apply_overrides(self, **overrides: Any) -> None:
        """Set any provided (non-None) values, ignoring unknown keys."""
        for key, value in overrides.items():
            if value is not None and hasattr(self, key):
                setattr(self, key, value)

    def is_image(self, path: Path) -> bool:
        return path.suffix.lower() in IMAGE_EXTENSIONS

    def is_video(self, path: Path) -> bool:
        return path.suffix.lower() in VIDEO_EXTENSIONS

    def is_watched(self, path: Path) -> bool:
        return path.suffix.lower() in {e.lower() for e in self.watched_extensions}


def resolve_device(requested: str = "auto") -> str:
    """Choose the compute device.

    Order when ``requested == "auto"``: CUDA (NVIDIA) -> Apple Silicon MPS -> CPU.
    An explicit value other than ``"auto"`` is returned unchanged.
    """
    if requested and requested != "auto":
        return requested
    try:
        import torch
    except Exception:
        return "cpu"
    if torch.cuda.is_available():
        return "cuda"
    mps = getattr(torch.backends, "mps", None)
    if mps is not None and mps.is_available():
        return "mps"
    return "cpu"
