"""Profile-authorized workspace transfer evidence on the native transport."""
import asyncio
from pathlib import Path

from hermes_state_runtime import RuntimeStoreError


async def transfers(connection, ref, params):
    from gateway.session_authorities import served_profile_name
    from gateway.activity_transfers import transfer_snapshot
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
    return await asyncio.to_thread(transfer_snapshot, home, served_profile_name(home),
                                   board=params.get('board'), since=params.get('since', 0))
