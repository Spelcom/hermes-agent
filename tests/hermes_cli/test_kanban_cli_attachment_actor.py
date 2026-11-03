"""CLI attachment labels never override the active profile's transfer provenance."""
from contextlib import nullcontext
import json
from pathlib import Path
import shlex

import pytest


@pytest.mark.parametrize(('actor', 'recipient'), [('developer', 'analyst'), ('analyst', 'default')])
@pytest.mark.parametrize('bound', [True, False], ids=['routed-context', 'cli-home'])
def test_cli_attach_stamps_active_profile_independently_of_author_label(tmp_path, monkeypatch, actor, recipient, bound):
    home = tmp_path / '.hermes'
    actor_home = home / 'profiles' / actor
    actor_home.mkdir(parents=True)
    (actor_home / 'config.yaml').write_text('model: fixture\n')
    monkeypatch.setattr(Path, 'home', lambda: tmp_path)
    monkeypatch.setenv('HERMES_HOME', str(home))
    monkeypatch.setenv('HERMES_KANBAN_HOME', str(home))
    monkeypatch.delenv('HERMES_PROFILE_NAME', raising=False)
    if bound:
        monkeypatch.setenv('HERMES_PROFILE', 'default')  # host env must not relabel a routed sender
    else:
        monkeypatch.delenv('HERMES_PROFILE', raising=False)
        monkeypatch.setenv('HERMES_HOME', str(actor_home))  # main's explicit --profile resolution
    for name in ('HERMES_KANBAN_DB', 'HERMES_KANBAN_BOARD', 'HERMES_KANBAN_TASK'):
        monkeypatch.delenv(name, raising=False)
    from gateway.activity_transfers import transfer_snapshot
    from gateway.run import _profile_runtime_scope
    from hermes_cli import kanban, kanban_db as kb, kanban_db_connect as kbc

    source = tmp_path / 'actual.csv'
    source.write_bytes(b'column\nvalue\n')
    with kbc.connect_closing() as conn:
        task = kb.create_task(conn, title='CLI transfer proof', assignee=recipient, initial_status='blocked')
        legacy = kb.store_attachment_bytes(conn, task, 'legacy.csv', b'old\n', uploaded_by='editor')
    with _profile_runtime_scope(actor_home) if bound else nullcontext():
        result = kanban.run_slash(f'--board default attach {task} {shlex.quote(str(source))} '
                                  '--content-type text/csv --author editor')
    assert 'Attached actual.csv' in result, result
    with kbc.connect_closing() as conn:
        attachment = next(row for row in kb.list_attachments(conn, task) if row.filename == 'actual.csv')
        assert attachment.uploaded_by == 'editor'  # display label remains compatible
        assert Path(attachment.stored_path).read_bytes() == source.read_bytes()
        payload = json.loads(conn.execute("SELECT payload FROM task_events WHERE task_id=? AND kind='attached' "
            "AND json_extract(payload,'$.attachment_id')=?", (task, attachment.id)).fetchone()[0])
        assert payload['actor_profile'] == actor and payload['assignee'] == recipient
        old = json.loads(conn.execute("SELECT payload FROM task_events WHERE task_id=? AND kind='attached' "
            "AND json_extract(payload,'$.attachment_id')=?", (task, legacy)).fetchone()[0])
        assert old['actor_profile'] is None  # never repair history using a caller-supplied label
    transfers = transfer_snapshot(home, recipient)['transfers']
    transfer = next(row for row in transfers if row['file_name'] == 'actual.csv')
    assert (transfer['from_profile'], transfer['to_profile'], transfer['from_origin']) == (actor, recipient, None)
    assert (transfer['channel'], transfer['status'], transfer['content_type'], transfer['bytes']) == (
        'kanban', 'available', 'text/csv', 13)
    assert transfer_snapshot(home, 'editor')['transfers'] == []
