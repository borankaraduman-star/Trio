"""The /ws endpoint: frame parsing and the client -> server half of the protocol."""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Callable
from typing import Any

from starlette.websockets import WebSocket, WebSocketDisconnect

from trio_server.activity import ActivityError, parse_activity
from trio_server.db import (
    Database,
    InvalidAttachmentError,
    InvalidReplyError,
    StorageFullError,
    hash_token,
)
from trio_server.hub import (
    CLOSE_TOO_MANY,
    CLOSE_UNAUTHORIZED,
    MAX_CONNECTIONS_PER_USER,
    Connection,
    Hub,
)
from trio_server.uploads import ATTACHMENT_ID, MAX_ATTACHMENTS, ORPHAN_SECONDS
from trio_server.validation import CONTENT_MAX, is_int

logger = logging.getLogger("trio.ws")

SIGNAL_DATA_MAX_BYTES = 64 * 1024
# A whole frame: the largest signal payload plus its small envelope.
FRAME_MAX_BYTES = SIGNAL_DATA_MAX_BYTES + 1024
NONCE_MAX = 128
# What uvicorn may buffer for ONE incoming message before the app sees it
# (its default is 16 MiB). Twice the app's own cap: a frame a little too big
# still gets the friendly TOO_LARGE error frame; anything larger closes the
# socket with 1009 before it is held in memory. See trio_server.__main__.
WS_MAX_SIZE = 2 * FRAME_MAX_BYTES


def encodable(value: Any) -> bool:
    """True when every string in a parsed JSON value is valid Unicode text."""
    try:
        json.dumps(value, ensure_ascii=False).encode("utf-8")
    except (UnicodeEncodeError, RecursionError, ValueError):
        return False
    return True


class FrameError(Exception):
    def __init__(self, code: str, message: str, **extra: Any) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        # Additive fields of the error frame (e.g. ``to`` of a refused signal).
        self.extra = extra


# ``voice.join {session}``: the client's random id for one call (CONTRACT-V4 A1).
VOICE_SESSION_MAX = 64


def _signal_target(text: str) -> int | None:
    """The ``to`` of an over-sized ``signal`` frame, so the sender knows which
    negotiation was lost (CONTRACT-V3 §6). The text is at most ``WS_MAX_SIZE``
    (uvicorn closes anything larger), so parsing it is bounded."""
    try:
        frame = json.loads(text)
    except (ValueError, RecursionError):
        return None
    if not isinstance(frame, dict) or frame.get("type") != "signal":
        return None
    to = frame.get("to")
    return to if is_int(to) else None


