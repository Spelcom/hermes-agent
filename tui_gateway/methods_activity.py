"""Read-only workspace transfer snapshots for the legacy UI transport."""
from .method_ctx import HandlerRegistry

_registry = HandlerRegistry()


@_registry.method('activity.transfers')
@_registry.profile_scoped
def activity_transfers(rid, params):
    from gateway.activity_transfers import transfer_snapshot
    from hermes_cli.profiles import current_profile_name
    from hermes_constants import get_hermes_home

    return _ok(rid, transfer_snapshot(get_hermes_home(), current_profile_name('default') or 'default',
                                       board=params.get('board'), since=params.get('since', 0)))


def register(server):
    _registry.install(server)
