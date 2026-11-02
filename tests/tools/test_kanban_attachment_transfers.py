"""A real registered attachment creates availability evidence with profile-scoped provenance."""
import base64
import json
from pathlib import Path


def test_registered_attach_records_actor_and_task_assignee_without_claiming_delivery(tmp_path, monkeypatch):
    home = tmp_path / '.hermes'
    actor_home = home / 'profiles' / 'developer'
    actor_home.mkdir(parents=True)
    (actor_home / 'config.yaml').write_text('model: fixture\n')
    monkeypatch.setattr(Path, 'home', lambda: tmp_path)
    monkeypatch.setenv('HERMES_HOME', str(home))
    monkeypatch.setenv('HERMES_KANBAN_HOME', str(home))
    for name in ('HERMES_PROFILE', 'HERMES_KANBAN_DB', 'HERMES_KANBAN_BOARD', 'HERMES_KANBAN_TASK'):
        monkeypatch.delenv(name, raising=False)
    from gateway.activity_transfers import transfer_snapshot
    from gateway.run import _profile_runtime_scope
    from hermes_cli import kanban_db as kb, kanban_db_connect as kbc
    from tools import kanban_tools  # register handlers
    from tools.registry import registry

    with kbc.connect_closing() as conn:
        task = kb.create_task(conn, title='actual file handoff', assignee='analyst')
    with _profile_runtime_scope(actor_home):
        attached = json.loads(registry.dispatch('kanban_attach', {
            'task_id': task, 'filename': 'report.csv', 'content_type': 'text/csv',
            'content_base64': base64.b64encode(b'column\nvalue\n').decode()}))
    assert attached.get('ok'), attached
    snapshot = transfer_snapshot(home, 'analyst')
    [transfer] = snapshot['transfers']
    assert (transfer['from_profile'], transfer['to_profile']) == ('developer', 'analyst')
    assert (transfer['status'], transfer['channel'], transfer['file_name']) == ('available', 'kanban', 'report.csv')
    assert transfer['content_type'] == 'text/csv' and transfer['bytes'] == 13
    assert transfer_snapshot(home, 'editor')['transfers'] == []
    assert not any(word in str(snapshot) for word in ('stored_path', 'content_base64', 'delivered', 'read'))
    with kbc.connect_closing() as conn:
        attachment = kb.get_attachment(conn, attached['attachment_id'])
        kb.assign_task(conn, task, 'editor')
    # A reassignment cannot manufacture an upload from developer to a different profile.
    assert transfer_snapshot(home, 'editor')['transfers'] == []
    Path(attachment.stored_path).unlink()
    with kbc.connect_closing() as conn:
        kb.assign_task(conn, task, 'analyst')
    assert transfer_snapshot(home, 'analyst')['transfers'] == []
