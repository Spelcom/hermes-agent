"""Live call API binds native lifetime to its authenticated profile/session lease."""

import asyncio
import threading
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from tools import voice_live_codex as codex


@pytest.fixture
def voice_client(tmp_path, monkeypatch):
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    home = tmp_path / ".hermes"
    other = home / "profiles" / "other"
    other.mkdir(parents=True)
    configuration = 'voice:\n  voice_chat_mode: gpt-live\n  gpt_live:\n    auth: codex-subscription\n'
    (home / "config.yaml").write_text(configuration)
    (other / "config.yaml").write_text(configuration)
    monkeypatch.setenv("HERMES_HOME", str(home))
    monkeypatch.setattr(codex, "codex_binary", lambda configured="": "/fake/official-codex")
    calls = []

    class Server:
        def __init__(self, **kwargs):
            self.profile = kwargs["profile"]
            self.notifications = asyncio.Queue()
            self.stopped = threading.Event()
            calls.append(self)

        async def request(self, *args, **kwargs):
            return {}

        async def close(self):
            self.stopped.set()

    async def negotiate(sdp, instructions, voice, history, *, server, agent_model=""):
        return codex.CodexLiveCall(server, "native-thread", "answer\r\n", "native-session")

    monkeypatch.setattr(codex, "CodexAppServer", Server)
    monkeypatch.setattr(codex, "negotiate_codex_call", negotiate)
    from hermes_cli import web_server
    from hermes_cli.web_routers import audio
    # The real gateway authentication check remains; TestClient's peer/host is
    # synthetic, so only its transport boundary is replaced.
    monkeypatch.setattr(audio, "_ws_request_is_allowed", lambda ws: True)
    with TestClient(web_server.app) as client:
        client.headers["Authorization"] = f"Bearer {web_server._SESSION_TOKEN}"
        yield client, calls, web_server._SESSION_TOKEN, home


def _create(client):
    response = client.post("/api/audio/voice-live/session", json={"sdp": "offer\r\n", "session_id": "hermes-a"})
    assert response.status_code == 200, response.text
    return response.json()


def test_authenticated_lease_disconnect_reaps_only_owned_call(voice_client):
    client, calls, token, home = voice_client
    call = _create(client)
    assert call["wire_protocol"] == "codex-v3"
    assert call["session_id"] == "hermes-a"
    assert calls[0].profile == str(home.resolve())
    lease_url = f'/api/audio/voice-live/calls/{call["call_id"]}?token={token}'
    with client.websocket_connect(lease_url) as ws:
        ws.send_json({"type": "authenticate", "call_token": call["call_token"], "session_id": "hermes-a"})
        assert ws.receive_json() == {"type": "lease.ready"}
        ws.send_json({"type": "ping"})
        assert ws.receive_json() == {"type": "pong"}
        # Neither a stale session nor another profile can close the live call.
        for query, session in [("", "hermes-b"), ("?profile=other", "hermes-a")]:
            response = client.post(f'/api/audio/voice-live/calls/{call["call_id"]}/close{query}',
                                   json={"call_token": call["call_token"], "session_id": session})
            assert response.status_code == 404
            assert not calls[0].stopped.is_set()
        with client.websocket_connect(lease_url) as duplicate:
            duplicate.send_json({"type": "authenticate", "call_token": call["call_token"], "session_id": "hermes-a"})
            with pytest.raises(WebSocketDisconnect):
                duplicate.receive_json()
        assert not calls[0].stopped.is_set()
    assert calls[0].stopped.wait(timeout=3)


def test_call_secret_is_not_gateway_authentication(voice_client):
    client, calls, _token, _home = voice_client
    call = _create(client)
    try:
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(f'/api/audio/voice-live/calls/{call["call_id"]}'):
                pass
        assert not calls[0].stopped.is_set()
    finally:
        response = client.post(f'/api/audio/voice-live/calls/{call["call_id"]}/close',
                               json={"call_token": call["call_token"], "session_id": "hermes-a"})
        assert response.status_code == 200
        assert calls[0].stopped.wait(timeout=3)
