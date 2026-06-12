"""Folder watcher: detect new files, wait until stable, dedupe via SQLite, process."""
from __future__ import annotations

import logging
import queue
import shutil
import sqlite3
import threading
import time
from pathlib import Path
from typing import Callable, List, Optional

from watchdog.events import FileSystemEvent, FileSystemEventHandler
from watchdog.observers import Observer

from .config import Config

log = logging.getLogger("critterwatch.watcher")


def wait_for_stable_size(
    path: Path,
    settle_seconds: float = 2.0,
    poll_interval: float = 0.5,
    timeout: float = 120.0,
    _sleep: Callable[[float], None] = time.sleep,
    _now: Callable[[], float] = time.monotonic,
) -> bool:
    """Return True once ``path``'s size has been unchanged for ``settle_seconds``.

    Polls the file size; the moment it stops changing for long enough we assume
    the writer is done. Returns False on timeout or if the file disappears.
    ``_sleep``/``_now`` are injectable to keep this unit-testable.
    """
    deadline = _now() + timeout
    last_size = -1
    stable_since: Optional[float] = None
    while _now() < deadline:
        try:
            size = path.stat().st_size
        except OSError:
            return False
        if size == last_size:
            if stable_since is None:
                stable_since = _now()
            elif _now() - stable_since >= settle_seconds:
                return True
        else:
            last_size = size
            stable_since = None
        _sleep(poll_interval)
    return False


class Ledger:
    """SQLite record of processed files so nothing runs twice."""

    def __init__(self, db_path: Path) -> None:
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(db_path), check_same_thread=False)
        self._lock = threading.Lock()
        self._conn.execute(
            "CREATE TABLE IF NOT EXISTS processed ("
            " path TEXT PRIMARY KEY, size INTEGER, mtime REAL, ts REAL)"
        )
        self._conn.commit()

    def already_done(self, path: Path) -> bool:
        try:
            st = path.stat()
        except OSError:
            return False
        with self._lock:
            row = self._conn.execute(
                "SELECT size, mtime FROM processed WHERE path = ?", (str(path.resolve()),)
            ).fetchone()
        # Re-process if the file changed since we last saw it.
        return bool(row) and row[0] == st.st_size and abs(row[1] - st.st_mtime) < 1e-6

    def mark_done(self, path: Path) -> None:
        try:
            st = path.stat()
            size, mtime = st.st_size, st.st_mtime
        except OSError:
            size, mtime = 0, 0.0
        with self._lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO processed(path, size, mtime, ts) VALUES (?,?,?,?)",
                (str(path.resolve()), size, mtime, time.time()),
            )
            self._conn.commit()

    def close(self) -> None:
        self._conn.close()


class _NewFileHandler(FileSystemEventHandler):
    """Enqueue created/moved files whose extension is watched."""

    def __init__(self, config: Config, sink: "queue.Queue[Path]") -> None:
        self._config = config
        self._sink = sink

    def _maybe_enqueue(self, raw_path: str) -> None:
        path = Path(raw_path)
        if self._config.is_watched(path):
            self._sink.put(path)

    def on_created(self, event: FileSystemEvent) -> None:
        if not event.is_directory:
            self._maybe_enqueue(event.src_path)

    def on_moved(self, event: FileSystemEvent) -> None:
        if not event.is_directory:
            self._maybe_enqueue(event.dest_path)


def run_watch(
    config: Config,
    watch_dir: Path,
    process_fn: Callable[[Path], None],
    ledger: Ledger,
    scan_existing: bool = False,
    settle_seconds: float = 2.0,
) -> None:
    """Watch ``watch_dir`` recursively and run ``process_fn`` on each new file.

    A single worker thread drains the queue so the (expensive) model stays
    loaded once. Errors in ``process_fn`` are logged and never crash the loop.
    """
    work: "queue.Queue[Path]" = queue.Queue()
    stop = threading.Event()

    def worker() -> None:
        while not stop.is_set():
            try:
                path = work.get(timeout=0.5)
            except queue.Empty:
                continue
            try:
                if not path.exists():
                    continue
                if ledger.already_done(path):
                    continue
                if not wait_for_stable_size(path, settle_seconds=settle_seconds):
                    log.warning("file never settled, skipping: %s", path)
                    continue
                process_fn(path)
                ledger.mark_done(path)
            except Exception:  # never let one bad file kill the watcher
                log.exception("error processing %s", path)
            finally:
                work.task_done()

    worker_thread = threading.Thread(target=worker, name="cw-worker", daemon=True)
    worker_thread.start()

    if scan_existing:
        for path in sorted(watch_dir.rglob("*")):
            if path.is_file() and config.is_watched(path):
                work.put(path)

    observer = Observer()
    observer.schedule(_NewFileHandler(config, work), str(watch_dir), recursive=True)
    observer.start()
    log.info("watching %s (recursive). Ctrl-C to stop.", watch_dir)
    try:
        while True:
            time.sleep(1.0)
    except KeyboardInterrupt:
        log.info("stopping...")
    finally:
        stop.set()
        observer.stop()
        observer.join()
        worker_thread.join(timeout=5.0)


