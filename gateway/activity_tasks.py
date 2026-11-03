"""Read-only, profile-scoped projections of actual Kanban assignments and claimed runs."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
import sqlite3
import time

_CHECKBOX = re.compile(r'^\s*(?:[-+*]|\d+[.)])\s+\[([ xX])\]\s+\S')
_FENCE = re.compile(r'^\s*(`{3,}|~{3,})')


def _checklist(body):
    if not isinstance(body, str) or len(body) > 65536:
        return None
    done = total = 0
    fence = None
    for line in body.splitlines():
        marker = _FENCE.match(line)
        if marker:
            token = marker.group(1)
            if fence is None:
                fence = token
            elif token[0] == fence[0] and len(token) >= len(fence):
                fence = None
            continue
        match = None if fence else _CHECKBOX.match(line)
        if match:
            total += 1
            done += match.group(1).lower() == 'x'
    return {'done': done, 'total': total, 'source': 'task_body'} if total else None


def _worker_session(home, payload):
    """Only the native owner's persisted marker can name a worker in this profile's store."""
    if not payload:
        return None
    try:
        record = json.loads(payload)
        if Path(record['db']).resolve() != (home / 'state.db').resolve():
            return None
        session_id = record['session_id']
    except (ValueError, TypeError, KeyError):
        return None
    if not isinstance(session_id, str) or not (home / 'state.db').is_file():
        return None
    with sqlite3.connect((home / 'state.db').as_uri() + '?mode=ro', uri=True) as conn:
        exists = conn.execute('SELECT 1 FROM sessions WHERE id=?', (session_id,)).fetchone()
    return session_id if exists else None


def _task_row(record, home, profile, captured_at):
    from hermes_cli import kanban_db as kb

    expires = kb._to_epoch(record['claim_expires'])
    active = bool(record['status'] == 'running' and record['current_run_id'] == record['run_id']
                  and record['run_status'] == 'running' and record['run_profile'] == profile
                  and record['claim_lock'] and record['claim_lock'] == record['run_lock']
                  and expires is not None and expires > captured_at)
    return {'task_id': record['id'], 'title': record['title'], 'status': record['status'],
            'assignee': profile, 'active': active, 'run_id': record['run_id'],
            'run_status': record['run_status'], 'run_outcome': record['run_outcome'],
            'execution_session_id': _worker_session(home, record['owner_record']),
            'created_at': kb._to_epoch(record['created_at']),
            'started_at': kb._to_epoch(record['started_at']),
            'completed_at': kb._to_epoch(record['completed_at']),
            'updated_at': kb._to_epoch(record['last_event_at'] or record['created_at']),
            'last_event_id': record['last_event_id'], 'checklist': _checklist(record['body'])}


def task_snapshot(home, profile, *, board=None, limit=20):
    from hermes_cli import kanban_db as kb
    from tools.bot_live_delivery import _bot_chat_tip

    home = Path(home).resolve()
    slug = kb._slug_or_default(board)
    path = kb.kanban_db_path(board=slug)
    captured_at = time.time()
    records = []
    if path.is_file():
        with sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True) as conn:
            conn.row_factory = sqlite3.Row
            conn.create_function('activity_epoch', 1, kb._to_epoch, deterministic=True)
            records = conn.execute(
                "SELECT t.id,t.title,t.body,t.assignee,t.status,t.created_at,t.started_at,t.completed_at,"
                "t.current_run_id,t.claim_lock,t.claim_expires,r.id AS run_id,r.status AS run_status,"
                "r.outcome AS run_outcome,r.profile AS run_profile,r.claim_lock AS run_lock,"
                "COALESCE((SELECT MAX(e.id) FROM task_events e WHERE e.task_id=t.id),0) AS last_event_id,"
                "(SELECT MAX(e.created_at) FROM task_events e WHERE e.task_id=t.id) AS last_event_at,"
                "(SELECT e.payload FROM task_events e WHERE e.task_id=t.id AND e.run_id=r.id "
                " AND e.kind='owner_admitted' ORDER BY e.id DESC LIMIT 1) AS owner_record "
                "FROM tasks t LEFT JOIN task_runs r ON r.id=COALESCE(t.current_run_id,"
                " (SELECT MAX(previous.id) FROM task_runs previous WHERE previous.task_id=t.id)) "
                "WHERE t.assignee=? AND t.status!='archived' "
                "ORDER BY CASE WHEN t.status='running' AND t.current_run_id=r.id "
                " AND r.status='running' AND r.profile=? AND t.claim_lock!='' "
                " AND t.claim_lock=r.claim_lock AND activity_epoch(t.claim_expires)>? THEN 0 ELSE 1 END,"
                " CASE t.status WHEN 'running' THEN 0 WHEN 'ready' THEN 1 WHEN 'todo' THEN 2 "
                " WHEN 'review' THEN 3 WHEN 'triage' THEN 4 WHEN 'blocked' THEN 5 ELSE 6 END,"
                " COALESCE(last_event_at,t.created_at,0) DESC,t.id DESC LIMIT ?",
                (profile, profile, captured_at, limit + 1)).fetchall()
    rows = [_task_row(record, home, profile, captured_at) for record in records[:limit]]
    canonical = _bot_chat_tip(home)
    revision = hashlib.sha256(json.dumps({'tasks': rows, 'canonical_session_id': canonical},
                                        sort_keys=True).encode()).hexdigest()[:24]
    return {'profile': profile, 'board': slug, 'canonical_session_id': canonical,
            'captured_at': captured_at, 'revision': revision, 'tasks': rows,
            'truncated': len(records) > limit}
