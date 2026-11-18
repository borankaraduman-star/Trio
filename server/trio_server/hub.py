"""Connections, presence and voice state, all in this process's memory.

The deployment model is ONE process (one uvicorn worker, one container): a
second worker would have its own Hub and the two halves could neither see
each other's presence nor relay each other's signalling. Run with
``--workers 1`` (uvicorn's default).

Every method that changes state and broadcasts is synchronous (no ``await``),
so on the single event loop each one is atomic: a ``ready`` snapshot can
never interleave with the change it would otherwise miss.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from dataclasses import dataclass, field
from typing import Any

from starlette.websockets import WebSocket

# Frames waiting for one slow client. Past it the connection is dropped rather
# than letting one stalled tab hold memory or delay everybody else.
SEND_QUEUE_SIZE = 512


@dataclass(eq=False)
class Connection:
    user_id: int
    ws: WebSocket
    queue: asyncio.Queue[str] = field(default_factory=lambda: asyncio.Queue(SEND_QUEUE_SIZE))
    closed: bool = False
    _tasks: list[asyncio.Task[None]] = field(default_factory=list)

    def start(self) -> None:
        self._tasks.append(asyncio.create_task(self._writer()))

    async def _writer(self) -> None:
        try:
            while True:
                await self.ws.send_text(await self.queue.get())
        except Exception:  # noqa: BLE001 - the peer went away; the reader notices too
            self.closed = True

    def send(self, frame: dict[str, Any] | str) -> None:
        if self.closed:
            return
        text = frame if isinstance(frame, str) else json.dumps(frame, separators=(",", ":"))
        try:
            self.queue.put_nowait(text)
        except asyncio.QueueFull:
            self.closed = True
            self._tasks.append(asyncio.create_task(self._drop()))

    async def _drop(self) -> None:
        with contextlib.suppress(Exception):
            await self.ws.close(code=1013)

    def stop(self) -> None:
        self.closed = True
        current = asyncio.current_task()
        for task in self._tasks:
            if task is not current:
                task.cancel()


@dataclass
class VoiceMember:
    conn: Connection
    muted: bool = False
    deafened: bool = False
    screensharing: bool = False
    camera: bool = False

    def flags(self) -> dict[str, bool]:
        return {
            "muted": self.muted,
            "deafened": self.deafened,
            "screensharing": self.screensharing,
            "camera": self.camera,
        }


class Hub:
    def __init__(self) -> None:
        # Users and channels are mirrored from the database (both are tiny) so
        # that ``ready`` is built without awaiting anything.
        self.users: dict[int, dict[str, Any]] = {}
        self.channels: dict[int, dict[str, Any]] = {}
        self.conns: dict[int, set[Connection]] = {}
        self.voice: dict[int, dict[int, VoiceMember]] = {}  # channel id -> user id -> member
        self.voice_of: dict[int, int] = {}  # user id -> channel id

    def load(self, users: list[dict[str, Any]], channels: list[dict[str, Any]]) -> None:
        self.users = {u["id"]: u for u in users}
        self.channels = {c["id"]: c for c in channels}

    # -- fan-out ------------------------------------------------------------

    def broadcast(self, frame: dict[str, Any], *, exclude_user: int | None = None) -> None:
        text = json.dumps(frame, separators=(",", ":"))
        for user_id, conns in self.conns.items():
            if user_id == exclude_user:
                continue
            for conn in conns:
                conn.send(text)

    def send_to_user(self, user_id: int, frame: dict[str, Any]) -> None:
        text = json.dumps(frame, separators=(",", ":"))
        for conn in self.conns.get(user_id, ()):
            conn.send(text)

    # -- connections and presence -------------------------------------------

    def ready_frame(self, user_id: int) -> dict[str, Any]:
        return {
            "type": "ready",
            "user": self.users[user_id],
            "users": [
                {"id": u["id"], "name": u["name"], "online": bool(self.conns.get(u["id"]))}
                for u in self.users.values()
            ],
            "channels": list(self.channels.values()),
            "voice": {
                str(channel["id"]): [
                    {"user_id": uid, **member.flags()}
                    for uid, member in self.voice.get(channel["id"], {}).items()
                ]
                for channel in self.channels.values()
                if channel["kind"] == "voice"
            },
        }

    def connect(self, conn: Connection) -> None:
        """Register a connection: ``ready`` to it, ``presence`` to the others."""
        first = not self.conns.get(conn.user_id)
        self.conns.setdefault(conn.user_id, set()).add(conn)
        conn.send(self.ready_frame(conn.user_id))
        if first:
            frame = {"type": "presence", "user_id": conn.user_id, "online": True}
            self.broadcast(frame, exclude_user=conn.user_id)

    def disconnect(self, conn: Connection) -> None:
        conns = self.conns.get(conn.user_id)
        if conns is None or conn not in conns:
            return
        conns.discard(conn)
        if not conns:
            del self.conns[conn.user_id]
        channel_id = self.voice_of.get(conn.user_id)
        if channel_id is not None and self.voice[channel_id][conn.user_id].conn is conn:
            self.voice_leave(conn.user_id)
        if conn.user_id not in self.conns:
            self.broadcast({"type": "presence", "user_id": conn.user_id, "online": False})

    def add_user(self, user: dict[str, Any]) -> None:
        self.users[user["id"]] = user
        self.broadcast({"type": "user.joined", "user": user})

    def add_channel(self, channel: dict[str, Any]) -> None:
        self.channels[channel["id"]] = channel
        self.broadcast({"type": "channel.new", "channel": channel})

    # -- voice --------------------------------------------------------------

    def voice_member(self, user_id: int) -> tuple[int, VoiceMember] | None:
        channel_id = self.voice_of.get(user_id)
        if channel_id is None:
            return None
        return channel_id, self.voice[channel_id][user_id]

    def voice_leave(self, user_id: int) -> None:
        channel_id = self.voice_of.pop(user_id, None)
        if channel_id is None:
            return
        members = self.voice[channel_id]
        del members[user_id]
        if not members:
            del self.voice[channel_id]
        self.broadcast({"type": "voice.left", "channel_id": channel_id, "user_id": user_id})

    def voice_join(
        self, conn: Connection, channel_id: int, muted: bool, deafened: bool, camera: bool = False
    ) -> None:
        """Leave wherever the user was, then join, bound to ``conn``."""
        self.voice_leave(conn.user_id)
        members = self.voice.setdefault(channel_id, {})
        conn.send({"type": "voice.peers", "channel_id": channel_id, "peers": list(members)})
        member = VoiceMember(conn=conn, muted=muted, deafened=deafened, camera=camera)
        members[conn.user_id] = member
        self.voice_of[conn.user_id] = channel_id
        self.broadcast(
            {
                "type": "voice.joined",
                "channel_id": channel_id,
                "user_id": conn.user_id,
                **member.flags(),
            }
        )

    def voice_state(
        self,
        user_id: int,
        muted: bool,
        deafened: bool,
        screensharing: bool,
        camera: bool = False,
    ) -> None:
        channel_id = self.voice_of[user_id]
        member = self.voice[channel_id][user_id]
        member.muted, member.deafened = muted, deafened
        member.screensharing, member.camera = screensharing, camera
        self.broadcast(
            {"type": "voice.state", "channel_id": channel_id, "user_id": user_id, **member.flags()}
        )
