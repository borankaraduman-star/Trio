"""SQLite storage: one aiosqlite connection, plain SQL, schema created on startup."""

from __future__ import annotations

import asyncio
import hashlib
import json
import sqlite3
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any
from urllib.parse import quote

import aiosqlite

from trio_server.links import links_to_store

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
CREATE INDEX IF NOT EXISTS idx_attachments_uploader ON attachments (uploader_id);
-- v3: one-time codes that sign another device in as an existing user.
CREATE TABLE IF NOT EXISTS link_codes (
    code_hash  TEXT PRIMARY KEY,       -- SHA-256 hex; the code itself is never stored
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_ts REAL NOT NULL,
    expires_ts REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_link_codes_user ON link_codes (user_id, expires_ts);
-- v11 (CONTRACT-V11-ADDRESS §3): one-time codes that move a device to the
-- canonical address. Not link codes: their own table, hash prefix and quota.
CREATE TABLE IF NOT EXISTS move_codes (
    code_hash       TEXT PRIMARY KEY,  -- SHA-256 hex ("trio-move:" + code)
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    from_token_hash TEXT NOT NULL,     -- the session being moved; one live code each
    prefs           TEXT NOT NULL,     -- JSON object of carried preferences
    created_ts      REAL NOT NULL,
    expires_ts      REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_move_codes_from ON move_codes (from_token_hash);
-- v4 (CONTRACT-V4 B): reactions and pins. A message's rows go with it (the
-- delete removes them explicitly too, so it does not depend on the pragma).
CREATE TABLE IF NOT EXISTS reactions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,  -- order of first use
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    key        TEXT NOT NULL,                      -- one emoji, or :name:
    user_id    INTEGER NOT NULL REFERENCES users(id),
    UNIQUE (message_id, key, user_id)
);
CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions (message_id, id);
CREATE TABLE IF NOT EXISTS pins (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,  -- newest pin = largest id
    message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
    channel_id INTEGER NOT NULL,
    pinned_by  INTEGER NOT NULL REFERENCES users(id),
    pinned_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pins_channel ON pins (channel_id, id);
-- v4 (CONTRACT-V4 C): the server's own name and icon; exactly one row.
CREATE TABLE IF NOT EXISTS server_profile (
    id   INTEGER PRIMARY KEY CHECK (id = 1),
    name TEXT NOT NULL,
    icon TEXT                 -- "<hash>.<ext>" under <uploads>/icons/, or NULL
);
INSERT OR IGNORE INTO server_profile (id, name) VALUES (1, 'Trio');
-- v6 (CONTRACT-V6-MEDIA): every http(s) link of every message, as the
-- client's linkify finds them (trio_server/links.py). Rewritten on edit, gone
-- with the message.
CREATE TABLE IF NOT EXISTS links (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    channel_id INTEGER NOT NULL,
    position   INTEGER NOT NULL,             -- order within the message
    url        TEXT NOT NULL                 -- the text as written
);
CREATE INDEX IF NOT EXISTS idx_links_channel ON links (channel_id, message_id, position);
CREATE INDEX IF NOT EXISTS idx_links_message ON links (message_id);
-- v6: how far the one-time indexing of messages written before v6 has got.
CREATE TABLE IF NOT EXISTS links_backfill (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    done_through INTEGER NOT NULL
);
-- v7 (CONTRACT-V7-READING): how far each user has read each text channel.
CREATE TABLE IF NOT EXISTS read_state (
    user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id           INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    last_read_message_id INTEGER NOT NULL,
    updated_at           TEXT NOT NULL,
    PRIMARY KEY (user_id, channel_id)
);
"""

# v3 columns on tables an older database already has. CREATE TABLE IF NOT
# EXISTS cannot add a column, so each one is an ALTER run only when missing.
#   users.removed_at: set by `python -m trio_server.admin remove-user`. The row
#   (and its name) stays so that old messages still show who wrote them; its
#   name_key is replaced, which frees the name for somebody new.
#   messages.edited_at / reply_to_id / rev (v4): an edit's time, the id of the
#   message replied to (no foreign key: the target may be deleted later and the
#   reply then shows it as deleted), and a counter of later changes.
# No index may be created on these columns in SCHEMA: SCHEMA runs before them.
#   users.avatar (v4): "<hash>.<ext>", the file <uploads>/avatars/<id>-<hash>.<ext>.
#   attachments.deleted_at (v6 ops): the uploader deleted the file; the row stays
#   as the message's tombstone ({id, filename, deleted: true}) and no longer
#   counts towards the quota.
#   tokens.last_origin / via_move / moved_from (v11, CONTRACT-V11-ADDRESS §4):
#   the origin the session was last seen through, whether a move created it,
#   and the old session a move will end once this one is confirmed.
UPGRADE_COLUMNS = {
    "tokens": {
        "last_origin": "ALTER TABLE tokens ADD COLUMN last_origin TEXT",
        "via_move": "ALTER TABLE tokens ADD COLUMN via_move INTEGER NOT NULL DEFAULT 0",
        "moved_from": "ALTER TABLE tokens ADD COLUMN moved_from TEXT",
    },
    "users": {
        "removed_at": "ALTER TABLE users ADD COLUMN removed_at TEXT",
        "avatar": "ALTER TABLE users ADD COLUMN avatar TEXT",
    },
    "messages": {
        "edited_at": "ALTER TABLE messages ADD COLUMN edited_at TEXT",
        "reply_to_id": "ALTER TABLE messages ADD COLUMN reply_to_id INTEGER",
        "rev": "ALTER TABLE messages ADD COLUMN rev INTEGER NOT NULL DEFAULT 0",
    },
    "attachments": {
        "deleted_at": "ALTER TABLE attachments ADD COLUMN deleted_at TEXT",
        "width": "ALTER TABLE attachments ADD COLUMN width INTEGER",
        "height": "ALTER TABLE attachments ADD COLUMN height INTEGER",
        "preview_type": "ALTER TABLE attachments ADD COLUMN preview_type TEXT",
        "preview_size": "ALTER TABLE attachments ADD COLUMN preview_size INTEGER",
        "voice": "ALTER TABLE attachments ADD COLUMN voice TEXT",
    },
}

# SQLite's INTEGER is a signed 64-bit value; a larger Python int cannot be bound.
SQL_INT_MAX = 2**63 - 1


def upgrade_statements(table: str, existing_columns: set[str]) -> list[str]:
    return [
        sql
        for column, sql in UPGRADE_COLUMNS.get(table, {}).items()
        if column not in existing_columns
    ]


def removed_name_key(user_id: int) -> str:
    """The name_key a removed user is given: unique, and never what name_key() returns."""
    return f"#removed:{user_id}"


SEED_CHANNELS = (("genel", "text"), ("Sohbet", "voice"))


def utc_now() -> str:
    """ISO-8601 UTC with milliseconds and a trailing Z."""
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def utc_iso(ts: float) -> str:
    """An app-clock timestamp (seconds) in the same format as ``utc_now``."""
    return datetime.fromtimestamp(ts, UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def attachment_url(attachment_id: str, filename: str) -> str:
    return f"/api/files/{attachment_id}/{quote(filename, safe='')}"


def avatar_url(user_id: int, avatar: str | None) -> str | None:
    return None if avatar is None else f"/api/avatars/{user_id}/{avatar}"


def icon_url(icon: str | None) -> str | None:
    return None if icon is None else f"/api/server/icon/{icon}"


def _user(user_id: int, name: str, avatar: str | None) -> dict[str, Any]:
    """A ``User`` as the wire carries it (CONTRACT-V4 C adds ``avatar_url``)."""
    return {"id": user_id, "name": name, "avatar_url": avatar_url(user_id, avatar)}


def preview_url(attachment_id: str) -> str:
    return f"/api/previews/{attachment_id}"


def _attachment(row: sqlite3.Row) -> dict[str, Any]:
    if row["deleted_at"] is not None:
        # CONTRACT-V6-OPS §4: what is left of a file its uploader deleted.
        return {"id": row["id"], "filename": row["filename"], "deleted": True}
    keys = row.keys()
    # v6 fields (CONTRACT-V6-MEDIA); every key is always present, null when unknown.
    voice = row["voice"] if "voice" in keys else None
    return {
        "id": row["id"],
        "filename": row["filename"],
        "content_type": row["content_type"],
        "size": row["size"],
        "url": attachment_url(row["id"], row["filename"]),
        "preview_url": (
            preview_url(row["id"])
            if "preview_type" in keys and row["preview_type"] is not None
            else None
        ),
        "width": row["width"] if "width" in keys else None,
        "height": row["height"] if "height" in keys else None,
        "voice": json.loads(voice) if voice else None,
    }


class InvalidAttachmentError(Exception):
    pass


class InvalidReplyError(Exception):
    """``reply_to`` names no message in the same channel."""


class MessageNotFoundError(Exception):
    pass


class NotAuthorError(Exception):
    pass


class EmptyMessageError(Exception):
    """An edit would leave a message with neither content nor attachments."""


class ReactionLimitError(Exception):
    pass


class PinLimitError(Exception):
    pass


EXCERPT_CHARS = 140
# V6: the types the gallery's "Medya" tab lists.
MEDIA_TYPES = frozenset(
    {"image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "video/mp4", "video/webm"}
)
# Every column a Message is built from; the joins are the same everywhere.
_MESSAGE_COLUMNS = (
    "m.id, m.channel_id, m.content, m.created_at, m.edited_at, m.reply_to_id, m.rev, "
    "u.id AS author_id, u.name AS author_name, u.avatar AS author_avatar"
)
_MESSAGE_FROM = "FROM messages m JOIN users u ON u.id = m.author_id"


def _marks(values: Sequence[Any]) -> str:
    return ",".join("?" * len(values))


class NameTakenError(Exception):
    pass


class ServerFullError(Exception):
    pass


class TooManyLinkCodesError(Exception):
    pass


class StorageFullError(Exception):
    """SQLite could not write because the disk (or the volume) is full."""


def is_disk_full(exc: BaseException) -> bool:
    return isinstance(exc, sqlite3.OperationalError) and "full" in str(exc).lower()


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
        for table in UPGRADE_COLUMNS:
            columns = {r["name"] for r in await self._all(f"PRAGMA table_info({table})")}
            for sql in upgrade_statements(table, columns):
                await self._conn.execute(sql)
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
        rows = await self._all(
            "SELECT id, name, avatar FROM users WHERE removed_at IS NULL ORDER BY id"
        )
        return [_user(r["id"], r["name"], r["avatar"]) for r in rows]

    async def create_user(
        self, name: str, name_key: str, token_hash: str, max_users: int
    ) -> dict[str, Any]:
        """Insert a user and their token. The caller holds ``write_lock``."""
        rows = await self._all("SELECT 1 FROM users WHERE name_key = ?", (name_key,))
        if rows:
            raise NameTakenError
        # A removed user no longer holds a slot.
        (count_row,) = await self._all("SELECT count(*) AS n FROM users WHERE removed_at IS NULL")
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
        return _user(user_id, name, None)

    async def user_for_token(self, token: str) -> dict[str, Any] | None:
        return await self.user_for_token_hash(hash_token(token))

    async def user_for_token_hash(self, token_hash: str) -> dict[str, Any] | None:
        rows = await self._all(
            "SELECT u.id, u.name, u.avatar FROM tokens t JOIN users u ON u.id = t.user_id "
            "WHERE t.token_hash = ? AND u.removed_at IS NULL",
            (token_hash,),
        )
        if not rows:
            return None
        return _user(rows[0]["id"], rows[0]["name"], rows[0]["avatar"])

    async def live_token_hashes(self, token_hashes: Sequence[str]) -> set[str]:
        """Which of ``token_hashes`` still sign somebody in."""
        live: set[str] = set()
        hashes = list(token_hashes)
        for start in range(0, len(hashes), 500):
            chunk = hashes[start : start + 500]
            marks = ",".join("?" * len(chunk))
            # Only "?" placeholders are formatted into the statement.
            sql = (
                "SELECT t.token_hash FROM tokens t JOIN users u ON u.id = t.user_id "  # noqa: S608
                f"WHERE u.removed_at IS NULL AND t.token_hash IN ({marks})"
            )
            live.update(r["token_hash"] for r in await self._all(sql, tuple(chunk)))
        return live

    async def delete_token(self, token_hash: str) -> bool:
        """The caller holds ``write_lock``."""
        cur = await self.conn.execute("DELETE FROM tokens WHERE token_hash = ?", (token_hash,))
        await self.conn.commit()
        return cur.rowcount > 0

    # -- link codes -----------------------------------------------------------

    async def create_link_code(
        self, user_id: int, code_hash: str, now_ts: float, ttl: float, max_live: int
    ) -> float:
        """Store a code for ``user_id``; its expiry. The caller holds ``write_lock``."""
        try:
            # Expired codes are worthless; this is their sweep.
            await self.conn.execute("DELETE FROM link_codes WHERE expires_ts <= ?", (now_ts,))
            (row,) = await self._all(
                "SELECT count(*) AS n FROM link_codes WHERE user_id = ?", (user_id,)
            )
            if row["n"] >= max_live:
                await self.conn.commit()
                raise TooManyLinkCodesError
            expires = now_ts + ttl
            await self.conn.execute(
                "INSERT INTO link_codes (code_hash, user_id, created_ts, expires_ts) "
                "VALUES (?, ?, ?, ?)",
                (code_hash, user_id, now_ts, expires),
            )
            await self.conn.commit()
        except TooManyLinkCodesError:
            raise
        except BaseException:
            await self.conn.rollback()
            raise
        return expires

    async def redeem_link_code(
        self, code_hash: str, now_ts: float, token_hash: str
    ) -> dict[str, Any] | None:
        """Use a code once: delete it and give its user a new token, all or nothing.

        None for an unknown, expired or used code, or a removed user. The
        caller holds ``write_lock``.
        """
        try:
            rows = await self._all(
                "DELETE FROM link_codes WHERE code_hash = ? AND expires_ts > ? RETURNING user_id",
                (code_hash, now_ts),
            )
            user = None
            if rows:
                found = await self._all(
                    "SELECT id, name, avatar FROM users WHERE id = ? AND removed_at IS NULL",
                    (rows[0]["user_id"],),
                )
                if found:
                    user = _user(found[0]["id"], found[0]["name"], found[0]["avatar"])
                    await self.conn.execute(
                        "INSERT INTO tokens (token_hash, user_id, created_at) VALUES (?, ?, ?)",
                        (token_hash, user["id"], utc_now()),
                    )
            await self.conn.commit()
        except BaseException:
            await self.conn.rollback()
            raise
        return user

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
        reply_to: int | None = None,
    ) -> dict[str, Any]:
        """Insert a message and claim its attachments, all or nothing.

        ``reply_to`` must be a message in the same channel, else
        ``InvalidReplyError`` and nothing is written.

        Every id must be the author's own upload, not on a message yet and (when
        ``not_before_ts`` is given) not older than it; otherwise
        ``InvalidAttachmentError`` and nothing is written. The caller holds
        ``write_lock``.
        """
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
        if reply_to is not None:
            target = await self._all(
                "SELECT 1 FROM messages WHERE id = ? AND channel_id = ?", (reply_to, channel_id)
            )
            if not target:
                raise InvalidReplyError
        now = utc_now()
        try:
            cur = await self.conn.execute(
                "INSERT INTO messages (channel_id, author_id, content, created_at, reply_to_id) "
                "VALUES (?, ?, ?, ?, ?)",
                (channel_id, author["id"], content, now, reply_to),
            )
            message_id = cur.lastrowid
            await self.conn.executemany(
                "UPDATE attachments SET message_id = ?, position = ? WHERE id = ?",
                [(message_id, pos, att_id) for pos, att_id in enumerate(attachment_ids)],
            )
            for sql, params in link_statements(message_id, channel_id, content):
                await self.conn.execute(sql, params)
            await self.conn.commit()
        except BaseException as exc:
            await self.conn.rollback()
            if is_disk_full(exc):
                raise StorageFullError from exc
            raise
        message = await self.get_message(message_id)
        assert message is not None  # noqa: S101 - written just above, under the lock
        return message

    async def list_messages(
        self, channel_id: int, before: int | None, limit: int
    ) -> tuple[list[dict[str, Any]], bool]:
        """The newest ``limit`` messages older than ``before``, oldest first."""
        sql = f"SELECT {_MESSAGE_COLUMNS} {_MESSAGE_FROM} WHERE m.channel_id = ?"  # noqa: S608
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
        return await self._hydrate(page), has_more

    # -- the message family (CONTRACT-V4 B) -----------------------------------

    async def _hydrate(self, rows: Sequence[sqlite3.Row]) -> list[dict[str, Any]]:
        """Messages from their rows: attachments, reactions, pin and reply
        target in one query each, whatever the page size (statements stay
        under SQLite's variable limit: pages are at most 100, pins 50)."""
        if not rows:
            return []
        ids = [r["id"] for r in rows]
        marks = _marks(ids)
        attachments: dict[int, list[dict[str, Any]]] = {i: [] for i in ids}
        # Only "?" placeholders are formatted into these statements.
        sql = f"SELECT * FROM attachments WHERE message_id IN ({marks})"  # noqa: S608
        for a in await self._all(sql + " ORDER BY message_id, position", tuple(ids)):
            attachments[a["message_id"]].append(_attachment(a))
        reactions: dict[int, dict[str, list[int]]] = {i: {} for i in ids}
        sql = f"SELECT message_id, key, user_id FROM reactions WHERE message_id IN ({marks})"  # noqa: S608
        for r in await self._all(sql + " ORDER BY id", tuple(ids)):
            # dicts keep insertion order: keys by first use, users by when.
            reactions[r["message_id"]].setdefault(r["key"], []).append(r["user_id"])
        sql = f"SELECT message_id, pinned_by, pinned_at FROM pins WHERE message_id IN ({marks})"  # noqa: S608
        pins = {p["message_id"]: p for p in await self._all(sql, tuple(ids))}
        targets = await self._reply_targets({r["reply_to_id"] for r in rows} - {None})
        messages = []
        for r in rows:
            pin = pins.get(r["id"])
            reply_id = r["reply_to_id"]
            messages.append(
                {
                    "id": r["id"],
                    "channel_id": r["channel_id"],
                    "author": _user(r["author_id"], r["author_name"], r["author_avatar"]),
                    "content": r["content"],
                    "created_at": r["created_at"],
                    "attachments": attachments[r["id"]],
                    "edited_at": r["edited_at"],
                    "reply_to": (
                        None
                        if reply_id is None
                        else targets.get(reply_id, {"id": reply_id, "deleted": True})
                    ),
                    "reactions": [
                        {"key": key, "count": len(users), "user_ids": users}
                        for key, users in reactions[r["id"]].items()
                    ],
                    "pinned_at": pin["pinned_at"] if pin else None,
                    "pinned_by": pin["pinned_by"] if pin else None,
                    "rev": r["rev"],
                }
            )
        return messages

    async def _reply_targets(self, ids: set[int]) -> dict[int, dict[str, Any]]:
        if not ids:
            return {}
        wanted = sorted(ids)
        # Only "?" placeholders are formatted into the statement.
        sql = (
            "SELECT m.id, m.content, u.id AS author_id, u.name AS author_name, "  # noqa: S608
            "(SELECT a.filename FROM attachments a WHERE a.message_id = m.id "
            "AND a.deleted_at IS NULL ORDER BY a.position LIMIT 1) AS first_file "
            f"{_MESSAGE_FROM} WHERE m.id IN ({_marks(wanted)})"
        )
        found = {}
        for r in await self._all(sql, tuple(wanted)):
            excerpt = r["content"][:EXCERPT_CHARS]
            if not excerpt and r["first_file"] is not None:
                excerpt = "📎 " + r["first_file"]
            found[r["id"]] = {
                "id": r["id"],
                "author": {"id": r["author_id"], "name": r["author_name"]},
                "excerpt": excerpt,
            }
        return found

    async def get_message(self, message_id: int) -> dict[str, Any] | None:
        rows = await self._all(
            f"SELECT {_MESSAGE_COLUMNS} {_MESSAGE_FROM} WHERE m.id = ?",  # noqa: S608
            (message_id,),
        )
        found = await self._hydrate(rows)
        return found[0] if found else None

    async def _message_row(self, message_id: int) -> sqlite3.Row:
        rows = await self._all(
            "SELECT id, channel_id, author_id, content FROM messages WHERE id = ?", (message_id,)
        )
        if not rows:
            raise MessageNotFoundError
        return rows[0]

    async def _write(self, statements: Sequence[tuple[str, tuple[Any, ...]]]) -> None:
        """Run ``statements`` as one transaction."""
        try:
            for sql, params in statements:
                await self.conn.execute(sql, params)
            await self.conn.commit()
        except BaseException as exc:
            await self.conn.rollback()
            if is_disk_full(exc):
                raise StorageFullError from exc
            raise

    async def _changed(self, message_id: int, *extra: tuple[str, tuple[Any, ...]]) -> None:
        await self._write(
            [*extra, ("UPDATE messages SET rev = rev + 1 WHERE id = ?", (message_id,))]
        )

    async def edit_message(
        self, message_id: int, user_id: int, content: str, edited_at: str
    ) -> tuple[dict[str, Any], bool]:
        """Replace the content: (the message, whether anything changed).

        The caller holds ``write_lock``. Raises ``MessageNotFoundError``,
        ``NotAuthorError`` or ``EmptyMessageError``; nothing is written then.
        """
        row = await self._message_row(message_id)
        if row["author_id"] != user_id:
            raise NotAuthorError
        if not content:
            has_files = await self._all(
                "SELECT 1 FROM attachments WHERE message_id = ? AND deleted_at IS NULL LIMIT 1",
                (message_id,),
            )
            if not has_files:
                raise EmptyMessageError
        changed = content != row["content"]
        if changed:
            await self._changed(
                message_id,
                (
                    "UPDATE messages SET content = ?, edited_at = ? WHERE id = ?",
                    (content, edited_at, message_id),
                ),
                *link_statements(message_id, row["channel_id"], content),
            )
        message = await self.get_message(message_id)
        assert message is not None  # noqa: S101
        return message, changed

    async def delete_message(self, message_id: int, user_id: int) -> tuple[int, list[str]]:
        """Delete a message and everything hanging off it in ONE transaction:
        (its channel, the ids of its attachment files to unlink afterwards).

        The files are not touched here. Unlinking after the commit means a
        crash in between leaves files without rows (swept at the next start),
        never rows without files. The caller holds ``write_lock``.
        """
        row = await self._message_row(message_id)
        if row["author_id"] != user_id:
            raise NotAuthorError
        files = [
            r["id"]
            for r in await self._all(
                "SELECT id FROM attachments WHERE message_id = ?", (message_id,)
            )
        ]
        await self._write(
            [
                ("DELETE FROM reactions WHERE message_id = ?", (message_id,)),
                ("DELETE FROM pins WHERE message_id = ?", (message_id,)),
                ("DELETE FROM links WHERE message_id = ?", (message_id,)),
                ("DELETE FROM attachments WHERE message_id = ?", (message_id,)),
                ("DELETE FROM messages WHERE id = ?", (message_id,)),
            ]
        )
        return row["channel_id"], files

    async def set_reaction(
        self, message_id: int, user_id: int, key: str, on: bool, max_keys: int
    ) -> tuple[dict[str, Any], bool]:
        """Add (``on``) or remove the user's reaction ``key``: (the message,
        whether anything changed). The caller holds ``write_lock``."""
        await self._message_row(message_id)
        mine = await self._all(
            "SELECT id FROM reactions WHERE message_id = ? AND key = ? AND user_id = ?",
            (message_id, key, user_id),
        )
        changed = False
        if on and not mine:
            keys = await self._all(
                "SELECT DISTINCT key FROM reactions WHERE message_id = ?", (message_id,)
            )
            if key not in {k["key"] for k in keys} and len(keys) >= max_keys:
                raise ReactionLimitError
            await self._changed(
                message_id,
                (
                    "INSERT INTO reactions (message_id, key, user_id) VALUES (?, ?, ?)",
                    (message_id, key, user_id),
                ),
            )
            changed = True
        elif not on and mine:
            await self._changed(
                message_id, ("DELETE FROM reactions WHERE id = ?", (mine[0]["id"],))
            )
            changed = True
        message = await self.get_message(message_id)
        assert message is not None  # noqa: S101
        return message, changed

    async def set_pin(
        self, message_id: int, user_id: int, on: bool, pinned_at: str, max_pins: int
    ) -> tuple[dict[str, Any], bool]:
        """Pin or unpin (anyone may): (the message, whether anything changed).
        Pinning a pinned message keeps the first pin. The caller holds ``write_lock``."""
        row = await self._message_row(message_id)
        pinned = await self._all("SELECT 1 FROM pins WHERE message_id = ?", (message_id,))
        changed = False
        if on and not pinned:
            (count,) = await self._all(
                "SELECT count(*) AS n FROM pins WHERE channel_id = ?", (row["channel_id"],)
            )
            if count["n"] >= max_pins:
                raise PinLimitError
            await self._changed(
                message_id,
                (
                    "INSERT INTO pins (message_id, channel_id, pinned_by, pinned_at) "
                    "VALUES (?, ?, ?, ?)",
                    (message_id, row["channel_id"], user_id, pinned_at),
                ),
            )
            changed = True
        elif not on and pinned:
            await self._changed(
                message_id, ("DELETE FROM pins WHERE message_id = ?", (message_id,))
            )
            changed = True
        message = await self.get_message(message_id)
        assert message is not None  # noqa: S101
        return message, changed

    async def list_pins(self, channel_id: int) -> list[dict[str, Any]]:
        """The channel's pinned messages, newest pin first."""
        rows = await self._all(
            f"SELECT {_MESSAGE_COLUMNS} {_MESSAGE_FROM} JOIN pins p ON p.message_id = m.id "  # noqa: S608
            "WHERE p.channel_id = ? ORDER BY p.id DESC",
            (channel_id,),
        )
        return await self._hydrate(rows)

    # -- profiles (CONTRACT-V4 C) ---------------------------------------------

    async def rename_user(self, user_id: int, name: str, key: str) -> dict[str, Any]:
        """The caller holds ``write_lock``. ``NameTakenError`` when another
        user (not a removed one: their key is freed) holds the name."""
        taken = await self._all(
            "SELECT 1 FROM users WHERE name_key = ? AND id != ?", (key, user_id)
        )
        if taken:
            raise NameTakenError
        try:
            await self._write(
                [("UPDATE users SET name = ?, name_key = ? WHERE id = ?", (name, key, user_id))]
            )
        except sqlite3.IntegrityError as exc:
            raise NameTakenError from exc
        return await self.get_user(user_id)

    async def get_user(self, user_id: int) -> dict[str, Any]:
        (row,) = await self._all("SELECT id, name, avatar FROM users WHERE id = ?", (user_id,))
        return _user(row["id"], row["name"], row["avatar"])

    async def set_avatar(
        self, user_id: int, avatar: str | None
    ) -> tuple[dict[str, Any], str | None]:
        """(the user, the avatar it had). The caller holds ``write_lock``."""
        (row,) = await self._all("SELECT avatar FROM users WHERE id = ?", (user_id,))
        await self._write([("UPDATE users SET avatar = ? WHERE id = ?", (avatar, user_id))])
        return await self.get_user(user_id), row["avatar"]

    async def get_server(self) -> dict[str, Any]:
        (row,) = await self._all("SELECT name, icon FROM server_profile WHERE id = 1")
        return {"name": row["name"], "icon_url": icon_url(row["icon"])}

    async def set_server_name(self, name: str) -> dict[str, Any]:
        """The caller holds ``write_lock``."""
        await self._write([("UPDATE server_profile SET name = ? WHERE id = 1", (name,))])
        return await self.get_server()

    async def set_server_icon(self, icon: str | None) -> tuple[dict[str, Any], str | None]:
        """(the profile, the icon it had). The caller holds ``write_lock``."""
        (row,) = await self._all("SELECT icon FROM server_profile WHERE id = 1")
        await self._write([("UPDATE server_profile SET icon = ? WHERE id = 1", (icon,))])
        return await self.get_server(), row["icon"]

    async def server_icon(self) -> str | None:
        (row,) = await self._all("SELECT icon FROM server_profile WHERE id = 1")
        return row["icon"]

    async def user_avatar(self, user_id: int) -> str | None:
        """Removed users included: their old messages still show the picture."""
        rows = await self._all("SELECT avatar FROM users WHERE id = ?", (user_id,))
        return rows[0]["avatar"] if rows else None

    async def avatar_files(self) -> set[str]:
        """The file names under avatars/ that a user row names."""
        rows = await self._all("SELECT id, avatar FROM users WHERE avatar IS NOT NULL")
        return {f"{r['id']}-{r['avatar']}" for r in rows}

    async def all_attachment_ids(self) -> set[str]:
        return {r["id"] for r in await self._all("SELECT id FROM attachments")}

    # -- attachments ----------------------------------------------------------

    async def create_attachment(
        self,
        attachment_id: str,
        uploader_id: int,
        filename: str,
        content_type: str,
        size: int,
        created_ts: float,
        *,
        width: int | None = None,
        height: int | None = None,
        preview_type: str | None = None,
        preview_size: int | None = None,
        voice: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """The caller holds ``write_lock``. The keyword fields are V6's."""
        try:
            await self.conn.execute(
                "INSERT INTO attachments (id, uploader_id, filename, content_type, size, "
                "created_at, created_ts, width, height, preview_type, preview_size, voice) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    attachment_id,
                    uploader_id,
                    filename,
                    content_type,
                    size,
                    utc_now(),
                    created_ts,
                    width,
                    height,
                    preview_type,
                    preview_size,
                    json.dumps(voice, separators=(",", ":")) if voice is not None else None,
                ),
            )
            await self.conn.commit()
        except BaseException as exc:
            await self.conn.rollback()
            if is_disk_full(exc):
                raise StorageFullError from exc
            raise
        found = await self.get_attachment(attachment_id)
        assert found is not None  # noqa: S101 - written just above, under the lock
        return found

    async def stored_bytes(self, uploader_id: int) -> int:
        """Everything ``uploader_id`` has stored, on a message or not."""
        (row,) = await self._all(
            "SELECT coalesce(sum(size + coalesce(preview_size, 0)), 0) AS n "
            "FROM attachments WHERE uploader_id = ? AND deleted_at IS NULL",
            (uploader_id,),
        )
        return int(row["n"])

    async def get_attachment(self, attachment_id: str) -> dict[str, Any] | None:
        rows = await self._all(
            "SELECT * FROM attachments WHERE id = ? AND deleted_at IS NULL", (attachment_id,)
        )
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

    # -- v6: the channel's media, files and links (CONTRACT-V6-MEDIA) ---------

    async def preview_of(self, attachment_id: str) -> str | None:
        """The preview's content type, or None when the attachment has none."""
        rows = await self._all(
            "SELECT preview_type FROM attachments WHERE id = ? AND deleted_at IS NULL",
            (attachment_id,),
        )
        return rows[0]["preview_type"] if rows else None

    async def channel_attachments(
        self,
        channel_id: int,
        media: bool,
        before: tuple[int, int] | None,
        limit: int,
    ) -> tuple[list[dict[str, Any]], bool]:
        """Attachments on the channel's messages, newest message first (within
        one message in its own order), images and videos (``media``) or
        everything else; voice messages in neither. ``before`` is the
        (message id, position) of the last item already shown."""
        marks = _marks(MEDIA_TYPES)
        kind = f"a.content_type {'IN' if media else 'NOT IN'} ({marks})"
        params: list[Any] = [channel_id, *sorted(MEDIA_TYPES)]
        where = ""
        if before is not None:
            where = " AND (a.message_id < ? OR (a.message_id = ? AND a.position > ?))"
            params += [before[0], before[0], before[1]]
        # Only "?" placeholders and fixed text are formatted into the statement.
        sql = (
            "SELECT a.*, m.created_at AS message_created_at, u.id AS author_id, "  # noqa: S608
            "u.name AS author_name, u.avatar AS author_avatar "
            "FROM attachments a JOIN messages m ON m.id = a.message_id "
            "JOIN users u ON u.id = m.author_id "
            "WHERE m.channel_id = ? AND a.voice IS NULL AND a.deleted_at IS NULL "
            f"AND {kind}{where} "
            "ORDER BY a.message_id DESC, a.position ASC LIMIT ?"
        )
        rows = await self._all(sql, (*params, limit + 1))
        items = [
            {
                "attachment": _attachment(r),
                "message_id": r["message_id"],
                "position": r["position"],
                "author": _user(r["author_id"], r["author_name"], r["author_avatar"]),
                "created_at": r["message_created_at"],
            }
            for r in rows[:limit]
        ]
        return items, len(rows) > limit

    async def channel_links(
        self, channel_id: int, before: tuple[int, int] | None, limit: int
    ) -> tuple[list[dict[str, Any]], bool]:
        """Links posted in the channel, newest message first."""
        params: list[Any] = [channel_id]
        where = ""
        if before is not None:
            where = " AND (l.message_id < ? OR (l.message_id = ? AND l.position > ?))"
            params += [before[0], before[0], before[1]]
        sql = (
            "SELECT l.url, l.message_id, l.position, m.content, m.created_at, "  # noqa: S608
            "u.id AS author_id, u.name AS author_name, u.avatar AS author_avatar "
            "FROM links l JOIN messages m ON m.id = l.message_id "
            "JOIN users u ON u.id = m.author_id "
            f"WHERE l.channel_id = ?{where} ORDER BY l.message_id DESC, l.position ASC LIMIT ?"
        )
        rows = await self._all(sql, (*params, limit + 1))
        items = [
            {
                "url": r["url"],
                "message_id": r["message_id"],
                "position": r["position"],
                "author": _user(r["author_id"], r["author_name"], r["author_avatar"]),
                "created_at": r["created_at"],
                "excerpt": r["content"][:EXCERPT_CHARS],
            }
            for r in rows[:limit]
        ]
        return items, len(rows) > limit

    async def live_attachment_ids(self) -> set[str]:
        """Attachments whose file still exists (not deleted by the uploader, V6-OPS §4)."""
        rows = await self._all("SELECT id FROM attachments WHERE deleted_at IS NULL")
        return {r["id"] for r in rows}

    async def backfill_links(self, batch: int = 500) -> int:
        """Index the links of every message written since the last start (all
        of them, the first time a v6 server opens an older database). Batches
        of ``batch`` messages, one transaction each; re-indexing a message is
        idempotent, so an interrupted run simply continues. The messages sent
        while the server runs are indexed when sent and edited; this only
        covers what the database already held. Returns how many were read."""
        total = 0
        while True:
            rows = await self._all("SELECT done_through FROM links_backfill WHERE id = 1")
            done = rows[0]["done_through"] if rows else 0
            page = await self._all(
                "SELECT id, channel_id, content FROM messages WHERE id > ? ORDER BY id LIMIT ?",
                (done, batch),
            )
            if not page:
                return total
            statements: list[tuple[str, tuple[Any, ...]]] = []
            for r in page:
                statements += link_statements(r["id"], r["channel_id"], r["content"])
            statements.append(
                (
                    "INSERT INTO links_backfill (id, done_through) VALUES (1, ?) "
                    "ON CONFLICT (id) DO UPDATE SET done_through = excluded.done_through",
                    (page[-1]["id"],),
                )
            )
            await self._write(statements)
            total += len(page)


def link_statements(
    message_id: int, channel_id: int, content: str
) -> list[tuple[str, tuple[Any, ...]]]:
    """The statements that make the links table say what ``content`` links to."""
    statements: list[tuple[str, tuple[Any, ...]]] = [
        ("DELETE FROM links WHERE message_id = ?", (message_id,))
    ]
    for position, url in enumerate(links_to_store(content)):
        statements.append(
            (
                "INSERT INTO links (message_id, channel_id, position, url) VALUES (?, ?, ?, ?)",
                (message_id, channel_id, position, url),
            )
        )
    return statements
