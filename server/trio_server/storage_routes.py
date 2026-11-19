"""Everybody's own storage: what they have stored, and deleting a file (CONTRACT-V6-OPS §4).

A deleted file leaves disk and quota at once. On a message its row stays as a
tombstone (``attachments.deleted_at``), serialised as ``{id, filename,
deleted: true}``, and the message is broadcast as ``message.updated`` so every
open client shows "dosya silindi". A file not on a message yet goes entirely.
"""

# No ``from __future__ import annotations``: see message_routes.

import contextlib
import logging
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Annotated, Any

from fastapi import Depends, FastAPI, Query

from trio_server.config import Settings
from trio_server.db import Database, attachment_url, is_disk_full, utc_iso
from trio_server.errors import ApiError
from trio_server.hub import Hub
from trio_server.ratelimit import SlidingWindow
from trio_server.uploads import ATTACHMENT_ID, storage_full

logger = logging.getLogger("trio")

EXCERPT_CHARS = 80
DELETE_LIMIT = 30  # file deletions per user per minute
DELETE_WINDOW_SECONDS = 60


def register_storage_routes(
    app: FastAPI,
    *,
    db: Database,
    hub: Hub,
    settings: Settings,
    upload_dir: Path,
    current_user: Callable[..., Awaitable[dict[str, Any]]],
) -> None:
    User = Annotated[dict[str, Any], Depends(current_user)]
    deletes = SlidingWindow(DELETE_LIMIT, DELETE_WINDOW_SECONDS, app.state.now)
    app.state.attachment_deletes = deletes

    async def usage(user_id: int) -> dict[str, int]:
        async with db.conn.execute(
            "SELECT coalesce(sum(size), 0), count(*) FROM attachments "
            "WHERE uploader_id = ? AND deleted_at IS NULL",
            (user_id,),
        ) as cur:
            used, files = await cur.fetchone()
        return {"used_bytes": used, "quota_bytes": settings.user_quota_bytes, "file_count": files}

    @app.get("/api/me/storage")
    async def my_storage(
        user: User,
        limit: Annotated[int, Query(ge=1, le=100)] = 50,
        offset: Annotated[int, Query(ge=0, le=1_000_000)] = 0,
    ) -> Any:
        async with db.conn.execute(
            "SELECT a.id, a.filename, a.content_type, a.size, a.created_at, a.message_id, "
            "m.channel_id, m.content FROM attachments a "
            "LEFT JOIN messages m ON m.id = a.message_id "
            "WHERE a.uploader_id = ? AND a.deleted_at IS NULL "
            "ORDER BY a.size DESC, a.id LIMIT ? OFFSET ?",
            (user["id"], limit + 1, offset),
        ) as cur:
            rows = list(await cur.fetchall())
        items = [
            {
                "id": r["id"],
                "filename": r["filename"],
                "content_type": r["content_type"],
                "size": r["size"],
                "created_at": r["created_at"],
                "url": attachment_url(r["id"], r["filename"]),
                "message": None
                if r["message_id"] is None
                else {
                    "id": r["message_id"],
                    "channel_id": r["channel_id"],
                    "excerpt": r["content"][:EXCERPT_CHARS],
                },
            }
            for r in rows[:limit]
        ]
        return {**await usage(user["id"]), "attachments": items, "has_more": len(rows) > limit}

    @app.delete("/api/attachments/{attachment_id}")
    async def delete_attachment(attachment_id: str, user: User) -> Any:
        if not ATTACHMENT_ID.match(attachment_id):
            raise ApiError(404, "NOT_FOUND", "no such file")
        if not deletes.allow(str(user["id"])):
            raise ApiError(429, "RATE_LIMITED", "too many deletions, try again in a minute")
        message = None
        async with db.write_lock:
            async with db.conn.execute(
                "SELECT uploader_id, message_id FROM attachments "
                "WHERE id = ? AND deleted_at IS NULL",
                (attachment_id,),
            ) as cur:
                row = await cur.fetchone()
            if row is None:
                raise ApiError(404, "NOT_FOUND", "no such file")
            if row["uploader_id"] != user["id"]:
                raise ApiError(403, "FORBIDDEN", "only the uploader may delete a file")
            try:
                if row["message_id"] is None:
                    await db.conn.execute("DELETE FROM attachments WHERE id = ?", (attachment_id,))
                else:
                    await db.conn.execute(
                        "UPDATE attachments SET deleted_at = ? WHERE id = ?",
                        (utc_iso(app.state.now()), attachment_id),
                    )
                    await db.conn.execute(
                        "UPDATE messages SET rev = rev + 1 WHERE id = ?", (row["message_id"],)
                    )
                await db.conn.commit()
            except BaseException as exc:
                await db.conn.rollback()
                if is_disk_full(exc):
                    raise storage_full() from None
                raise
            if row["message_id"] is not None:
                message = await db.get_message(row["message_id"])
                if message is not None:
                    hub.broadcast({"type": "message.updated", "message": message})
        # After the commit, as a message delete does: a crash in between leaves
        # a file no row names, which the next start sweeps.
        with contextlib.suppress(FileNotFoundError):
            (upload_dir / attachment_id).unlink()
        logger.info("attachment.deleted user=%s", user["id"])
        return {"storage": await usage(user["id"]), "message": message}
