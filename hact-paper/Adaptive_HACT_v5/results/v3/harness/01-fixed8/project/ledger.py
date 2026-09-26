"""Idempotent ledger with SQLite-managed atomic commits and rollback."""
import sqlite3


def apply(path, event, account, delta):
    if not isinstance(event, str) or not event or not isinstance(account, str) or not account:
        raise ValueError('nonempty event and account required')
    if type(delta) is not int:
        raise ValueError('integer delta required')
    with sqlite3.connect(path, timeout=5) as db:
        db.execute('CREATE TABLE IF NOT EXISTS entries(event TEXT PRIMARY KEY, account TEXT, delta INTEGER)')
        existing = db.execute('SELECT account, delta FROM entries WHERE event=?', (event,)).fetchone()
        if existing is not None and existing != (account, delta):
            raise ValueError('conflicting idempotency key')
        if existing is None:
            db.execute('INSERT INTO entries VALUES(?,?,?)', (event, account, delta))
        return db.execute('SELECT COALESCE(SUM(delta),0) FROM entries WHERE account=?', (account,)).fetchone()[0]
