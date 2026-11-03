"""Subscription voice stays on normal CLI login and its inert, owned backing thread."""

import asyncio
import json

import pytest

from tools import voice_live, voice_live_codex as codex


class FakeServer:
    account_type = "chatgpt"
    fail_start = False
    emit_answer = True

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.workdir = "/empty-voice-cwd"
        self.notifications = asyncio.Queue()
        self.requests = []
        self.closed = False

    async def start(self):
        pass

    async def request(self, method, params, **kwargs):
        self.requests.append((method, params))
        if method == "account/read":
            return {"account": {"type": self.account_type}}
        if method == "config/read":
            return {"config": {"mcp_servers": {"personal-server": {"secret": "must-not-leak"}}}}
        if method == "thread/start":
            return {"thread": {"id": "thread-native"}}
        if method == "thread/realtime/start":
            if self.fail_start:
                raise codex.CodexLiveError("refused")
            if self.emit_answer:
                self.notifications.put_nowait({"method": "thread/realtime/started",
                                              "params": {"threadId": "thread-native", "realtimeSessionId": "live-native"}})
                self.notifications.put_nowait({"method": "thread/realtime/sdp",
                                              "params": {"threadId": "thread-native", "sdp": "answer\r\n"}})
        return {}

    async def close(self):
        self.closed = True


@pytest.mark.asyncio
async def test_native_negotiation_fences_thread_and_keeps_sdp_exact():
    server = FakeServer()
    call = await codex.negotiate_codex_call("offer\r\n", "voice persona", "marin", server=server, agent_model="gpt-6-luna")
    requests = dict(server.requests)
    thread = requests["thread/start"]
    assert thread["sandbox"] == "read-only"
    assert thread["approvalPolicy"] == "untrusted"
    assert thread["ephemeral"] is True
    assert thread["environments"] == thread["dynamicTools"] == thread["runtimeWorkspaceRoots"] == []
    assert thread["modelProvider"] == "openai"
    assert thread["model"] == "gpt-6-luna"
    assert thread["config"]['mcp_servers.personal-server.enabled'] is False
    assert thread["developerInstructions"] == codex.SKIP_INSTRUCTIONS
    realtime = requests["thread/realtime/start"]
    assert realtime["transport"] == {"type": "webrtc", "sdp": "offer\r\n"}
    assert realtime["version"] == "v3" and realtime["outputModality"] == "audio"
    assert realtime["clientManagedHandoffs"] is True
    assert realtime["includeStartupContext"] is False
    assert realtime["realtimeStartInstructions"] == codex.SKIP_INSTRUCTIONS
    assert "model" not in realtime  # Native subscription model is selected by Codex.
    assert call.answer_sdp == "answer\r\n"
    await call.stop()
    assert server.closed
    assert server.requests[-1] == ("thread/realtime/stop", {"threadId": "thread-native"})


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["api-key-account", "rejected-offer", "unanswered-offer"])
async def test_failure_never_uses_an_api_fallback_and_closes_child(monkeypatch, failure):
    server = FakeServer()
    if failure == "api-key-account":
        server.account_type = "apiKey"
    elif failure == "rejected-offer":
        server.fail_start = True
    else:
        server.emit_answer = False
        monkeypatch.setattr(codex, "ANSWER_TIMEOUT_S", 0)
    with pytest.raises(codex.CodexLiveError):
        await codex.negotiate_codex_call("offer", "persona", "marin", server=server)
    assert server.closed


@pytest.mark.asyncio
async def test_all_child_requests_declined_or_refused(tmp_path):
    server = codex.CodexAppServer(profile=str(tmp_path))
    replies = []

    async def write(reply):
        replies.append(reply)

    server._write = write
    await server._answer({"id": 1, "method": "item/commandExecution/requestApproval"})
    await server._answer({"id": 2, "method": "item/fileChange/requestApproval"})
    await server._answer({"id": 3, "method": "item/tool/call"})
    await server._answer({"id": 4, "method": "account/chatgptAuthTokens/refresh"})
    assert [reply.get("result", {}).get("decision") for reply in replies[:2]] == ["decline", "decline"]
    assert all(reply["error"]["code"] == -32601 for reply in replies[2:])


def test_child_environment_is_profile_owned_and_cannot_select_api_auth(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "launch-key")
    monkeypatch.setenv("CODEX_API_KEY", "codex-key")
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    env = codex._child_env(str(tmp_path))
    assert env["HERMES_HOME"] == str(tmp_path)
    assert not {"OPENAI_API_KEY", "CODEX_API_KEY"}.intersection(env)
    assert env["HOME"]  # Normal external CLI HOME, never a copied auth token.


def test_codex_capability_probe_does_not_resolve_api_keys_or_spawn(monkeypatch):
    monkeypatch.setattr(voice_live, "_voice_section", lambda: {"voice_chat_mode": "gpt-live", "gpt_live": {"auth": "codex"}})
    monkeypatch.setattr(codex, "codex_binary", lambda configured="": "/official/codex")
    monkeypatch.setattr(voice_live, "_resolve_credentials", lambda live: pytest.fail("API auth fallback"))
    status = voice_live.resolve_gpt_live_status()
    assert status["available"] and status["wire_protocol"] == "codex-v3"
    assert status["account_status"] == "checked-on-start"
    assert status["voice"] == "cove"
    assert "sol" in status["voices"] and "marin" not in status["voices"]
    with pytest.raises(ValueError, match="asynchronous"):
        voice_live.create_webrtc_session("offer")


