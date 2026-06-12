"""Folder watcher: detect new files, wait until stable, dedupe via SQLite, process."""
from __future__ import annotations

import logging
import queue
import sqlite3
import threading
import time
from pathlib import Path
from typing import Callable, Optional

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
