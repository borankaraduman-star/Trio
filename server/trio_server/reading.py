"""CONTRACT-V7-READING: read state per user and channel, and channel management.

Read state: how far each user has read each text channel (the id of the
newest message they have seen), kept on the server so that the unread dots,
the counts and the tab title follow a person from one device to the next.
It is the user's OWN business: nobody else is ever told (no read receipts).

Channel management: rename (any member, like creating one) and delete (the
owner only, CONTRACT-V6-OPS §1), with what hangs off a channel cleaned up in
the same transaction.
"""

# No ``from __future__ import annotations``: the routes' dependency (``User``)
# is local to register_channel_routes and FastAPI must see it as an object.
import contextlib
import logging
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Annotated, Any

from fastapi import Depends, FastAPI, Request
from fastapi import Path as PathParam
from fastapi.responses import Response

from trio_server.db import SQL_INT_MAX, Database, StorageFullError, utc_now
from trio_server.errors import ApiError
from trio_server.hub import Hub
from trio_server.media_routes import remove_previews
from trio_server.ratelimit import SlidingWindow
from trio_server.uploads import storage_full
from trio_server.validation import clean_name

logger = logging.getLogger("trio")

# The table is ``read_state`` in db.SCHEMA (created on boot; an older database
# gains it with no rows, see CONTRACT-V7-READING §1).

# `unread` counts at most this many: "99+" is all anybody shows.
UNREAD_CAP = 100
# Renames and deletes together, per user per minute.
CHANNEL_EDIT_LIMIT = 20
CHANNEL_EDIT_WINDOW_SECONDS = 60.0

_UNREAD_SQL = (
    "SELECT count(*) FROM (SELECT 1 FROM messages "
    "WHERE channel_id = ? AND id > ? AND author_id != ? LIMIT ?)"
)


async def _scalar(db: Database, sql: str, params: tuple[Any, ...]) -> int:
    async with db.conn.execute(sql, params) as cur:
        row = await cur.fetchone()
    return int(row[0] or 0) if row is not None else 0


async def latest_message_id(db: Database, channel_id: int) -> int:
    return await _scalar(
        db, "SELECT coalesce(max(id), 0) FROM messages WHERE channel_id = ?", (channel_id,)
    )


async def unread_count(db: Database, user_id: int, channel_id: int, after: int) -> int:
    """Messages in the channel newer than ``after`` that somebody else wrote (capped)."""
    return await _scalar(db, _UNREAD_SQL, (channel_id, after, user_id, UNREAD_CAP))


async def snapshot(db: Database, hub: Hub, user_id: int) -> dict[str, dict[str, int]]:
    """``ready.read_state``: every text channel, ``{last_read, latest, unread}``.

    The caller holds ``db.write_lock`` and registers the connection before
    releasing it, so no message can be stored between this read and the
    connection starting to receive ``message.new``."""
    rows = await db._all(
        "SELECT channel_id, last_read_message_id FROM read_state WHERE user_id = ?", (user_id,)
    )
    stored = {r["channel_id"]: r["last_read_message_id"] for r in rows}
    out: dict[str, dict[str, int]] = {}
    for channel in hub.channels.values():
        if channel["kind"] != "text":
            continue
        channel_id = channel["id"]
        last_read = stored.get(channel_id, 0)
        latest = await latest_message_id(db, channel_id)
        unread = 0
        if latest > last_read:
            unread = await unread_count(db, user_id, channel_id, last_read)
        out[str(channel_id)] = {"last_read": last_read, "latest": latest, "unread": unread}
    return out


async def advance(
    db: Database, user_id: int, channel_id: int, message_id: int
) -> tuple[int, int] | None:
    """Move the user's mark forward to ``message_id`` (lowered to the channel's
    newest message). ``(new mark, unread after it)``, or None when the mark was
    already there or further (read state only ever moves forward). The caller
    holds ``db.write_lock``."""
    latest = await latest_message_id(db, channel_id)
    target = min(message_id, latest)
    current = await _scalar(
        db,
        "SELECT coalesce(max(last_read_message_id), 0) FROM read_state "
        "WHERE user_id = ? AND channel_id = ?",
        (user_id, channel_id),
    )
    if target <= current:
        return None
    await db.conn.execute(
        "INSERT INTO read_state (user_id, channel_id, last_read_message_id, updated_at) "
        "VALUES (?, ?, ?, ?) ON CONFLICT (user_id, channel_id) DO UPDATE SET "
        "last_read_message_id = excluded.last_read_message_id, updated_at = excluded.updated_at",
        (user_id, channel_id, target, utc_now()),
    )
    await db.conn.commit()
    return target, await unread_count(db, user_id, channel_id, target)


async def seed_new_user(db: Database, user_id: int) -> None:
    """A new account starts with every text channel read: what was said before
    they arrived is history, not "unread". The caller holds ``db.write_lock``."""
    await db.conn.execute(
        "INSERT OR IGNORE INTO read_state (user_id, channel_id, last_read_message_id, updated_at) "
        "SELECT ?, c.id, m.latest, ? FROM channels c "
        "JOIN (SELECT channel_id, max(id) AS latest FROM messages GROUP BY channel_id) m "
        "ON m.channel_id = c.id WHERE c.kind = 'text'",
        (user_id, utc_now()),
    )
    await db.conn.commit()


