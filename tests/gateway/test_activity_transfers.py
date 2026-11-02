"""Workspace transfers come from durable owner receipts, never queued tool results."""
import asyncio
from types import SimpleNamespace

import pytest

pytest_plugins = ('tests.gateway.test_session_bot_retry',)


@pytest.mark.asyncio
async def test_native_snapshot_waits_for_real_settlement_and_replays_stable_ids(bot, monkeypatch):
    from gateway.session_bot import deliver, recover_bot_deliveries
    from gateway.session_controls import AuthorityConnection
    from tests.gateway.test_session_bot_retry import _settle_quietly

    monkeypatch.setenv('HERMES_KANBAN_HOME', str(bot.home / 'board'))
    entered, release = asyncio.Event(), asyncio.Event()

    async def execute(authority, ref, row):
        entered.set()
        await release.wait()
        return 'private reply body'

    monkeypatch.setattr('gateway.session_finite.execute_finite_admission', execute)
    connection = AuthorityConnection(bot.authority, object(), {
        'user_id': 'uid:1000', 'profile_id': 'default', 'instance_id': 'fixture',
        'capabilities': ['session:read']})

    async def snapshot(**params):
        return await connection.dispatch({'id': 1, 'method': 'activity.transfers', 'params': params})

    try:
        await deliver(bot.connection, dict(id='a' * 32, profile='default', message='private request body',
            author={'id': 'bot:developer', 'name': 'KAI', 'is_bot': True}))
        await asyncio.wait_for(entered.wait(), 5)
        assert (await snapshot())['result'] == {'transfers': [], 'truncated': False}
        release.set()
        await _settle_quietly(bot)
        result = (await snapshot())['result']
        [transfer] = result['transfers']
        assert (transfer['kind'], transfer['channel'], transfer['status']) == ('message', 'bot_chat', 'settled')
        assert (transfer['from_profile'], transfer['from_origin'], transfer['to_profile']) == ('developer', None, 'default')
        assert transfer['occurred_at'] > 0
        assert 'private' not in str(result)
        await recover_bot_deliveries(bot.authority)
        await _settle_quietly(bot)
        assert (await snapshot())['result'] == result
        assert (await snapshot(since=transfer['occurred_at'] + 1))['result']['transfers'] == []
        refused = await snapshot(profile='analyst')
        assert refused['error']['data']['reason'] == 'profile_mismatch'
        connection.actor = SimpleNamespace(profile_id='default', capabilities=frozenset())
        refused = await snapshot()
        assert refused['error']['data']['reason'] == 'permission_denied'
    finally:
        release.set()
        await _settle_quietly(bot)


def test_sender_origin_is_preserved_without_guessing_a_connection():
    from gateway.activity_transfers import _sender
    assert _sender({'id': 'bot:office-host/analyst', 'is_bot': True}) == ('analyst', 'office-host')
    assert _sender({'id': 'relay-principal:abc', 'is_bot': True}) == (None, None)
