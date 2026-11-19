"""Tables of the owner / operations layer (CONTRACT-V6-OPS).

They are created lazily, on first use, with ``CREATE TABLE IF NOT EXISTS``:
an older database (or a restored one) gains them the first time somebody
needs them, and nothing in ``db.SCHEMA`` changes.

    meta           key/value facts about the server itself (``last_backup``)
    client_errors  the client's uncaught errors, deduplicated, at most 200 rows
"""

from __future__ import annotations

import json
from typing import Any

from trio_server.db import Database

OPS_SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL          -- JSON
);
CREATE TABLE IF NOT EXISTS client_errors (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    hash     TEXT NOT NULL UNIQUE,  -- SHA-256 of message + top stack frame
    message  TEXT NOT NULL,
    stack    TEXT NOT NULL,
    context  TEXT NOT NULL,
    browser  TEXT NOT NULL,
    versions TEXT NOT NULL,         -- JSON list of "version (build)", newest last, at most 5
    user_id  INTEGER,               -- who reported it last
    count    INTEGER NOT NULL,
    first_at TEXT NOT NULL,
    last_at  TEXT NOT NULL,
    last_ts  REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_client_errors_last ON client_errors (last_ts);
"""

_READY_ATTR = "_ops_schema_ready"


async def ensure_ops_schema(db: Database) -> None:
    """Idempotent. Call it BEFORE taking ``db.write_lock`` (it takes the lock)."""
    if getattr(db, _READY_ATTR, False):
        return
    async with db.write_lock:
        await db.conn.executescript(OPS_SCHEMA)
        await db.conn.commit()
    setattr(db, _READY_ATTR, True)


async def get_meta(db: Database, key: str) -> Any:
    await ensure_ops_schema(db)
    async with db.conn.execute("SELECT value FROM meta WHERE key = ?", (key,)) as cur:
        row = await cur.fetchone()
    return None if row is None else json.loads(row[0])


async def set_meta_locked(db: Database, key: str, value: Any) -> None:
    """The caller ran ``ensure_ops_schema`` and holds ``write_lock``."""
    await db.conn.execute(
        "INSERT INTO meta (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, json.dumps(value)),
    )
    await db.conn.commit()
