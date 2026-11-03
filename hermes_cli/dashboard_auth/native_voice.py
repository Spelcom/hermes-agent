"""Private native admission for the exact owned live-voice lease route.

The desktop reserves this path/window before stripping Origin. Interactive
session tickets use the runtime's issuer, separate from browser WS tickets.
"""

from contextlib import contextmanager
import re


def redeem_native_voice_call(ws):
    """Return a verified one-use profile grant, or leave ordinary WS auth to its gate."""
    from hermes_cli.dashboard_auth.native_http import _native_store, _own_profile
    from hermes_cli.web_server_boundary import _gateway_ws_ticket_from_subprotocol

    if not re.fullmatch(r"/api/audio/voice-live/calls/[A-Za-z0-9_-]{1,128}", ws.url.path):
        return None
    ticket, reason = _gateway_ws_ticket_from_subprotocol(ws)
    if reason != 'ok':
        return None
    gate = _native_store(ws, [ticket])
    if gate is None:
        return None
    runner, store = gate
    from gateway.session_authorities import authority_for_profile_id
    try:
        grant = store.redeem(ticket, profile_id=None, purpose='interactive')
        authority = authority_for_profile_id(runner, grant['profile_id'])
        if (authority is None or getattr(authority, 'retiring', False)
                or getattr(authority, 'retired', False)
                or 'session:read' not in grant['capabilities']):
            return None
        for profile in ws.query_params.getlist('profile'):
            _own_profile(profile, grant['profile_id'])
    except PermissionError:
        return None
    return grant


@contextmanager
def native_voice_profile_scope(grant):
    """Pin implicit profile selectors to the verified grant; the route binds config/secrets."""
    if grant is None:
        yield
        return
    from hermes_constants import reset_hermes_home_override, set_hermes_home_override
    token = set_hermes_home_override(grant['profile_id'])
    try:
        yield
    finally:
        reset_hermes_home_override(token)
