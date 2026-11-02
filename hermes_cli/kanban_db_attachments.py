"""Attachment metadata insertion; the blob writer and public API stay on kanban_db."""


def insert_attachment(conn, task_id, *, filename, stored_path, content_type, size,
                      uploaded_by, actor_profile):
    import time
    from hermes_cli import kanban_db as kb

    if not filename or not filename.strip():
        raise ValueError('attachment filename is required')
    if not stored_path or not stored_path.strip():
        raise ValueError('attachment stored_path is required')
    with kb.write_txn(conn):
        kb._require_task(conn, task_id)
        assignee = conn.execute('SELECT assignee FROM tasks WHERE id=?', (task_id,)).fetchone()[0]
        cur = conn.execute(
            'INSERT INTO task_attachments '
            '(task_id, filename, stored_path, content_type, size, uploaded_by, created_at) '
            'VALUES (?, ?, ?, ?, ?, ?, ?)',
            (task_id, filename.strip(), stored_path, content_type, int(size), uploaded_by, int(time.time())))
        kb._append_event(conn, task_id, 'attached', {
            'filename': filename.strip(), 'size': int(size), 'by': uploaded_by,
            'attachment_id': cur.lastrowid, 'actor_profile': actor_profile, 'assignee': assignee})
        return int(cur.lastrowid or 0)
