"""REST for the message family: edit, delete, reactions, pins (CONTRACT-V4 B).

Every change is written under ``db.write_lock`` and its broadcast is queued on
every socket before the lock is released and before the HTTP response is
sent, so the websocket carries the changes of all messages in the order they
were made. ``rev`` (per message, +1 per change) lets a client drop a REST
answer that arrives after a newer broadcast.
"""

# No ``from __future__ import annotations``: the routes' dependency
# (``User``) is local to register_message_routes and FastAPI must see it as an
# object, not as a string to resolve in this module's globals.
import contextlib
import logging
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Annotated, Any

from fastapi import Depends, FastAPI, Request
from fastapi import Path as PathParam
from fastapi.responses import JSONResponse, Response

from trio_server.db import (
    SQL_INT_MAX,
    Database,
    EmptyMessageError,
    MessageNotFoundError,
    NotAuthorError,
    PinLimitError,
    ReactionLimitError,
    StorageFullError,
    utc_iso,
)
from trio_server.emoji import clean_reaction_key
from trio_server.errors import ApiError, error_response
from trio_server.hub import Hub
from trio_server.ratelimit import SlidingWindow
from trio_server.uploads import storage_full
from trio_server.validation import CONTENT_MAX

logger = logging.getLogger("trio")

MAX_REACTION_KEYS = 20
MAX_PINS = 50
# Per user per RATE_WINDOW_SECONDS.
EDIT_LIMIT = 30  # edits, deletes, pins and unpins together
REACTION_LIMIT = 120  # reaction adds and removes together
RATE_WINDOW_SECONDS = 60
# An edit carries up to 4000 characters; JSON may spell each as a 6-byte escape.
EDIT_BODY_MAX_BYTES = 64 * 1024

MessageId = Annotated[int, PathParam(ge=1, le=SQL_INT_MAX)]


def register_message_routes(
    app: FastAPI,
    *,
    db: Database,
    hub: Hub,
    now: Callable[[], float],
    upload_dir: Path,
    current_user: Callable[..., Awaitable[dict[str, Any]]],
    read_json: Callable[..., Awaitable[dict[str, Any]]],
) -> None:
    User = Annotated[dict[str, Any], Depends(current_user)]
    edits = SlidingWindow(EDIT_LIMIT, RATE_WINDOW_SECONDS, now)
    reactions = SlidingWindow(REACTION_LIMIT, RATE_WINDOW_SECONDS, now)
    app.state.message_limits = {"edits": edits, "reactions": reactions}

    def spend(window: SlidingWindow, user: dict[str, Any]) -> None:
        key = str(user["id"])
        if not window.allow(key):
            raise ApiError(429, "RATE_LIMITED", "too many changes, try again in a minute")

    def updated(message: dict[str, Any], changed: bool) -> dict[str, Any]:
        """Broadcast (only a real change) and answer. Called under the lock."""
        if changed:
            hub.broadcast({"type": "message.updated", "message": message})
        return {"message": message}

    def not_found() -> ApiError:
        return ApiError(404, "NOT_FOUND", "no such message")

    def forbidden() -> ApiError:
        return ApiError(403, "FORBIDDEN", "only the author may do that")

    @app.patch("/api/messages/{message_id}")
    async def edit_message(message_id: MessageId, request: Request, user: User) -> Any:
        spend(edits, user)
        body = await read_json(request, max_bytes=EDIT_BODY_MAX_BYTES)
        raw = body.get("content")
        if not isinstance(raw, str) or "\x00" in raw or len(raw.strip()) > CONTENT_MAX:
            raise ApiError(422, "INVALID_MESSAGE", "content must be 0-4000 characters")
        async with db.write_lock:
            try:
                message, changed = await db.edit_message(
                    message_id, user["id"], raw.strip(), utc_iso(now())
                )
            except MessageNotFoundError:
                raise not_found() from None
            except NotAuthorError:
                raise forbidden() from None
            except EmptyMessageError:
                raise ApiError(
                    422, "INVALID_MESSAGE", "content may only be empty while attachments remain"
                ) from None
            except StorageFullError:
                raise storage_full() from None
            return updated(message, changed)

    @app.delete("/api/messages/{message_id}", status_code=204)
    async def delete_message(message_id: MessageId, user: User) -> Response:
        spend(edits, user)
        async with db.write_lock:
            try:
                channel_id, files = await db.delete_message(message_id, user["id"])
            except MessageNotFoundError:
                raise not_found() from None
            except NotAuthorError:
                raise forbidden() from None
            except StorageFullError:
                raise storage_full() from None
            hub.broadcast(
                {"type": "message.deleted", "channel_id": channel_id, "message_id": message_id}
            )
        # After the commit: a crash here leaves files with no row, which the
        # sweep at the next start removes (app.sweep_unreferenced_files).
        for attachment_id in files:
            with contextlib.suppress(FileNotFoundError):
                (upload_dir / attachment_id).unlink()
        logger.info("message.deleted user=%s files=%s", user["id"], len(files))
        return Response(status_code=204)

    async def react(message_id: int, raw_key: str, user: dict[str, Any], on: bool) -> Any:
        spend(reactions, user)
        key = clean_reaction_key(raw_key)
        if key is None:
            raise ApiError(
                422, "INVALID_REACTION", "a reaction is one emoji or :name: (1-64 bytes)"
            )
        async with db.write_lock:
            try:
                message, changed = await db.set_reaction(
                    message_id, user["id"], key, on, MAX_REACTION_KEYS
                )
            except MessageNotFoundError:
                raise not_found() from None
            except ReactionLimitError:
                raise ApiError(
                    409, "REACTION_LIMIT", f"at most {MAX_REACTION_KEYS} different reactions"
                ) from None
            except StorageFullError:
                raise storage_full() from None
            return updated(message, changed)

    @app.put("/api/messages/{message_id}/reactions/{key}")
    async def add_reaction(message_id: MessageId, key: str, user: User) -> Any:
        return await react(message_id, key, user, True)

    @app.delete("/api/messages/{message_id}/reactions/{key}")
    async def remove_reaction(message_id: MessageId, key: str, user: User) -> Any:
        return await react(message_id, key, user, False)

    async def pin(message_id: int, user: dict[str, Any], on: bool) -> Any:
        spend(edits, user)
        async with db.write_lock:
            try:
                message, changed = await db.set_pin(
                    message_id, user["id"], on, utc_iso(now()), MAX_PINS
                )
            except MessageNotFoundError:
                raise not_found() from None
            except PinLimitError:
                raise ApiError(409, "PIN_LIMIT", f"at most {MAX_PINS} pins per channel") from None
            except StorageFullError:
                raise storage_full() from None
            return updated(message, changed)

    @app.put("/api/messages/{message_id}/pin")
    async def pin_message(message_id: MessageId, user: User) -> Any:
        return await pin(message_id, user, True)

    @app.delete("/api/messages/{message_id}/pin")
    async def unpin_message(message_id: MessageId, user: User) -> Any:
        return await pin(message_id, user, False)

    @app.get("/api/channels/{channel_id}/pins")
    async def list_pins(channel_id: int, user: User) -> Any:
        channel = hub.channels.get(channel_id)
        if channel is None or channel["kind"] != "text":
            return error_response(404, "NOT_FOUND", "no such text channel")
        return JSONResponse({"messages": await db.list_pins(channel_id)})
