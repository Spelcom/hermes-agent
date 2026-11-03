"""Standby audio never takes cloud, auto-detection or plugin transcription paths."""

import base64
import contextlib

import pytest
from fastapi import HTTPException


@pytest.mark.asyncio
async def test_local_only_route_uses_command_snapshot_and_deletes_its_clip(tmp_path, monkeypatch):
    from hermes_cli.web_models import AudioTranscriptionRequest
    from hermes_cli.web_routers import audio
    from tools import transcription_command, transcription_tools, voice_mode

    config = {"enabled": True, "provider": "whisper_cpp_local", "language": "ru",
              "providers": {"whisper_cpp_local": {"type": "command", "command": "known-local-whisper"}}}
    monkeypatch.setattr(transcription_tools, "_load_stt_config", lambda: config)
    monkeypatch.setattr(audio, "_config_profile_scope", lambda profile: contextlib.nullcontext())
    seen = []

    def command(path, provider, command_config, stt_config):
        from pathlib import Path
        seen.append(Path(path))
        assert provider == "whisper_cpp_local"
        assert command_config["command"] == "known-local-whisper"
        assert Path(path).read_bytes() == b"local speech"
        return {"success": True, "transcript": "Кай проверь задачу", "provider": provider}

    monkeypatch.setattr(transcription_command, "_transcribe_command_stt", command)
    monkeypatch.setattr(voice_mode, "transcribe_recording", lambda path: pytest.fail("normal dispatch could select cloud"))
    payload = AudioTranscriptionRequest(data_url="data:audio/wav;base64," + base64.b64encode(b"local speech").decode(),
                                        mime_type="audio/wav", local_only=True)
    result = await audio.transcribe_audio_upload(payload, profile="default")
    assert result["transcript"] == "Кай проверь задачу"
    assert len(seen) == 1
    assert not seen[0].exists()


@pytest.mark.parametrize("config", [
    {"enabled": True, "provider": "openai", "providers": {}},
    {"enabled": False, "provider": "whisper_cpp_local", "providers": {}},
    {"enabled": True, "provider": "whisper_cpp_local", "providers": {"whisper_cpp_local": {"type": "plugin"}}},
])
def test_local_only_refuses_provider_changes_before_dispatch(config, monkeypatch):
    from hermes_cli.web_routers import audio
    from tools import transcription_command, transcription_tools

    monkeypatch.setattr(transcription_tools, "_load_stt_config", lambda: config)
    monkeypatch.setattr(transcription_command, "_transcribe_command_stt", lambda *args: pytest.fail("must not dispatch"))
    with pytest.raises(HTTPException) as error:
        audio._transcribe_local_wake_recording("unused.wav")
    assert error.value.status_code == 409


def test_regular_dictation_does_not_opt_into_local_only():
    from hermes_cli.web_models import AudioTranscriptionRequest
    assert AudioTranscriptionRequest(data_url="data:audio/wav;base64,AA==").local_only is False


@pytest.mark.asyncio
async def test_dedicated_standby_endpoint_forces_local_guard_even_without_flag(monkeypatch):
    from hermes_cli.web_models import AudioTranscriptionRequest
    from hermes_cli.web_routers import audio

    async def transcribe(payload, profile):
        assert payload.local_only is True
        assert profile == "default"
        return {"ok": True, "transcript": ""}

    monkeypatch.setattr(audio, "transcribe_audio_upload", transcribe)
    result = await audio.transcribe_local_audio_upload(
        AudioTranscriptionRequest(data_url="data:audio/wav;base64,AA=="), "default")
    assert result["ok"] is True
