"""Client output gain is profile-owned and never sent as a vendor voice option."""

import pytest

from tools import voice_live


@pytest.mark.parametrize("raw, expected", [(0, 0), (2.5, 2.5), (9, 4), (-1, 0), (True, 1), ("2", 1), (float("nan"), 1), (float("inf"), 1)])
def test_invalid_gain_cannot_escape_bounded_playback(raw, expected):
    assert voice_live.live_output_gain({"output_gain": raw}) == expected


def test_status_reads_gain_without_resolving_api_credentials(monkeypatch):
    from tools import voice_live_codex

    monkeypatch.setattr(voice_live, "_voice_section", lambda: {"gpt_live": {"auth": "codex", "output_gain": 2.5}})
    monkeypatch.setattr(voice_live_codex, "codex_binary", lambda _: "/official/codex")
    monkeypatch.setattr(voice_live, "_resolve_credentials", lambda _: pytest.fail("credential fallback"))
    assert voice_live.resolve_gpt_live_status()["output_gain"] == 2.5


@pytest.mark.asyncio
async def test_native_session_returns_profile_gain_without_forwarding_vendor_option(tmp_path, monkeypatch):
    from tools import voice_live_codex

    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    monkeypatch.setattr(voice_live, "_live_section", lambda: {"auth": "codex", "voice": "spruce", "output_gain": 2})
    monkeypatch.setattr(voice_live_codex, "codex_binary", lambda _: "/official/codex")
    received = {}

    async def create(offer, **kwargs):
        received.update(kwargs)
        return {"auth": "codex-subscription", "transport": {"sdp": "answer"}}

    monkeypatch.setattr(voice_live_codex, "create_managed_call", create)
    result = await voice_live.create_webrtc_session_async("offer", session_id="owned")
    assert result["output_gain"] == 2
    assert received["voice"] == "spruce" and received["session_id"] == "owned"
    assert "output_gain" not in received


def test_api_vendor_session_does_not_receive_client_gain(monkeypatch):
    monkeypatch.setattr(voice_live, "_live_section", lambda: {"output_gain": 4})
    assert "output_gain" not in voice_live.build_session_config()