def _reply_to(frame: dict[str, Any]) -> int | None:
    """``message.send``'s ``reply_to`` (CONTRACT-V4 B): a message id or null."""
    value = frame.get("reply_to")
    if value is None:
        return None
    if not is_int(value):
        raise FrameError("BAD_REQUEST", "'reply_to' must be a message id")
    return value


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
            "voice.ring": self.on_voice_ring,
            "activity.set": self.on_activity_set,
            "activity.clear": self.on_activity_clear,
            "client.viewing": self.on_client_viewing,
        }

    async def handle_text(self, text: str) -> None:
        try:
            if len(text) > FRAME_MAX_BYTES or len(text.encode("utf-8")) > FRAME_MAX_BYTES:
                to = _signal_target(text)
                if to is not None:
                    raise FrameError("TOO_LARGE", "frame is too large", to=to)
                raise FrameError("TOO_LARGE", "frame is too large")
            try:
                frame = json.loads(text)
            except (ValueError, RecursionError):
                raise FrameError("BAD_REQUEST", "frame is not valid JSON") from None
            if not isinstance(frame, dict) or not isinstance(frame.get("type"), str):
                raise FrameError("BAD_REQUEST", "frame must be an object with a string 'type'")
            if not encodable(frame):
                # JSON may spell a lone surrogate ("\ud800"); it is not text and
                # can be neither stored nor relayed as UTF-8.
                raise FrameError("BAD_REQUEST", "frame contains invalid text")
            handler = self.handlers.get(frame["type"])
            if handler is None:
                raise FrameError("UNKNOWN_TYPE", "unknown frame type")
            await handler(frame)
        except FrameError as exc:
            self.error(exc.code, exc.message, **exc.extra)

    def error(self, code: str, message: str, **extra: Any) -> None:
        self.conn.send({"type": "error", "code": code, "message": message, **extra})

    def _text_channel(self, frame: dict[str, Any]) -> int:
        channel_id = frame.get("channel_id")
        channel = self.hub.channels.get(channel_id) if is_int(channel_id) else None
        if channel is None or channel["kind"] != "text":
            raise FrameError("INVALID_CHANNEL", "no such text channel")
        return channel_id

    async def on_ping(self, frame: dict[str, Any]) -> None:
        self.conn.send({"type": "pong"})

    async def on_message_send(self, frame: dict[str, Any]) -> None:
        """V6: every error answering a ``message.send`` names the send's
        ``nonce`` (when it is a usable one), so a client with two sends in
        flight fails the right row. A frame without a nonce gets the bare
        error, as before."""
        nonce = frame.get("nonce")
        named = nonce if isinstance(nonce, str) and len(nonce) <= NONCE_MAX else None
        try:
            await self._message_send(frame)
        except FrameError as exc:
            if named is not None:
                exc.extra = {**exc.extra, "nonce": named}
            raise
        except Exception:
            if named is None:
                raise
            logger.exception("ws.frame.failed user=%s", self.user["id"])
            raise FrameError("INTERNAL", "internal error", nonce=named) from None

    async def _message_send(self, frame: dict[str, Any]) -> None:
        channel_id = self._text_channel(frame)
        nonce = frame.get("nonce")
        if nonce is not None and not (isinstance(nonce, str) and len(nonce) <= NONCE_MAX):
            raise FrameError("BAD_REQUEST", "'nonce' must be a short string")
        async with self.db.write_lock:
            if nonce is not None and await self._replay(nonce):
                return
            # Validation does not await: nothing can store this nonce between
            # the check above and the insert below.
            reply_to = _reply_to(frame)
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
            try:
                message = await self.db.create_message(
                    channel_id,
                    self.user,
                    content,
                    ids,
                    not_before_ts=self.now() - ORPHAN_SECONDS,
                    reply_to=reply_to,
                )
            except StorageFullError:
                raise FrameError("STORAGE_FULL", "the server's disk is full") from None
            except InvalidAttachmentError:
                raise FrameError(
                    "INVALID_ATTACHMENT",
                    "each attachment must be your own upload and not on a message yet",
                ) from None
            except InvalidReplyError:
                raise FrameError(
                    "INVALID_REPLY", "'reply_to' must be a message in the same channel"
                ) from None
            # Still under the lock, and no await below: events leave in id order.
            event = {"type": "message.new", "message": message}
            self.hub.broadcast(event, exclude_user=self.user["id"])
            if nonce is not None:
                self.hub.nonces.put(
                    self.user["id"], nonce, (message["channel_id"], message["id"]), self.now()
                )
                event = {**event, "nonce": nonce}
            self.hub.send_to_user(self.user["id"], event)
            if self.hub.notify is not None:
                self.hub.notify.message_new(message)

    async def _replay(self, nonce: str) -> bool:
        """Answer a retry of a send that was stored (its acknowledgement was
        lost): store nothing, and tell the sender's connections what became of
        it. The message is re-read, so the answer carries its edits, reactions
        and pin (CONTRACT-V4 B); a message deleted meanwhile is answered with
        `message.deleted`. The rest of the retried frame is not read. The
        caller holds ``write_lock``, so no change can slip between the read and
        the send."""
        ref = self.hub.nonces.get(self.user["id"], nonce, self.now())
        if ref is None:
            return False
        channel_id, message_id = ref
        current = await self.db.get_message(message_id)
        if current is None:
            event: dict[str, Any] = {
                "type": "message.deleted",
                "channel_id": channel_id,
                "message_id": message_id,
                "nonce": nonce,
            }
        else:
            event = {"type": "message.new", "message": current, "nonce": nonce}
        self.hub.send_to_user(self.user["id"], event)
        return True

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
        screensharing = _bool(frame, "screensharing", default=False)
        resume = _bool(frame, "resume", default=False)
        session = frame.get("session")
        if session is not None and not (
            isinstance(session, str) and 1 <= len(session) <= VOICE_SESSION_MAX
        ):
            raise FrameError("BAD_REQUEST", "'session' must be a short string")
        self.hub.voice_join(
            self.conn,
            channel_id,
            muted,
            deafened,
            camera,
            screensharing=screensharing,
            resume=resume,
            session=session,
        )

    async def on_voice_ring(self, frame: dict[str, Any]) -> None:
        """CONTRACT-V4 A4: call the others into the voice channel I am in."""
        channel_id = frame.get("channel_id")
        channel = self.hub.channels.get(channel_id) if is_int(channel_id) else None
        if channel is None or channel["kind"] != "voice":
            raise FrameError("INVALID_CHANNEL", "no such voice channel", request="voice.ring")
        found = self.hub.voice_member(self.user["id"])
        if found is None or found[0] != channel_id:
            raise FrameError(
                "NOT_IN_VOICE",
                "you can only ring from the voice channel you are in",
                request="voice.ring",
            )
        if not self.hub.rings.allow(str(self.user["id"])):
            raise FrameError(
                "RATE_LIMITED", "you can ring at most once every 30 seconds", request="voice.ring"
            )
        self.hub.voice_ring(self.user["id"], channel_id)

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
            raise FrameError("TOO_LARGE", "signal data is too large", to=to)
        channel_id = self._own_voice_channel()
        target = self.hub.voice_member(to)
        if to == self.user["id"] or target is None or target[0] != channel_id:
            raise FrameError("NOT_IN_VOICE", "that user is not in your voice channel")
        target[1].conn.send({"type": "signal", "from": self.user["id"], "data": data})

    # -- CONTRACT-V6-PUSH: is this connection being looked at -------------------

    async def on_client_viewing(self, frame: dict[str, Any]) -> None:
        viewing = _bool(frame, "viewing")
        channel_id = frame.get("channel_id")
        if channel_id is not None and not is_int(channel_id):
            raise FrameError("BAD_REQUEST", "'channel_id' must be a channel id or null")
        if self.hub.notify is not None:
            self.hub.notify.set_viewing(self.conn, viewing, channel_id)

    # -- CONTRACT-V5: game status ---------------------------------------------

    async def on_activity_set(self, frame: dict[str, Any]) -> None:
        if not self.hub.activity.allow(self.user["id"]):
            raise FrameError("RATE_LIMITED", "at most 30 activity changes per minute")
        try:
            activity = parse_activity(frame, self.now())
        except ActivityError as exc:
            raise FrameError("INVALID_ACTIVITY", str(exc)) from None
        self.hub.activity.set(self.user["id"], activity)

    async def on_activity_clear(self, frame: dict[str, Any]) -> None:
        if not self.hub.activity.allow(self.user["id"]):
            raise FrameError("RATE_LIMITED", "at most 30 activity changes per minute")
        self.hub.activity.clear(self.user["id"])


async def websocket_endpoint(ws: WebSocket) -> None:
    db: Database = ws.app.state.db
    hub: Hub = ws.app.state.hub
    # Accept first: a close before the handshake completes reaches a browser
    # as 1006, and the client needs to see 4401.
    await ws.accept()
    token = ws.query_params.get("token") or ""
    token_hash = hash_token(token)
    user = await db.user_for_token_hash(token_hash) if token else None
    if user is None:
        await ws.close(code=CLOSE_UNAUTHORIZED, reason="unauthorized")
        return
    if hub.connection_count(user["id"]) >= MAX_CONNECTIONS_PER_USER:
        await ws.close(code=CLOSE_TOO_MANY, reason="too many connections")
        return
    if user["id"] not in hub.users:
        # Removed and re-checked while we awaited: not a member any more.
        await ws.close(code=CLOSE_UNAUTHORIZED, reason="unauthorized")
        return

    conn = Connection(user_id=user["id"], ws=ws, token_hash=token_hash)
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