# --------------------------------------------------------------------------- #
# Router: move ONLY camera-interface files from Downloads into the camera
# folders. Both Snapshot and Record downloads start with this prefix (set in the
# firmware's snap() / toggleRecord()). Nothing else is ever moved.
# --------------------------------------------------------------------------- #

CAMERA_PREFIX = "wildcam_"


def _unique_path(dest: Path) -> Path:
    """``dest``, or ``dest`` with a numeric suffix if it already exists."""
    if not dest.exists():
        return dest
    stem, suffix, parent = dest.stem, dest.suffix, dest.parent
    i = 1
    while True:
        candidate = parent / f"{stem}_{i}{suffix}"
        if not candidate.exists():
            return candidate
        i += 1


def route_camera_files(
    config: Config,
    downloads: Path,
    images_dir: Path,
    videos_dir: Path,
    settle_seconds: float = 2.0,
) -> List[Path]:
    """Move camera-interface files out of ``downloads`` into the folders.

    A file is moved only if it is a camera file:
      * its name starts with ``wildcam_`` (snapshots; recordings too after a
        firmware re-flash), OR
      * it is a ``.webm`` — the format the Record button always produces,
        regardless of the filename.

    Personal downloads (.jpg without the prefix, .mp4, .mov, PDFs, ...) are never
    touched. The camera is realistically the only source of .webm in Downloads.

    Images go to ``images_dir``, videos to ``videos_dir``. Returns moved paths.
    """
    if not downloads.is_dir():
        return []
    images_dir.mkdir(parents=True, exist_ok=True)
    videos_dir.mkdir(parents=True, exist_ok=True)

    routed: List[Path] = []
    for p in sorted(downloads.iterdir()):
        if not p.is_file():
            continue
        # camera-interface files only: a wildcam_ name OR a .webm recording
        # (.webm is what the Record button always produces, whatever the name).
        is_camera = (p.name.lower().startswith(CAMERA_PREFIX)
                     or p.suffix.lower() == ".webm")
        if not is_camera:
            continue
        if not config.is_watched(p):
            continue
        if not wait_for_stable_size(p, settle_seconds=settle_seconds):
            continue                       # still downloading; catch it next time
        dest_dir = videos_dir if config.is_video(p) else images_dir
        dest = _unique_path(dest_dir / p.name)
        try:
            shutil.move(str(p), str(dest))
        except OSError:
            log.exception("could not move %s", p)
            continue
        routed.append(dest)
        log.info("routed %s -> %s", p.name, dest_dir.name)
    return routed


# --------------------------------------------------------------------------- #
# One-shot scan of the dedicated "Louie Labs" camera folders, used by the macOS
# background agent. SANDBOXED: only ever reads the given input folders and only
# ever writes to ``annotated_dir``. Never moves or modifies originals and never
# looks anywhere else on disk.
# --------------------------------------------------------------------------- #

def scan_camera_folders(
    config: Config,
    input_dirs: List[Path],
    annotated_dir: Path,
    runner_factory: Callable[[Path], Callable[[Path], None]],
    ledger: Ledger,
    settle_seconds: float = 2.0,
) -> List[Path]:
    """Annotate new files sitting in ``input_dirs`` (the camera folders).

    Originals are never moved or modified; annotated copies + JSON sidecars +
    ``detections.csv`` are written to ``annotated_dir``. Already-annotated
    outputs (``*_annotated.*``) and files already in the ledger are skipped, so
    this is safe to re-run. ``runner_factory(annotated_dir)`` builds the
    (expensive) processing callable and is only invoked when there is real work,
    so an unrelated filesystem event does not load the model.
    """
    annotated_dir.mkdir(parents=True, exist_ok=True)

    candidates: List[Path] = []
    for folder in input_dirs:
        if not folder.is_dir():
            continue
        for p in sorted(folder.iterdir()):
            if (p.is_file() and config.is_watched(p)
                    and "_annotated" not in p.stem
                    and not ledger.already_done(p)):
                candidates.append(p)

    ready = [p for p in candidates if wait_for_stable_size(p, settle_seconds=settle_seconds)]
    if not ready:
        return []

    process_fn = runner_factory(annotated_dir)  # loads the model now
    done: List[Path] = []
    for src in ready:
        try:
            process_fn(src)
        except Exception:  # a bad file must not stop the rest
            log.exception("annotate failed for %s", src)
        ledger.mark_done(src)
        done.append(src)
        log.info("annotated %s -> %s", src.name, annotated_dir.name)
    return done
