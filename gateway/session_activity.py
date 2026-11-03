"""Profile-authorized workspace activity evidence on the native transport."""
import asyncio
from pathlib import Path

from hermes_state_runtime import RuntimeStoreError


def _owner(connection, ref, params):
    from gateway.session_authorities import served_profile_name
    from hermes_cli.profiles import profile_matches_home

    home = Path(connection.authority.db.db_path).parent.resolve()
    if connection.actor.profile_id != connection.authority.profile_id:
        raise RuntimeStoreError('profile_mismatch')
    if 'session:read' not in connection.actor.capabilities:
        raise RuntimeStoreError('permission_denied')
    if params.get('profile') and not profile_matches_home(params['profile'], home):
        raise RuntimeStoreError('profile_mismatch')
    if ref.session_id:
        connection.authority.authorize(connection.actor, ref, 'session:read')
    return home, served_profile_name(home)


async def transfers(connection, ref, params):
    from gateway.activity_transfers import transfer_snapshot
    home, profile = _owner(connection, ref, params)
    return await asyncio.to_thread(transfer_snapshot, home, profile,
                                   board=params.get('board'), since=params.get('since', 0))


async def tasks(connection, ref, params):
    from gateway.activity_tasks import task_snapshot
    home, profile = _owner(connection, ref, params)
    limit = params.get('limit', 20)
    if type(limit) is not int or not 1 <= limit <= 50:
        raise RuntimeStoreError('invalid_params')
    try:
        return await asyncio.to_thread(task_snapshot, home, profile,
                                       board=params.get('board'), limit=limit)
    except ValueError as exc:
        raise RuntimeStoreError('invalid_params') from exc
