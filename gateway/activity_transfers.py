"""Bounded read projections of durable transfer evidence, without reading message/file bodies.

The caller supplies its already-authorized profile home. Kanban is install-shared by design;
only files addressed to that profile are projected. No receipt is minted by this reader.
"""
from __future__ import annotations

import heapq
import json
from pathlib import Path
import re
import sqlite3

_LIMIT = 100
_PROFILE = re.compile(r'^[A-Za-z0-9_-]+$')


def _receipt_times(root):
    for path in root.glob('*.json'):
        try:
            yield path.stat().st_mtime, path
        except FileNotFoundError:
            continue  # a pre-admission pin may be withdrawn while a viewer scans


def _sender(author):
    if not isinstance(author, dict) or author.get('is_bot') is not True:
        return None, None
    identity = str(author.get('id') or '')
    if not identity.startswith('bot:'):
        return None, None
    origin, sep, profile = identity[4:].rpartition('/')
    if not sep:
        profile, origin = identity[4:], None
    return (profile, origin) if _PROFILE.fullmatch(profile) else (None, None)


def _message_transfers(home, profile, since):
    from gateway.session_bot import _record_shape_error
    from tools.bot_live_delivery import _read, _root

    root = _root(home)
    if not root.is_dir():
        return [], False
    # Metadata scan only; physical receipt reads are capped even on a long-lived install.
    paths = heapq.nlargest(_LIMIT + 1, _receipt_times(root))
    rows = []
    for modified, path in paths[:_LIMIT]:
        try:
            record = _read(path)
            if (not record or _record_shape_error(path, record) is not None
                    or record.get('profile_home') != str(home)
                    or not record.get('admission_id') or record.get('status') != 'settled'
                    or record.get('notification_category', 'result') != 'result'):
                continue
            occurred = float(record.get('status_changed_at') or modified)
        except (OSError, ValueError, TypeError):
            continue
        if occurred < since:
            continue
        sender, origin = _sender(record.get('author'))
        rows.append(dict(id=f'bot_chat:{profile}:{record["delivery_id"]}:settled', kind='message',
                         channel='bot_chat', status='settled', occurred_at=occurred,
                         from_profile=sender, from_origin=origin, to_profile=profile,
                         task_id=None, file_name=None, content_type=None, bytes=None))
    return rows, len(paths) > _LIMIT


def _file_transfers(profile, board, since):
    from hermes_cli import kanban_db as kb

    slug = kb._slug_or_default(board)
    path = kb.kanban_db_path(board=slug)
    if not path.is_file():
        return [], False
    # mode=ro matters: polling must never initialize a board, run migrations, or change WAL mode.
    conn = sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True)
    conn.row_factory = sqlite3.Row
    try:
        records = conn.execute(
            'SELECT a.*, e.payload FROM task_attachments a JOIN tasks t ON t.id=a.task_id '
            'LEFT JOIN task_events e ON e.task_id=a.task_id AND e.kind=\'attached\' '
            'AND json_extract(e.payload, \'$.attachment_id\')=a.id '
            'WHERE t.assignee=? AND a.created_at>=? ORDER BY a.created_at DESC, a.id DESC LIMIT ?',
            (profile, since, _LIMIT + 1)).fetchall()
    finally:
        conn.close()
    rows = []
    for record in records[:_LIMIT]:
        try:
            stored = Path(record['stored_path'])
            if not stored.is_file() or stored.stat().st_size != record['size']:
                continue
            payload = json.loads(record['payload'] or '{}')
        except (OSError, ValueError, TypeError):
            continue
        # A later reassignment is not evidence of a file transfer at its original upload time.
        if payload.get('assignee', profile) != profile:
            continue
        actor = payload.get('actor_profile')
        actor = actor if isinstance(actor, str) and _PROFILE.fullmatch(actor) else None
        rows.append(dict(id=f'kanban:{slug}:{record["id"]}', kind='file', channel='kanban',
                         status='available', occurred_at=float(record['created_at']),
                         from_profile=actor, from_origin=None, to_profile=profile,
                         task_id=record['task_id'], file_name=record['filename'],
                         content_type=record['content_type'], bytes=record['size']))
    return rows, len(records) > _LIMIT


def transfer_snapshot(home, profile, *, board=None, since=0):
    messages, messages_truncated = _message_transfers(Path(home).resolve(), profile, since)
    files, files_truncated = _file_transfers(profile, board, since)
    rows = sorted(messages + files, key=lambda row: (row['occurred_at'], row['id']), reverse=True)
    return {'transfers': rows[:_LIMIT],
            'truncated': messages_truncated or files_truncated or len(rows) > _LIMIT}
