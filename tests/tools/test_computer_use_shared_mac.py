"""Native desktop ownership survives multiplexed profiles and process failures."""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

from tools.computer_use import shared_mac


@pytest.mark.platforms("posix")
def test_other_profile_process_cannot_enter_and_crashed_holder_releases(tmp_path, monkeypatch):
    state = tmp_path / "shared"
    monkeypatch.setattr(shared_mac, "_state_dir", lambda: state)
    code = """
import sys
from pathlib import Path
from tools.computer_use import shared_mac
shared_mac._state_dir = lambda: Path(sys.argv[1])
with shared_mac.control(profile='analyst', session_id='same-session', action='click'):
    print('locked', flush=True)
    sys.stdin.readline()
"""
    process = subprocess.Popen([sys.executable, "-c", code, str(state)],
                               cwd=Path(__file__).resolve().parents[2], stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        assert process.stdout.readline() == "locked\n"
        state_now = shared_mac.owner()
        assert state_now["busy"] and state_now["owner"]["profile"] == "analyst"
        with pytest.raises(shared_mac.DesktopBusy):
            with shared_mac.control(profile="developer", session_id="same-session", action="type"):
                pytest.fail("Another profile entered the same physical Mac desktop")
        process.kill()
        process.wait(timeout=5)
        assert shared_mac.owner() == {"busy": False, "owner": None}
        with shared_mac.control(profile="developer", session_id="same-session", action="capture"):
            assert shared_mac.owner()["owner"]["profile"] == "developer"
    finally:
        if process.poll() is None:
            process.kill()
        process.communicate(timeout=5)


@pytest.mark.platforms("posix")
def test_exception_releases_owner_and_state_is_private(tmp_path, monkeypatch):
    state = tmp_path / "shared"
    monkeypatch.setattr(shared_mac, "_state_dir", lambda: state)
    with pytest.raises(ValueError):
        with shared_mac.control(profile="editor", session_id="s", action="capture"):
            assert shared_mac.owner()["busy"]
            raise ValueError("driver failed")
    assert shared_mac.owner() == {"busy": False, "owner": None}
    assert state.stat().st_mode & 0o777 == 0o700
    assert (state / "control.lock").stat().st_mode & 0o777 == 0o600
    assert (state / "owner.json").stat().st_mode & 0o777 == 0o600
    assert "driver failed" not in (state / "owner.json").read_text(encoding="utf-8")


@pytest.mark.platforms("macos")
def test_tool_startup_failure_does_not_hold_shared_mac(tmp_path, monkeypatch):
    from tools.computer_use import tool
    from tools.bot_desktop import lease, runtime

    monkeypatch.setattr(shared_mac, "_state_dir", lambda: tmp_path / "shared")
    monkeypatch.setattr(runtime, "ensure_started_for_tool", lambda: None)
    monkeypatch.setattr(runtime, "published_env", dict)
    monkeypatch.setattr(tool, "_get_backend", lambda **kw: (_ for _ in ()).throw(RuntimeError("startup failed")))
    monkeypatch.setattr(lease, "assert_agent_may_act", lambda: lease.Lease())
    result = tool.handle_computer_use({"action": "capture"}, session_id="same-session")
    assert "startup failed" in result
    assert shared_mac.owner() == {"busy": False, "owner": None}


@pytest.mark.platforms("macos")
def test_only_real_native_driver_claims_the_physical_desktop(tmp_path, monkeypatch):
    from tools.bot_desktop import runtime
    from tools.computer_use.cua_backend import CuaDriverBackend

    monkeypatch.setattr(shared_mac, "_state_dir", lambda: tmp_path / "shared")
    monkeypatch.setattr(runtime, "published_env", dict)
    with shared_mac.native_control(backend=object(), session_id="fake", action="capture"):
        assert not shared_mac.owner()["busy"]
    backend = CuaDriverBackend(permission_mode="standard")
    with shared_mac.native_control(backend=backend, session_id="native", action="capture"):
        assert shared_mac.owner()["owner"]["session_id"] == "native"
    assert not shared_mac.owner()["busy"]


@pytest.mark.parametrize("explicit_no_acquire", [True, False])
def test_read_only_monitor_and_profile_opt_out_never_install_runtime(monkeypatch, explicit_no_acquire):
    import pm
    from tools.computer_use import cua_backend

    def unexpected_install(*args, **kwargs):
        pytest.fail("A runtime install/update was attempted")
    monkeypatch.setattr(pm, "ensure", unexpected_install)
    monkeypatch.setattr(pm, "ensure_import", unexpected_install)
    monkeypatch.setattr(cua_backend, "_computer_use_cfg", lambda: {"allow_runtime_install": explicit_no_acquire})
    monkeypatch.setattr(cua_backend, "sandbox_mcp_invocation", lambda: None)
    monkeypatch.setattr(cua_backend, "cua_driver_runtime_contract_status", lambda: {"ready": True})
    backend = cua_backend.CuaDriverBackend(permission_mode="standard")
    monkeypatch.setattr(backend._session, "start", lambda: None)
    monkeypatch.setattr(backend._session, "call_tool", lambda *args, **kwargs: {})
    backend.start(acquire_runtime=not explicit_no_acquire)


def test_driver_children_always_disable_background_update_checks(monkeypatch):
    from tools.bot_desktop import runtime
    from tools.computer_use.cua_backend import cua_driver_child_env

    monkeypatch.setattr(runtime, "desktop_env", lambda env: env)
    child = cua_driver_child_env({"CUA_DRIVER_RS_UPDATE_CHECK": "true", "UNCHANGED": "yes"})
    assert child["CUA_DRIVER_RS_UPDATE_CHECK"] == "false"
    assert child["UNCHANGED"] == "yes"


@pytest.mark.platforms("macos")
def test_native_profiles_share_human_authority_and_epoch_but_custom_and_sandbox_do_not(tmp_path, monkeypatch):
    import json
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override
    from tools.bot_desktop import lease, runtime
    from tools.computer_use import tool

    monkeypatch.setattr(runtime, "published_env", dict)
    monkeypatch.setattr(runtime, "ensure_started_for_tool", lambda: None)
    homes = [tmp_path / name for name in ("default", "analyst", "developer", "researcher", "writer")]
    custom, sandbox = tmp_path / "custom", tmp_path / "sandbox"
    for home in [*homes, custom, sandbox]:
        home.mkdir()
        cfg = {"computer_use": {"backend": "fake" if home == custom else "cua"},
               "terminal": {"backend": "docker" if home == sandbox else "local"}}
        # default backend selection must share the seat even without an explicit config key.
        if home == homes[0]:
            cfg.pop("computer_use")
        (home / "config.yaml").write_text(json.dumps(cfg), encoding="utf-8")
    seat = lease._path(str(homes[0]))
    assert all(lease._path(str(home)) == seat for home in homes)
    assert lease._path(str(custom)) == custom / "bot-desktop" / "lease.json"
    assert lease._path(str(sandbox)) == sandbox / "bot-desktop" / "lease.json"
    admitted = lease.assert_agent_may_act(str(homes[-1]))
    lease.acquire("human", profile_key=str(homes[0]))
    monkeypatch.setattr(tool, "_get_backend", lambda **kw: pytest.fail("Human-held seat reached the driver"))
    for home in homes:
        token = set_hermes_home_override(str(home))
        try:
            for action in ("capture", "type"):
                assert json.loads(tool.handle_computer_use({"action": action, "text": "secret"}))["code"] == "human_has_control"
        finally:
            reset_hermes_home_override(token)
    assert lease.assert_agent_may_act(str(custom)).holder == lease.AGENT
    assert lease.assert_agent_may_act(str(sandbox)).holder == lease.AGENT
    lease.release("human", profile_key=str(homes[1]))
    assert all(lease.get(str(home)).epoch != admitted.epoch for home in homes)
    import contextlib
    monkeypatch.setattr(tool, "_backend_for_call", lambda *args: contextlib.nullcontext(tool._NoopBackend()))
    def take_over_in_another_profile(*args, **kwargs):
        lease.acquire("human", profile_key=str(homes[1]))
        lease.release("human", profile_key=str(homes[1]))
        return "PRIVATE_FRAME"
    monkeypatch.setattr(tool, "_dispatch", take_over_in_another_profile)
    token = set_hermes_home_override(str(homes[-1]))
    try:
        result = tool.handle_computer_use({"action": "capture"})
        assert json.loads(result)["code"] == "human_has_control" and "PRIVATE_FRAME" not in result
    finally:
        reset_hermes_home_override(token)
    assert seat.parent.stat().st_mode & 0o777 == 0o700
    assert seat.stat().st_mode & 0o777 == 0o600
    assert seat.with_suffix(".lock").stat().st_mode & 0o777 == 0o600
