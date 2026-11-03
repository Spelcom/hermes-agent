"""Assignment, a real claimed run, and literal checkboxes have different UI meanings."""
from pathlib import Path
from types import SimpleNamespace

import pytest

pytest_plugins = ('tests.gateway.test_session_bot_retry',)


@pytest.fixture
def board(tmp_path, monkeypatch):
    from hermes_cli import kanban_db_connect as kbc
    monkeypatch.setenv('HERMES_KANBAN_HOME', str(tmp_path / 'board'))
    monkeypatch.setattr(Path, 'home', lambda: tmp_path)
    with kbc.connect_closing(board='default') as conn:
        yield conn


def test_assigned_claimed_and_completed_tasks_keep_real_checklist_counts(board, tmp_path, monkeypatch):
    from gateway import activity_tasks
    from hermes_cli import kanban_db as kb
    from hermes_state import SessionDB

    home = tmp_path / 'profile'
    home.mkdir()
    with SessionDB(db_path=home / 'state.db') as db:
        db.create_session('bot-root', source='local')
        db.set_session_title('bot-root', 'Bot Chat')
    task = kb.create_task(board, title='Analyze the actual CSV', assignee='analyst',
        body='- [x] Read input\n- [ ] Verify output\n```md\n- [x] example only\n```\n50% prose is not progress')
    kb.create_task(board, title='Other employee private assignment', assignee='editor')
    first = activity_tasks.task_snapshot(home, 'analyst')
    [row] = first['tasks']
    assert first['canonical_session_id'] == 'bot-root'
    assert row['status'] == 'ready' and row['active'] is False and row['run_id'] is None
    assert row['checklist'] == {'done': 1, 'total': 2, 'source': 'task_body'}
    assert 'Other employee' not in str(first) and 'example only' not in str(first)
    claimed = kb.claim_task(board, task, ttl_seconds=900)
    running = activity_tasks.task_snapshot(home, 'analyst')
    [row] = running['tasks']
    assert row['active'] and row['run_id'] == claimed.current_run_id and row['run_status'] == 'running'
    assert row['execution_session_id'] is None  # a manual claim did not invent a worker session
    assert running['revision'] != first['revision']
    monkeypatch.setattr(activity_tasks.time, 'time', lambda: running['captured_at'] + 1)
    assert activity_tasks.task_snapshot(home, 'analyst')['revision'] == running['revision']
    monkeypatch.setattr(activity_tasks.time, 'time', lambda: claimed.claim_expires + 1)
    assert activity_tasks.task_snapshot(home, 'analyst')['tasks'][0]['active'] is False
    assert kb.complete_task(board, task, summary='Verified real output')
    completed = activity_tasks.task_snapshot(home, 'analyst')['tasks'][0]
    assert completed['status'] == 'done' and completed['active'] is False
    assert completed['run_status'] == 'done' and completed['run_outcome'] == 'completed'
    assert completed['checklist'] == row['checklist']  # completion is not evidence that every checkbox changed


def test_bounded_snapshot_does_not_open_foreign_worker_store_or_infer_checklists(board, tmp_path):
    from gateway.activity_tasks import task_snapshot
    from hermes_cli import kanban_db as kb
    from hermes_state import SessionDB

    home = tmp_path / 'analyst'
    home.mkdir()
    with SessionDB(db_path=home / 'state.db') as db:
        db.create_session('worker-actual', source='kanban')
    own = kb.create_task(board, title='Actual native attempt', assignee='analyst', body='No stored checklist')
    claimed = kb.claim_task(board, own)
    with kb.write_txn(board):
        kb._append_event(board, own, 'owner_admitted',
            {'db': str(home / 'state.db'), 'session_id': 'worker-actual'}, run_id=claimed.current_run_id)
    row = task_snapshot(home, 'analyst')['tasks'][0]
    assert row['execution_session_id'] == 'worker-actual' and row['checklist'] is None
    with kb.write_txn(board):
        kb._append_event(board, own, 'owner_admitted',
            {'db': str(tmp_path / 'foreign' / 'state.db'), 'session_id': 'private-session'}, run_id=claimed.current_run_id)
    kb.create_task(board, title='Recent blocked assignment', assignee='analyst', initial_status='blocked')
    snapshot = task_snapshot(home, 'analyst', limit=1)
    assert snapshot['truncated'] and snapshot['tasks'][0]['task_id'] == own
    assert snapshot['tasks'][0]['execution_session_id'] is None
    assert 'private-session' not in str(snapshot)


def test_true_active_claim_precedes_recent_expired_runs_before_limit(board, tmp_path):
    from gateway.activity_tasks import task_snapshot
    from hermes_cli import kanban_db as kb

    active = kb.create_task(board, title='Older active assignment', assignee='analyst')
    kb.claim_task(board, active, ttl_seconds=900)
    expired = kb.create_task(board, title='Recent expired assignment', assignee='analyst')
    kb.claim_task(board, expired, ttl_seconds=900)
    with kb.write_txn(board):
        board.execute('UPDATE tasks SET claim_expires=1 WHERE id=?', (expired,))
    result = task_snapshot(tmp_path, 'analyst', limit=1)
    assert result['truncated'] and result['tasks'][0]['task_id'] == active
    assert result['tasks'][0]['active'] is True


@pytest.mark.asyncio
async def test_native_task_rpc_is_profile_scoped_read_only_and_validates_limits(bot, board):
    from gateway.session_controls import AuthorityConnection
    from hermes_cli import kanban_db as kb

    own = kb.create_task(board, title='Owned assignment', assignee='default', initial_status='blocked')
    kb.create_task(board, title='Foreign assignment', assignee='analyst')
    connection = AuthorityConnection(bot.authority, object(), {
        'user_id': 'uid:1000', 'profile_id': 'default', 'instance_id': 'fixture', 'capabilities': ['session:read']})

    async def snapshot(**params):
        return await connection.dispatch({'id': 1, 'method': 'activity.tasks', 'params': params})

    result = (await snapshot())['result']
    assert result['profile'] == 'default' and result['board'] == 'default'
    assert result['canonical_session_id'] == bot.chat
    assert [row['task_id'] for row in result['tasks']] == [own]
    assert result['tasks'][0]['active'] is False
    assert (await snapshot(profile='analyst'))['error']['data']['reason'] == 'profile_mismatch'
    assert (await snapshot(limit=0))['error']['data']['reason'] == 'invalid_params'
    assert (await snapshot(board='../private'))['error']['data']['reason'] == 'invalid_params'
    connection.actor = SimpleNamespace(profile_id='default', capabilities=frozenset())
    assert (await snapshot())['error']['data']['reason'] == 'permission_denied'