# -- channel management ----------------------------------------------------------

ChannelId = Annotated[int, PathParam(ge=1, le=SQL_INT_MAX)]


async def delete_channel_rows(db: Database, channel_id: int) -> list[str]:
    """Delete the channel and everything that hangs off it in ONE transaction;
    the ids of the attachment files to unlink afterwards (never before the
    commit: a crash leaves files without rows, swept at the next start)."""
    files = [
        r["id"]
        for r in await db._all(
            "SELECT a.id FROM attachments a JOIN messages m ON m.id = a.message_id "
            "WHERE m.channel_id = ?",
            (channel_id,),
        )
    ]
    in_channel = "SELECT id FROM messages WHERE channel_id = ?"
    await db._write(
        [
            (f"DELETE FROM reactions WHERE message_id IN ({in_channel})", (channel_id,)),  # noqa: S608
            ("DELETE FROM pins WHERE channel_id = ?", (channel_id,)),
            ("DELETE FROM links WHERE channel_id = ?", (channel_id,)),
            (f"DELETE FROM attachments WHERE message_id IN ({in_channel})", (channel_id,)),  # noqa: S608
            ("DELETE FROM messages WHERE channel_id = ?", (channel_id,)),
            ("DELETE FROM read_state WHERE channel_id = ?", (channel_id,)),
            ("DELETE FROM channels WHERE id = ?", (channel_id,)),
        ]
    )
    return files


def register_channel_routes(
    app: FastAPI,
    *,
    db: Database,
    hub: Hub,
    now: Callable[[], float],
    upload_dir: Path,
    current_user: Callable[..., Awaitable[dict[str, Any]]],
    read_json: Callable[..., Awaitable[dict[str, Any]]],
    resolve_owner: Callable[[], Awaitable[int | None]],
    forget_channel_prefs: Callable[[int], Awaitable[None]],
) -> None:
    User = Annotated[dict[str, Any], Depends(current_user)]
    edits = SlidingWindow(CHANNEL_EDIT_LIMIT, CHANNEL_EDIT_WINDOW_SECONDS, now)

    def spend(user: dict[str, Any]) -> None:
        if not edits.allow(str(user["id"])):
            raise ApiError(429, "RATE_LIMITED", "too many channel changes, try again in a minute")

    def channel_or_404(channel_id: int) -> dict[str, Any]:
        channel = hub.channels.get(channel_id)
        if channel is None:
            raise ApiError(404, "NOT_FOUND", "no such channel")
        return channel

    @app.patch("/api/channels/{channel_id}")
    async def rename_channel(channel_id: ChannelId, request: Request, user: User) -> Any:
        spend(user)
        body = await read_json(request)
        name = clean_name(body.get("name"))
        if name is None:
            raise ApiError(422, "INVALID_CHANNEL", "name must be 1-32 characters")
        async with db.write_lock:
            channel = channel_or_404(channel_id)
            if channel["name"] == name:
                return {"channel": channel}
            try:
                await db._write([("UPDATE channels SET name = ? WHERE id = ?", (name, channel_id))])
            except StorageFullError:
                raise storage_full() from None
            updated = {**channel, "name": name}
            hub.channels[channel_id] = updated
            hub.broadcast({"type": "channel.updated", "channel": updated})
        logger.info("channel.renamed id=%s user=%s", channel_id, user["id"])
        return {"channel": updated}

    @app.delete("/api/channels/{channel_id}", status_code=204)
    async def delete_channel(channel_id: ChannelId, request: Request, user: User) -> Response:
        spend(user)
        body = await read_json(request)
        if await resolve_owner() != user["id"]:
            raise ApiError(403, "FORBIDDEN", "only the server's owner may delete a channel")
        async with db.write_lock:
            channel = channel_or_404(channel_id)
            if body.get("confirm_name") != channel["name"]:
                raise ApiError(422, "CONFIRM_MISMATCH", "'confirm_name' must be the channel's name")
            if channel["kind"] == "voice" and hub.voice.get(channel_id):
                raise ApiError(409, "CHANNEL_IN_USE", "somebody is in this voice channel")
            if channel["kind"] == "text" and not any(
                c["kind"] == "text" and c["id"] != channel_id for c in hub.channels.values()
            ):
                raise ApiError(409, "LAST_TEXT_CHANNEL", "the last text channel cannot be deleted")
            try:
                files = await delete_channel_rows(db, channel_id)
            except StorageFullError:
                raise storage_full() from None
            del hub.channels[channel_id]
            notify = getattr(hub, "notify", None)
            if notify is not None:
                notify.voice_announced.pop(channel_id, None)
            hub.broadcast({"type": "channel.deleted", "channel_id": channel_id})
            await forget_channel_prefs(channel_id)
        for attachment_id in files:
            with contextlib.suppress(FileNotFoundError):
                (upload_dir / attachment_id).unlink()
        remove_previews(upload_dir, files)
        logger.info(
            "channel.deleted id=%s kind=%s user=%s files=%s",
            channel_id,
            channel["kind"],
            user["id"],
            len(files),
        )
        return Response(status_code=204)
