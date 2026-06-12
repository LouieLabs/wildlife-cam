"""Unit tests for the file-stability check (watcher.wait_for_stable_size)."""
from pathlib import Path

from critterwatch.watcher import wait_for_stable_size


class FakeClock:
    """Deterministic monotonic clock + sleep that advances it."""

    def __init__(self) -> None:
        self.t = 0.0

    def now(self) -> float:
        return self.t

    def sleep(self, dt: float) -> None:
        self.t += dt


def test_stable_file_returns_true(tmp_path: Path):
    f = tmp_path / "done.jpg"
    f.write_bytes(b"x" * 100)  # never changes
    clock = FakeClock()
    assert wait_for_stable_size(f, settle_seconds=2.0, poll_interval=0.5,
                                _sleep=clock.sleep, _now=clock.now) is True


def test_growing_then_stable_file(tmp_path: Path):
    f = tmp_path / "writing.jpg"
    f.write_bytes(b"x" * 10)
    clock = FakeClock()
    state = {"writes": 0}
    real_sleep = clock.sleep

    def grow_then_settle(dt: float) -> None:
        # grow the file for the first few polls, then leave it alone
        state["writes"] += 1
        if state["writes"] <= 3:
            with f.open("ab") as fh:
                fh.write(b"x" * 10)
        real_sleep(dt)

    assert wait_for_stable_size(f, settle_seconds=2.0, poll_interval=0.5,
                                _sleep=grow_then_settle, _now=clock.now) is True
    # it should have grown 3 times before settling
    assert state["writes"] >= 3


def test_missing_file_returns_false(tmp_path: Path):
    f = tmp_path / "nope.jpg"
    clock = FakeClock()
    assert wait_for_stable_size(f, settle_seconds=2.0, poll_interval=0.5,
                                _sleep=clock.sleep, _now=clock.now) is False


def test_constantly_growing_file_times_out(tmp_path: Path):
    f = tmp_path / "forever.jpg"
    f.write_bytes(b"x")
    clock = FakeClock()

    def keep_growing(dt: float) -> None:
        with f.open("ab") as fh:
            fh.write(b"x" * 5)
        clock.t += dt

    assert wait_for_stable_size(f, settle_seconds=2.0, poll_interval=0.5, timeout=10.0,
                                _sleep=keep_growing, _now=clock.now) is False
