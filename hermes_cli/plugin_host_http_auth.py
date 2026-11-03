"""Carry route-local admission over the private plugin-host channel, without credentials."""
from fastapi import HTTPException


def hosted_client(value):
    """Validate the peer carried by private IPC; missing peers must never become loopback."""
    import ipaddress

    if not isinstance(value, (list, tuple)) or len(value) != 2:
        return None
    host, port = value
    if not isinstance(host, str) or type(port) is not int or not 0 <= port <= 65535:
        return None
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return None
    return host, port


def admitted_for_sensitive_route(request) -> bool:
    """Preserve the normal guard's decision without changing unguarded plugin routes."""
    from hermes_cli.web_server import _require_token
    try:
        _require_token(request)
    except HTTPException as exc:
        if exc.status_code != 401:
            raise
        return False
    return True


def with_hosted_admission(app, authenticated):
    """Admission belongs to this IPC request, never to the cached plugin app."""
    async def scoped(scope, receive, send):
        state = dict(scope.get("state") or {})
        state["hosted_http_authenticated"] = authenticated is True
        await app({**scope, "state": state}, receive, send)
    return scoped
