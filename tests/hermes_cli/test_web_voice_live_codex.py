"""Live call API binds native lifetime to its authenticated profile/session lease."""

import asyncio
import threading
from pathlib import Path
from types import SimpleNamespace

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
    from gateway.run_api import GatewayRuntimeAPI
    from gateway.runtime_bootstrap import TicketStore
    from gateway.session_authorities import SessionAuthorities
    instance_id = "native-voice-test-owner"
    authorities = [SimpleNamespace(profile_id=str(path.resolve()), instance_id=instance_id)
                   for path in (home, other)]
    store = TicketStore(instance_id, frozenset(authority.profile_id for authority in authorities))
    registry = SessionAuthorities(home, multiplexed=True)
    for authority, name in zip(authorities, ("default", "other")):
        registry.add(authority.profile_id, authority, name=name)
    runner = SimpleNamespace(
        session_ticket_store=store, session_authorities=registry, _draining=False,
        session_runtime_descriptor={"state": "ready", "instance_id": instance_id,
                                    "served_profiles": [{"profile_id": a.profile_id, "home": a.profile_id}
                                                        for a in authorities]},
    )
    monkeypatch.setattr(web_server.app.state, "gateway_runner", runner, raising=False)
    app = GatewayRuntimeAPI(web_server.app, runner, web_server.app)
    with TestClient(app, client=("127.0.0.1", 50001)) as client:
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


def test_native_ticket_lease_negotiates_public_protocol_and_consumes_ticket(voice_client, monkeypatch):
    """The real browser upgrade must select the public protocol, never its ticket."""
    from hermes_cli import web_server
    from hermes_cli.dashboard_auth.ws_tickets import mint_ticket
    from hermes_cli.web_server_boundary import _GATEWAY_WS_PROTOCOL, _GATEWAY_WS_TICKET_PROTOCOL_PREFIX

    client, calls, _token, _home = voice_client
    call = _create(client)
    # Native desktop upgrades use a one-use gateway ticket carried in a
    # subprotocol. Keep the actual auth/consume path and ASGI upgrade intact.
    monkeypatch.setattr(web_server.app.state, "auth_required", True, raising=False)
    ticket = mint_ticket(user_id="native-local-owner", provider="local")
    protocols = [_GATEWAY_WS_PROTOCOL, f"{_GATEWAY_WS_TICKET_PROTOCOL_PREFIX}{ticket}"]
    lease_url = f'/api/audio/voice-live/calls/{call["call_id"]}'
    with client.websocket_connect(lease_url, subprotocols=protocols) as ws:
        assert ws.accepted_subprotocol == _GATEWAY_WS_PROTOCOL
        assert ticket not in ws.accepted_subprotocol
        ws.send_json({"type": "authenticate", "call_token": call["call_token"], "session_id": "hermes-a"})
        assert ws.receive_json() == {"type": "lease.ready"}
        # A consumed native ticket does not authorize a second sibling socket.
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(lease_url, subprotocols=protocols):
                pass
        assert not calls[0].stopped.is_set()
    assert calls[0].stopped.wait(timeout=3)


def test_private_runtime_ticket_reaches_voice_lease_and_cannot_replay(voice_client):
    from hermes_cli import web_server

    client, calls, _token, home = voice_client
    call = _create(client)
    store = web_server.app.state.gateway_runner.session_ticket_store
    ticket = store.mint(profile_id=str(home.resolve()), subject="uid:native-owner", purpose="interactive")
    protocols = ["hermes-gateway-v1", f"hermes-gateway-ticket.{ticket}"]
    url = f'/api/audio/voice-live/calls/{call["call_id"]}?profile=default'
    with client.websocket_connect(url, subprotocols=protocols) as ws:
        assert ws.accepted_subprotocol == "hermes-gateway-v1"
        ws.send_json({"type": "authenticate", "call_token": call["call_token"], "session_id": "hermes-a"})
        assert ws.receive_json() == {"type": "lease.ready"}
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(url, subprotocols=protocols):
                pass
        assert not calls[0].stopped.is_set()
    assert calls[0].stopped.wait(timeout=3)


@pytest.mark.parametrize("failure", ["wrong-purpose", "expired", "foreign-profile", "repeated-profile", "malformed-profile", "origin", "stale-instance", "retiring-profile"])
def test_private_voice_ticket_refusals_preserve_the_call(voice_client, monkeypatch, failure):
    from hermes_cli import web_server

    client, calls, _token, home = voice_client
    call = _create(client)
    runner = web_server.app.state.gateway_runner
    store = runner.session_ticket_store
    purpose = "native-http" if failure == "wrong-purpose" else "interactive"
    if failure == "expired":
        monkeypatch.setattr(store, "TTL_SECONDS", 0)
    ticket = store.mint(profile_id=str(home.resolve()), subject="uid:native-owner", purpose=purpose)
    query = "?profile=other" if failure == "foreign-profile" else "?profile=default"
    if failure == "repeated-profile":
        query += "&profile=other"
    if failure == "malformed-profile":
        query = "?profile=../other"
    if failure == "stale-instance":
        runner.session_runtime_descriptor["instance_id"] = "another-owner"
    if failure == "retiring-profile":
        runner.session_authorities.for_home(home).retiring = True
        # The descriptor can stop serving a profile before its ticket-store
        # entry is withdrawn; this late upgrade must still be refused.
        runner.session_runtime_descriptor["served_profiles"] = [
            entry for entry in runner.session_runtime_descriptor["served_profiles"]
            if entry["profile_id"] != str(home.resolve())
        ]
    headers = {"Origin": "file://"} if failure == "origin" else {}
    try:
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(
                f'/api/audio/voice-live/calls/{call["call_id"]}{query}', headers=headers,
                subprotocols=["hermes-gateway-v1", f"hermes-gateway-ticket.{ticket}"],
            ):
                pass
        assert not calls[0].stopped.is_set()
    finally:
        response = client.post(f'/api/audio/voice-live/calls/{call["call_id"]}/close',
                               json={"call_token": call["call_token"], "session_id": "hermes-a"})
        assert response.status_code == 200
        assert calls[0].stopped.wait(timeout=3)


def test_private_voice_ticket_pins_implicit_secondary_profile(voice_client):
    from hermes_cli import web_server

    client, calls, _token, home = voice_client
    response = client.post("/api/audio/voice-live/session?profile=other",
                           json={"sdp": "offer", "session_id": "secondary-session"})
    assert response.status_code == 200
    call = response.json()
    secondary = str((home / "profiles" / "other").resolve())
    store = web_server.app.state.gateway_runner.session_ticket_store
    ticket = store.mint(profile_id=secondary, subject="uid:native-owner", purpose="interactive")
    # No selector: the verified grant, never the launch home, owns this socket.
    with client.websocket_connect(f'/api/audio/voice-live/calls/{call["call_id"]}',
                                  subprotocols=["hermes-gateway-v1", f"hermes-gateway-ticket.{ticket}"]) as ws:
        assert ws.accepted_subprotocol == "hermes-gateway-v1"
        ws.send_json({"type": "authenticate", "call_token": call["call_token"], "session_id": "secondary-session"})
        assert ws.receive_json() == {"type": "lease.ready"}
        assert calls[0].profile == secondary
    assert calls[0].stopped.wait(timeout=3)
