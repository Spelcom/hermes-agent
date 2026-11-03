"""Driver 0.35+ output shaping must retain snapshot-safe input and literal text semantics."""

from unittest.mock import Mock

import pytest

from tools.computer_use.cua_backend import CuaDriverBackend
from tools.computer_use.cua_backend_session import _CuaDriverSession


def _backend(properties):
    session = _CuaDriverSession.__new__(_CuaDriverSession)
    session._tool_schemas = {name: {"properties": {prop: {} for prop in props}} for name, props in properties.items()}
    session._capabilities = {name: set() for name in properties}
    session.call_tool = Mock(return_value={"data": {}, "structuredContent": {}, "images": [], "isError": False})
    backend = CuaDriverBackend.__new__(CuaDriverBackend)
    backend._session = session
    backend._session_id = "snapshot-test"
    backend._snapshot_tokens = {}
    backend._active_pid = 42
    backend._active_window_id = 7
    return backend


@pytest.mark.parametrize("properties,expected", [
    ({"tree_format", "full_output"}, {"tree_format": "both"}),
    ({"full_output"}, {"full_output": True}),
    (set(), {}),
])
def test_capture_keeps_bounds_and_token_for_subsequent_element_action(monkeypatch, properties, expected):
    from tools.computer_use import cua_backend

    monkeypatch.setattr(cua_backend, "_cua_configured_ax_max_elements", lambda: 100)
    backend = _backend({"get_window_state": properties, "click": {"element_token"}})

    def driver(name, args):
        if name == "get_window_state":
            assert args == {"pid": 42, "window_id": 7, "session": "snapshot-test", "max_elements": 100, **expected}
            return {"data": {"tree_markdown": '[3] AXButton "Save"'}, "images": [], "isError": False,
                    "structuredContent": {"elements": [{"element_index": 3, "role": "AXButton", "label": "Save",
                        "frame": {"x": 10, "y": 20, "w": 80, "h": 30}, "element_token": "sabc:3"}]}}
        assert name == "click"
        assert args["element_token"] == "sabc:3"
        return {"data": {}, "structuredContent": {}, "images": [], "isError": False}

    backend._session.call_tool.side_effect = driver
    _, _, elements, _ = backend._capture_window_state()
    assert elements[0].bounds == (10, 20, 80, 30)
    assert backend.click(element=3).ok


@pytest.mark.parametrize("text", ["hello\n", "hello\r", "hello\tworld", "a\r\nb"])
@pytest.mark.parametrize("setter", [False, True])
def test_control_characters_refuse_before_any_focus_or_input(text, setter):
    backend = _backend({"type_text": {"delivery_mode"}, "bring_to_front": set(),
                        **({"set_value": {"element_index", "value"}} if setter else {})})
    result = backend.type_text(text, delivery_mode="foreground", bring_to_front=True)
    assert not result.ok
    assert result.code == "text_control_characters"
    assert ("Use set_value" in result.message) == setter
    assert "separate key actions" in result.message
    backend._session.call_tool.assert_not_called()


def test_unicode_text_reaches_driver_exactly():
    backend = _backend({"type_text": set()})
    text = "  Привет 👋 e\u0301 日本語  "
    assert backend.type_text(text).ok
    backend._session.call_tool.assert_called_once_with("type_text", {
        "pid": 42, "window_id": 7, "text": text, "session": "snapshot-test"})