@pytest.mark.asyncio
async def test_call_ownership_concurrency_and_exact_stop(monkeypatch):
    monkeypatch.setattr(codex, "CodexAppServer", FakeServer)
    params = dict(session_id="session-a", instructions="persona", voice="marin", binary="fake")
    first = await codex.create_managed_call("offer", profile="profile-a", **params)
    with pytest.raises(codex.CodexLiveError, match="already"):
        await codex.create_managed_call("offer", profile="profile-a", **params)
    second = await codex.create_managed_call("offer", profile="profile-b", **params)
    first_call = codex.get_managed_call(first["call_id"], first["call_token"], "profile-a", "session-a")
    second_call = codex.get_managed_call(second["call_id"], second["call_token"], "profile-b", "session-a")
    try:
        for owner, session, token in [("profile-b", "session-a", first["call_token"]),
                                      ("profile-a", "session-b", first["call_token"]),
                                      ("profile-a", "session-a", "bad-token")]:
            with pytest.raises(codex.CallOwnershipError):
                codex.get_managed_call(first["call_id"], token, owner, session)
        await codex.stop_managed_call(first_call)
        assert first_call.call.server.closed
        assert not second_call.call.server.closed
        assert codex.get_managed_call(second["call_id"], second["call_token"], "profile-b", "session-a") is second_call
        assert "must-not-leak" not in json.dumps(first)
    finally:
        await codex.stop_managed_call(first_call)
        await codex.stop_managed_call(second_call)


@pytest.mark.asyncio
@pytest.mark.parametrize("attached", [False, True])
async def test_unattached_and_maximum_lifetime_calls_are_reaped(monkeypatch, attached):
    monkeypatch.setattr(codex, "CodexAppServer", FakeServer)
    monkeypatch.setattr(codex, "ATTACH_TIMEOUT_S", 0)
    monkeypatch.setattr(codex, "CALL_TTL_S", 0)
    result = await codex.create_managed_call("offer", profile="profile-expiry", session_id="session",
                                             instructions="persona", voice="marin", binary="fake")
    managed = codex.get_managed_call(result["call_id"], result["call_token"], "profile-expiry", "session")
    managed.attached = attached
    closed = asyncio.Event()
    original = managed.call.server.close

    async def close():
        await original()
        closed.set()

    managed.call.server.close = close
    await asyncio.wait_for(closed.wait(), 3)
    await codex.stop_managed_call(managed)
    with pytest.raises(codex.CallOwnershipError):
        codex.get_managed_call(result["call_id"], result["call_token"], "profile-expiry", "session")


@pytest.mark.asyncio
async def test_cli_spawn_uses_official_transport_and_fenced_environment(tmp_path, monkeypatch):
    from pathlib import Path
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setenv("OPENAI_API_KEY", "do-not-inherit")
    monkeypatch.setenv("CODEX_API_KEY", "do-not-inherit-either")
    captured = {}
    lines = asyncio.Queue()
    exited = asyncio.Event()

    class Pipe:
        def write(self, data):
            request = json.loads(data)
            if "id" in request:
                lines.put_nowait(json.dumps({"id": request["id"], "result": {}}).encode())

        async def drain(self):
            pass

        async def readline(self):
            return await lines.get()

        def close(self):
            lines.put_nowait(b"")
            exited.set()

    class Process:
        stdin = Pipe()
        stdout = Pipe()

        async def wait(self):
            await exited.wait()
            return 0

    async def spawn(*args, **kwargs):
        captured.update(args=args, **kwargs)
        return Process()

    server = codex.CodexAppServer(binary="/official/codex", profile=str(tmp_path), spawn=spawn)
    await server.start()
    workdir = Path(server.workdir)
    try:
        assert captured["args"][:6] == ("/official/codex", "app-server", "--listen", "stdio://", "--enable", "realtime_conversation")
        assert 'model_provider="openai"' in captured["args"]
        assert 'forced_login_method="chatgpt"' in captured["args"]
        assert "analytics.enabled=false" in captured["args"]
        assert "feedback.enabled=false" in captured["args"]
        assert "features.shell_tool=false" in captured["args"]
        assert "features.apps=false" in captured["args"]
        assert "features.plugins=false" in captured["args"]
        assert "features.multi_agent=false" in captured["args"]
        assert captured["env"]["HERMES_HOME"] == str(tmp_path)
        assert "OPENAI_API_KEY" not in captured["env"] and "CODEX_API_KEY" not in captured["env"]
        assert captured["cwd"] == str(workdir)
        assert not list(workdir.iterdir())
    finally:
        await server.close()
    assert not workdir.exists()


@pytest.mark.asyncio
async def test_ambiguous_mcp_override_path_refuses_before_thread_start():
    server = FakeServer()
    original = server.request

    async def request(method, params, **kwargs):
        if method == "config/read":
            return {"config": {"mcp_servers": {"unsafe.server": {"enabled": True}}}}
        return await original(method, params, **kwargs)

    server.request = request
    with pytest.raises(codex.CodexLiveError, match="cannot safely isolate"):
        await codex.negotiate_codex_call("offer", "persona", "marin", server=server)
    assert server.closed
    assert not any(method == "thread/start" for method, params in server.requests)
