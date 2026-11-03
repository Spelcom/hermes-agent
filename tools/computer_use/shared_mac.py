"""One native Mac desktop is shared by every Hermes profile and worker process.

The OS lock serializes individual driver calls; it releases on exceptions and process death.
Only public ownership metadata is written to disk. Screens and action arguments never are.
"""
from __future__ import annotations

import contextlib
import json
import os
import stat
import sys
import time
from pathlib import Path
from typing import Iterator


class DesktopBusy(RuntimeError):
    """Another process is already observing or operating the shared desktop."""


def _uid() -> int:
    getuid = getattr(os, "getuid", None)
    if getuid is None:
        raise RuntimeError("Native Mac desktop coordination requires a POSIX user")
    return getuid()


def _state_dir() -> Path:
    # Machine/user coordination deliberately does not follow the active profile's HERMES_HOME.
    # A profile can customize TMPDIR; the physical desktop must still have one lock.
    return Path("/tmp") / f"hermes-mac-computer-{_uid()}"  # no-tmp: ok -- cross-process OS-seat coordination


def _open_lock() -> int:
    directory = _state_dir()
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    info = directory.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != _uid():
        raise RuntimeError("Shared desktop state directory is not owned by this user")
    directory.chmod(0o700)
    fd = os.open(directory / "control.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    os.fchmod(fd, 0o600)
    return fd


def _write_owner(value: dict | None) -> None:
    path = _state_dir() / "owner.json"
    temp = path.with_suffix(f".{os.getpid()}.tmp")
    fd = os.open(temp, os.O_CREAT | os.O_TRUNC | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(value, handle)
    os.replace(temp, path)


def owner() -> dict:
    """Current holder, verified against the live OS lock rather than a stale PID file."""
    import fcntl

    fd = _open_lock()
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            try:
                value = json.loads((_state_dir() / "owner.json").read_text(encoding="utf-8-sig"))
            except (OSError, ValueError):
                value = None
            return {"busy": True, "owner": value if isinstance(value, dict) else None}
        return {"busy": False, "owner": None}
    finally:
        os.close(fd)


@contextlib.contextmanager
def control(*, profile: str, session_id: str, action: str) -> Iterator[None]:
    """Try one call without queuing stale input behind another worker's screen changes."""
    import fcntl

    fd = _open_lock()
    acquired = False
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise DesktopBusy("The shared Mac is busy with another worker; observe fresh state before retrying") from exc
        acquired = True
        _write_owner({"profile": profile[:128], "session_id": session_id[:160],
                      "action": action[:64], "since": time.time()})
        yield
    finally:
        try:
            if acquired:
                _write_owner(None)
        finally:
            os.close(fd)


def native_control(*, backend, session_id: str, action: str):
    """Serialize the native Cua driver; plugins and sandbox backends keep their own realms."""
    if sys.platform != "darwin":
        return contextlib.nullcontext()
    from tools.computer_use.cua_backend import CuaDriverBackend
    if not isinstance(backend, CuaDriverBackend):
        return contextlib.nullcontext()
    from tools.bot_desktop import placement, runtime
    if placement.resolve().where != placement.GATEWAY or runtime.published_env().get("DISPLAY"):
        return contextlib.nullcontext()
    return control(profile=runtime._profile_name(), session_id=session_id, action=action)
