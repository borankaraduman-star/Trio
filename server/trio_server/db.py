"""SQLite storage: one aiosqlite connection, plain SQL, schema created on startup."""

from __future__ import annotations

import asyncio
import hashlib
import sqlite3
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any
from urllib.parse import quote

import aiosqlite

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    name_key   TEXT NOT NULL UNIQUE,   -- NFKC + casefold: the case-insensitive identity
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens (
    token_hash TEXT PRIMARY KEY,       -- SHA-256 hex; the token itself is never stored
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS channels (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('text', 'voice')),
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    author_id  INTEGER NOT NULL REFERENCES users(id),
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_channel_id ON messages (channel_id, id);
-- v2. Added with IF NOT EXISTS, so a database created by v1 gains it on boot.
CREATE TABLE IF NOT EXISTS attachments (
    id           TEXT PRIMARY KEY,     -- 32 random bytes, urlsafe; also the stored file's name
    uploader_id  INTEGER NOT NULL REFERENCES users(id),
    message_id   INTEGER REFERENCES messages(id) ON DELETE CASCADE,  -- NULL until sent
    position     INTEGER,              -- order within the message
    filename     TEXT NOT NULL,        -- sanitised display name, never a path
    content_type TEXT NOT NULL,
    size         INTEGER NOT NULL,
    created_at   TEXT NOT NULL,
    created_ts   REAL NOT NULL         -- the app clock's seconds; what the orphan sweep reads
);
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments (message_id, position);
CREATE INDEX IF NOT EXISTS idx_attachments_orphans ON attachments (created_ts)
    WHERE message_id IS NULL;
"""

SEED_CHANNELS = (("genel", "text"), ("Sohbet", "voice"))


def utc_now() -> str:
    """ISO-8601 UTC with milliseconds and a trailing Z."""
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def attachment_url(attachment_id: str, filename: str) -> str:
    return f"/api/files/{attachment_id}/{quote(filename, safe='')}"


def _attachment(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "filename": row["filename"],
        "content_type": row["content_type"],
        "size": row["size"],
        "url": attachment_url(row["id"], row["filename"]),
    }


class InvalidAttachmentError(Exception):
    pass


class NameTakenError(Exception):
    pass


class ServerFullError(Exception):
    pass


class Database:
    def __init__(self, path: str) -> None:
        self._path = path
        self._conn: aiosqlite.Connection | None = None
        # Callers hold this across "write, then broadcast" so that the order
        # of events on the websocket is the order of ids in the database.
        self.write_lock = asyncio.Lock()

    @property
    def conn(self) -> aiosqlite.Connection:
        if self._conn is None:
            raise RuntimeError("database is not open")
        return self._conn

    async def open(self) -> None:
        self._conn = await aiosqlite.connect(self._path)
        self._conn.row_factory = sqlite3.Row
        await self._conn.execute("PRAGMA journal_mode=WAL")
        await self._conn.execute("PRAGMA foreign_keys=ON")
        await self._conn.execute("PRAGMA synchronous=NORMAL")
        await self._conn.execute("PRAGMA busy_timeout=5000")
        await self._conn.executescript(SCHEMA)
        async with self._conn.execute("SELECT count(*) FROM channels") as cur:
            (count,) = await cur.fetchone()
        if count == 0:
            now = utc_now()
            await self._conn.executemany(
                "INSERT INTO channels (name, kind, created_at) VALUES (?, ?, ?)",
                [(name, kind, now) for name, kind in SEED_CHANNELS],
            )
        await self._conn.commit()

    async def close(self) -> None:
        if self._conn is not None:
            await self._conn.close()
            self._conn = None

    async def _all(self, sql: str, params: tuple[Any, ...] = ()) -> list[sqlite3.Row]:
        async with self.conn.execute(sql, params) as cur:
            return list(await cur.fetchall())

    # -- users and tokens ---------------------------------------------------

    async def list_users(self) -> list[dict[str, Any]]:
        rows = await self._all("SELECT id, name FROM users ORDER BY id")
        return [{"id": r["id"], "name": r["name"]} for r in rows]

    async def create_user(
        self, name: str, name_key: str, token_hash: str, max_users: int
    ) -> dict[str, Any]:
        """Insert a user and their token. The caller holds ``write_lock``."""
        rows = await self._all("SELECT 1 FROM users WHERE name_key = ?", (name_key,))
        if rows:
            raise NameTakenError
        (count_row,) = await self._all("SELECT count(*) AS n FROM users")
        if count_row["n"] >= max_users:
            raise ServerFullError
        now = utc_now()
        try:
            cur = await self.conn.execute(
                "INSERT INTO users (name, name_key, created_at) VALUES (?, ?, ?)",
                (name, name_key, now),
            )
            user_id = cur.lastrowid
            await self.conn.execute(
                "INSERT INTO tokens (token_hash, user_id, created_at) VALUES (?, ?, ?)",
                (token_hash, user_id, now),
            )
            await self.conn.commit()
        except sqlite3.IntegrityError as exc:
            await self.conn.rollback()
            raise NameTakenError from exc
        except BaseException:
            await self.conn.rollback()
            raise
        return {"id": user_id, "name": name}

    async def user_for_token(self, token: str) -> dict[str, Any] | None:
        rows = await self._all(
            "SELECT u.id, u.name FROM tokens t JOIN users u ON u.id = t.user_id "
            "WHERE t.token_hash = ?",
            (hash_token(token),),
        )
        if not rows:
            return None
        return {"id": rows[0]["id"], "name": rows[0]["name"]}

    # -- channels -----------------------------------------------------------

    async def list_channels(self) -> list[dict[str, Any]]:
        rows = await self._all("SELECT id, name, kind FROM channels ORDER BY id")
        return [{"id": r["id"], "name": r["name"], "kind": r["kind"]} for r in rows]

    async def create_channel(self, name: str, kind: str) -> dict[str, Any]:
        """The caller holds ``write_lock``."""
        cur = await self.conn.execute(
            "INSERT INTO channels (name, kind, created_at) VALUES (?, ?, ?)",
            (name, kind, utc_now()),
        )
        await self.conn.commit()
        return {"id": cur.lastrowid, "name": name, "kind": kind}

    # -- messages -----------------------------------------------------------

    async def create_message(
        self,
        channel_id: int,
        author: dict[str, Any],
        content: str,
        attachment_ids: Sequence[str] = (),
        *,
        not_before_ts: float | None = None,
    ) -> dict[str, Any]:
        """Insert a message and claim its attachments, all or nothing.

        Every id must be the author's own upload, not on a message yet and (when
        ``not_before_ts`` is given) not older than it; otherwise
        ``InvalidAttachmentError`` and nothing is written. The caller holds
        ``write_lock``.
        """
        attachments: list[dict[str, Any]] = []
        if attachment_ids:
            if len(set(attachment_ids)) != len(attachment_ids):
                raise InvalidAttachmentError
            marks = ",".join("?" * len(attachment_ids))
            # Only "?" placeholders are formatted into the statement.
            sql = f"SELECT * FROM attachments WHERE id IN ({marks}) AND uploader_id = ?"  # noqa: S608
            rows = await self._all(sql + " AND message_id IS NULL", (*attachment_ids, author["id"]))
            by_id = {r["id"]: r for r in rows}
            if len(by_id) != len(attachment_ids):
                raise InvalidAttachmentError
            if not_before_ts is not None and any(r["created_ts"] < not_before_ts for r in rows):
                raise InvalidAttachmentError
            attachments = [_attachment(by_id[i]) for i in attachment_ids]
        now = utc_now()
        try:
            cur = await self.conn.execute(
                "INSERT INTO messages (channel_id, author_id, content, created_at) "
                "VALUES (?, ?, ?, ?)",
                (channel_id, author["id"], content, now),
            )
            message_id = cur.lastrowid
            await self.conn.executemany(
                "UPDATE attachments SET message_id = ?, position = ? WHERE id = ?",
                [(message_id, pos, att_id) for pos, att_id in enumerate(attachment_ids)],
            )
            await self.conn.commit()
        except BaseException:
            await self.conn.rollback()
            raise
        return {
            "id": message_id,
            "channel_id": channel_id,
            "author": {"id": author["id"], "name": author["name"]},
            "content": content,
            "created_at": now,
            "attachments": attachments,
        }

    async def list_messages(
        self, channel_id: int, before: int | None, limit: int
    ) -> tuple[list[dict[str, Any]], bool]:
        """The newest ``limit`` messages older than ``before``, oldest first."""
        sql = (
            "SELECT m.id, m.channel_id, m.content, m.created_at, u.id AS author_id, "
            "u.name AS author_name FROM messages m JOIN users u ON u.id = m.author_id "
            "WHERE m.channel_id = ?"
        )
        params: list[Any] = [channel_id]
        if before is not None:
            sql += " AND m.id < ?"
            params.append(before)
        sql += " ORDER BY m.id DESC LIMIT ?"
        params.append(limit + 1)
        rows = await self._all(sql, tuple(params))
        has_more = len(rows) > limit
        page = rows[:limit]
        page.reverse()
        by_message: dict[int, list[dict[str, Any]]] = {r["id"]: [] for r in page}
        if page:
            marks = ",".join("?" * len(page))
            # Only "?" placeholders are formatted into the statement.
            sql = f"SELECT * FROM attachments WHERE message_id IN ({marks})"  # noqa: S608
            for a in await self._all(sql + " ORDER BY message_id, position", tuple(by_message)):
                by_message[a["message_id"]].append(_attachment(a))
        messages = [
            {
                "id": r["id"],
                "channel_id": r["channel_id"],
                "author": {"id": r["author_id"], "name": r["author_name"]},
                "content": r["content"],
                "created_at": r["created_at"],
                "attachments": by_message[r["id"]],
            }
            for r in page
        ]
        return messages, has_more

    # -- attachments ----------------------------------------------------------

    async def create_attachment(
        self,
        attachment_id: str,
        uploader_id: int,
        filename: str,
        content_type: str,
        size: int,
        created_ts: float,
    ) -> dict[str, Any]:
        """The caller holds ``write_lock``."""
        await self.conn.execute(
            "INSERT INTO attachments (id, uploader_id, filename, content_type, size, "
            "created_at, created_ts) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (attachment_id, uploader_id, filename, content_type, size, utc_now(), created_ts),
        )
        await self.conn.commit()
        return {
            "id": attachment_id,
            "filename": filename,
            "content_type": content_type,
            "size": size,
            "url": attachment_url(attachment_id, filename),
        }

    async def get_attachment(self, attachment_id: str) -> dict[str, Any] | None:
        rows = await self._all("SELECT * FROM attachments WHERE id = ?", (attachment_id,))
        return _attachment(rows[0]) if rows else None

    async def orphan_attachment_ids(self, older_than_ts: float) -> list[str]:
        rows = await self._all(
            "SELECT id FROM attachments WHERE message_id IS NULL AND created_ts < ?",
            (older_than_ts,),
        )
        return [r["id"] for r in rows]

    async def delete_attachments(self, attachment_ids: Sequence[str]) -> None:
        """The caller holds ``write_lock``."""
        await self.conn.executemany(
            "DELETE FROM attachments WHERE id = ? AND message_id IS NULL",
            [(i,) for i in attachment_ids],
        )
        await self.conn.commit()
