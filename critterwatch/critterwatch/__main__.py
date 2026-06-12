"""critterwatch command-line entry point.

    python -m critterwatch                      # watch ./input -> ./output
    python -m critterwatch --scan-existing       # also process the backlog first
    python -m critterwatch process some.jpg      # run one file and exit

Runs with zero arguments: every option has a working default.
"""
from __future__ import annotations

import argparse
import logging
from pathlib import Path

from .config import Config

# Project root = the folder that contains this package ("next to the script").
BASE_DIR = Path(__file__).resolve().parent.parent


def _build_parser() -> argparse.ArgumentParser:
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--watch-dir", type=Path, default=None,
                        help="folder to watch (default: ./input next to the script)")
    common.add_argument("--output-dir", type=Path, default=None,
                        help="folder for annotated files + logs (default: ./output)")
    common.add_argument("--config", type=Path, default=None,
                        help="config.yaml path (default: ./config.yaml; auto-created)")
    common.add_argument("--device", choices=["auto", "cuda", "mps", "cpu"], default=None)
    common.add_argument("--frame-sample-fps", type=float, default=None)
    common.add_argument("--detector-confidence", type=float, default=None)
    common.add_argument("--classifier-confidence", type=float, default=None)
    common.add_argument("--scan-existing", action="store_true",
                        help="process existing files in the watch folder on startup")

    parser = argparse.ArgumentParser(
        prog="critterwatch", parents=[common],
        description="Watch a folder and run MegaDetector + SpeciesNet on new captures.")
    sub = parser.add_subparsers(dest="command")
    proc = sub.add_parser("process", parents=[common],
                          help="process a single file directly, then exit")
    proc.add_argument("path", type=Path, help="image or video to process")
    return parser


def _load_config(args: argparse.Namespace) -> tuple[Config, Path, Path]:
    config_path = args.config or (BASE_DIR / "config.yaml")
    cfg = Config.load(config_path)
    cfg.apply_overrides(
        device=args.device,
        frame_sample_fps=args.frame_sample_fps,
        detector_confidence_threshold=args.detector_confidence,
        classifier_confidence_threshold=args.classifier_confidence,
    )
    watch_dir = (args.watch_dir or (BASE_DIR / "input")).resolve()
    output_dir = (args.output_dir or (BASE_DIR / "output")).resolve()
    watch_dir.mkdir(parents=True, exist_ok=True)
    output_dir.mkdir(parents=True, exist_ok=True)
    return cfg, watch_dir, output_dir


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    args = _build_parser().parse_args(argv)
    cfg, watch_dir, output_dir = _load_config(args)

    print("[critterwatch] starting")
    print(f"[critterwatch] watch  dir: {watch_dir}")
    print(f"[critterwatch] output dir: {output_dir}")
    print(f"[critterwatch] geofence : country={cfg.country} state={cfg.state}")

    # Import here so --help / arg errors don't pay the heavy import cost.
    from .pipeline import EnsembleRunner, Logger, process_file
    from .watcher import Ledger, run_watch

    runner = EnsembleRunner(cfg)
    logger = Logger(output_dir)

    if args.command == "process":
        target = args.path.resolve()
        if not target.exists():
            print(f"[critterwatch] no such file: {target}")
            return 2
        process_file(target, runner, cfg, output_dir, logger)
        print(f"[critterwatch] done. See {output_dir}")
        return 0

    ledger = Ledger(output_dir / "ledger.sqlite3")
    try:
        run_watch(cfg, watch_dir, lambda p: process_file(p, runner, cfg, output_dir, logger),
                  ledger, scan_existing=args.scan_existing)
    finally:
        ledger.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
