"""Passive official Codex CLI lookup; never installs or launches the CLI."""

from __future__ import annotations

from hermes_platform.resolver.core import LookupContext, locate_command

# Official desktop bundle locations are fallback candidates after the user's PATH.
_CODEX_DESKTOP_DIRS = (
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS",
    "/Applications/Codex.app/Contents/Resources",
)


def resolve_codex_binary(configured: str = "", *, path: str | None = None) -> str | None:
    resolution = locate_command(
        configured.strip() or "codex", LookupContext(path=path),
        known_dirs=() if configured.strip() else _CODEX_DESKTOP_DIRS,
    )
    return resolution.command[0] if resolution.command else None
