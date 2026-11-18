"""The /ws endpoint: frame parsing and the client -> server half of the protocol."""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Callable
from typing import Any

from starlette.websockets import WebSocket, WebSocketDisconnect

from trio_server.db import Database, InvalidAttachmentError
from trio_server.hub import Connection, Hub
from trio_server.uploads import ATTACHMENT_ID, MAX_ATTACHMENTS, ORPHAN_SECONDS
from trio_server.validation import CONTENT_MAX, is_int

logger = logging.getLogger("trio.ws")

CLOSE_UNAUTHORIZED = 4401
SIGNAL_DATA_MAX_BYTES = 64 * 1024
# A whole frame: the largest signal payload plus its small envelope.
FRAME_MAX_BYTES = SIGNAL_DATA_MAX_BYTES + 1024
NONCE_MAX = 128


class FrameError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _bool(frame: dict[str, Any], key: str, *, default: bool | None = None) -> bool:
    value = frame.get(key, default)
    if not isinstance(value, bool):
        raise FrameError("BAD_REQUEST", f"'{key}' must be a boolean")
    return value


class Session:
    """One websocket connection of one user."""

    def __init__(
        self,
        conn: Connection,
        user: dict[str, Any],
        hub: Hub,
        db: Database,
        now: Callable[[], float] = time.time,
    ) -> None:
        self.conn = conn
        self.user = user
        self.hub = hub
        self.db = db
        self.now = now
        self.handlers = {
            "ping": self.on_ping,
            "message.send": self.on_message_send,
            "typing": self.on_typing,
            "voice.join": self.on_voice_join,
            "voice.leave": self.on_voice_leave,
            "voice.state": self.on_voice_state,
            "signal": self.on_signal,
        }

    async def handle_text(self, text: str) -> None:
        try:
            if len(text) > FRAME_MAX_BYTES or len(text.encode("utf-8")) > FRAME_MAX_BYTES:
                raise FrameError("TOO_LARGE", "frame is too large")
            try:
                frame = json.loads(text)
            except (ValueError, RecursionError):
                raise FrameError("BAD_REQUEST", "frame is not valid JSON") from None
            if not isinstance(frame, dict) or not isinstance(frame.get("type"), str):
                raise FrameError("BAD_REQUEST", "frame must be an object with a string 'type'")
            handler = self.handlers.get(frame["type"])
            if handler is None:
                raise FrameError("UNKNOWN_TYPE", "unknown frame type")
            await handler(frame)
        except FrameError as exc:
            self.error(exc.code, exc.message)

    def error(self, code: str, message: str) -> None:
        self.conn.send({"type": "error", "code": code, "message": message})

    def _text_channel(self, frame: dict[str, Any]) -> int:
        channel_id = frame.get("channel_id")
        channel = self.hub.channels.get(channel_id) if is_int(channel_id) else None
        if channel is None or channel["kind"] != "text":
            raise FrameError("INVALID_CHANNEL", "no such text channel")
        return channel_id

    async def on_ping(self, frame: dict[str, Any]) -> None:
        self.conn.send({"type": "pong"})

    async def on_message_send(self, frame: dict[str, Any]) -> None:
        channel_id = self._text_channel(frame)
        ids = frame.get("attachment_ids", [])
        if ids is None:
            ids = []
        if not isinstance(ids, list) or not all(isinstance(i, str) for i in ids):
            raise FrameError("BAD_REQUEST", "'attachment_ids' must be a list of strings")
        if len(ids) > MAX_ATTACHMENTS:
            raise FrameError("INVALID_ATTACHMENT", f"at most {MAX_ATTACHMENTS} attachments")
        if not all(ATTACHMENT_ID.match(i) for i in ids) or len(set(ids)) != len(ids):
            raise FrameError("INVALID_ATTACHMENT", "unknown or repeated attachment")
        raw = frame.get("content", "" if ids else None)
        if not isinstance(raw, str) or "\x00" in raw:
            raise FrameError("INVALID_MESSAGE", "content must be 1-4000 characters")
        content = raw.strip()
        if len(content) > CONTENT_MAX or (not content and not ids):
            raise FrameError(
                "INVALID_MESSAGE",
                "content must be 1-4000 characters (or empty with an attachment)",
            )
        nonce = frame.get("nonce")
        if nonce is not None and not (isinstance(nonce, str) and len(nonce) <= NONCE_MAX):
            raise FrameError("BAD_REQUEST", "'nonce' must be a short string")
        async with self.db.write_lock:
            try:
                message = await self.db.create_message(
                    channel_id,
                    self.user,
                    content,
                    ids,
                    not_before_ts=self.now() - ORPHAN_SECONDS,
                )
            except InvalidAttachmentError:
                raise FrameError(
                    "INVALID_ATTACHMENT",
                    "each attachment must be your own upload and not on a message yet",
                ) from None
            # Still under the lock, and no await below: events leave in id order.
            event = {"type": "message.new", "message": message}
            self.hub.broadcast(event, exclude_user=self.user["id"])
            if nonce is not None:
                event = {**event, "nonce": nonce}
            self.hub.send_to_user(self.user["id"], event)

    async def on_typing(self, frame: dict[str, Any]) -> None:
        channel_id = self._text_channel(frame)
        self.hub.broadcast(
            {"type": "typing", "channel_id": channel_id, "user_id": self.user["id"]},
            exclude_user=self.user["id"],
        )

    async def on_voice_join(self, frame: dict[str, Any]) -> None:
        channel_id = frame.get("channel_id")
        channel = self.hub.channels.get(channel_id) if is_int(channel_id) else None
        if channel is None or channel["kind"] != "voice":
            raise FrameError("INVALID_CHANNEL", "no such voice channel")
        muted = _bool(frame, "muted", default=False)
        deafened = _bool(frame, "deafened", default=False)
        camera = _bool(frame, "camera", default=False)
        self.hub.voice_join(self.conn, channel_id, muted, deafened, camera)

    async def on_voice_leave(self, frame: dict[str, Any]) -> None:
        self.hub.voice_leave(self.user["id"])

    def _own_voice_channel(self) -> int:
        """The channel this CONNECTION is in voice in (the media lives in this tab)."""
        found = self.hub.voice_member(self.user["id"])
        if found is None or found[1].conn is not self.conn:
            raise FrameError("NOT_IN_VOICE", "this connection is not in a voice channel")
        return found[0]

    async def on_voice_state(self, frame: dict[str, Any]) -> None:
        muted = _bool(frame, "muted")
        deafened = _bool(frame, "deafened")
        screensharing = _bool(frame, "screensharing")
        camera = _bool(frame, "camera", default=False)
        self._own_voice_channel()
        self.hub.voice_state(self.user["id"], muted, deafened, screensharing, camera)

    async def on_signal(self, frame: dict[str, Any]) -> None:
        to = frame.get("to")
        if not is_int(to) or "data" not in frame:
            raise FrameError("BAD_REQUEST", "'to' must be a user id and 'data' is required")
        data = frame["data"]
        encoded = json.dumps(data, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        if len(encoded) > SIGNAL_DATA_MAX_BYTES:
            raise FrameError("TOO_LARGE", "signal data is too large")
        channel_id = self._own_voice_channel()
        target = self.hub.voice_member(to)
        if to == self.user["id"] or target is None or target[0] != channel_id:
            raise FrameError("NOT_IN_VOICE", "that user is not in your voice channel")
        target[1].conn.send({"type": "signal", "from": self.user["id"], "data": data})


async def websocket_endpoint(ws: WebSocket) -> None:
    db: Database = ws.app.state.db
    hub: Hub = ws.app.state.hub
    # Accept first: a close before the handshake completes reaches a browser
    # as 1006, and the client needs to see 4401.
    await ws.accept()
    token = ws.query_params.get("token") or ""
    user = await db.user_for_token(token) if token else None
    if user is None:
        await ws.close(code=CLOSE_UNAUTHORIZED, reason="unauthorized")
        return

    conn = Connection(user_id=user["id"], ws=ws)
    conn.start()
    hub.connect(conn)
    session = Session(conn, user, hub, db, ws.app.state.now)
    try:
        while not conn.closed:
            event = await ws.receive()
            if event["type"] == "websocket.disconnect":
                break
            text = event.get("text")
            if text is None:
                session.error("BAD_REQUEST", "binary frames are not supported")
                continue
            try:
                await session.handle_text(text)
            except Exception:  # noqa: BLE001 - one bad frame must not end the connection
                logger.exception("ws.frame.failed user=%s", user["id"])
                session.error("INTERNAL", "internal error")
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        hub.disconnect(conn)
        conn.stop()
