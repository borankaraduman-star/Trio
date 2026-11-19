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
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from starlette.websockets import WebSocket

from trio_server.activity import ActivityBoard
from trio_server.nonces import NonceCache
from trio_server.ratelimit import SlidingWindow
from trio_server.version import VERSION

# Frames waiting for one slow client. Past it the connection is dropped rather
# than letting one stalled tab hold memory or delay everybody else.
SEND_QUEUE_SIZE = 512
# Open sockets per user (tabs, devices). A new one past this is refused with
# CLOSE_TOO_MANY rather than closing an old one: kicking the oldest would make
# two tabs past the cap evict each other forever as each one reconnects, and
# could cut the tab that is in voice.
MAX_CONNECTIONS_PER_USER = 10
CLOSE_UNAUTHORIZED = 4401
CLOSE_TOO_MANY = 4429
# CONTRACT-V4 A1: how long a voice member whose voice-bound socket closed is
# kept ("reconnecting") before ``voice.left``, waiting for a resume.
VOICE_GRACE_SECONDS = 10.0
# CONTRACT-V4 A4: rings per user per window.
RING_LIMIT = 1
RING_WINDOW_SECONDS = 30.0


@dataclass(eq=False)
class Connection:
    user_id: int
    ws: WebSocket
    # SHA-256 of the token this socket signed in with: what logout and the
    # periodic token re-check close it by.
    token_hash: str = ""
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

    async def _drop(self, code: int = 1013, reason: str = "") -> None:
        with contextlib.suppress(Exception):
            await self.ws.close(code=code, reason=reason)

    def kick(self, code: int, reason: str = "") -> None:
        """Close from the server side; nothing more is sent to it."""
        if self.closed:
            return
        self.closed = True
        self._tasks.append(asyncio.create_task(self._drop(code, reason)))

    def stop(self) -> None:
        self.closed = True
        current = asyncio.current_task()
        for task in self._tasks:
            if task is not current:
                task.cancel()


@dataclass
class VoiceMember:
    # None while reconnecting: the voice-bound socket closed and the grace
    # (VOICE_GRACE_SECONDS) runs; nothing can be signalled to the member then.
    conn: Connection | None
    muted: bool = False
    deafened: bool = False
    screensharing: bool = False
    camera: bool = False
    # App-clock time the grace ends; None when not reconnecting.
    grace_until: float | None = None
    # The client's random id for this call (``voice.join {session}``), or None.
    session: str | None = None

    @property
    def reconnecting(self) -> bool:
        return self.conn is None

    def flags(self) -> dict[str, bool]:
        return {
            "muted": self.muted,
            "deafened": self.deafened,
            "screensharing": self.screensharing,
            "camera": self.camera,
            "reconnecting": self.reconnecting,
        }


class Hub:
    def __init__(self, now: Callable[[], float] = time.time) -> None:
        self.now = now
        self.grace_seconds = VOICE_GRACE_SECONDS
        # user id -> the task that ends their grace (see voice_disconnected).
        self._grace_tasks: dict[int, asyncio.Task[None]] = {}
        self.rings = SlidingWindow(RING_LIMIT, RING_WINDOW_SECONDS, now)
        # Users and channels are mirrored from the database (both are tiny) so
        # that ``ready`` is built without awaiting anything.
        self.users: dict[int, dict[str, Any]] = {}
        self.channels: dict[int, dict[str, Any]] = {}
        # CONTRACT-V4 C: {name, icon_url}, mirrored like users and channels.
        self.server: dict[str, Any] = {"name": "Trio", "icon_url": None}
        self.conns: dict[int, set[Connection]] = {}
        self.voice: dict[int, dict[int, VoiceMember]] = {}  # channel id -> user id -> member
        self.voice_of: dict[int, int] = {}  # user id -> channel id
        # (user id, nonce) -> the message a send stored (CONTRACT-V3 §10).
        self.nonces = NonceCache()
        # CONTRACT-V5: game status, presence-like and in memory only.
        self.activity = ActivityBoard(self.broadcast, now)

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
            "server_version": VERSION,
            "server": self.server,
            "user": self.users[user_id],
            "users": [
                {
                    "id": u["id"],
                    "name": u["name"],
                    "avatar_url": u.get("avatar_url"),
                    "online": bool(self.conns.get(u["id"])),
                }
                for u in self.users.values()
            ],
            "channels": list(self.channels.values()),
            "voice": {
                str(channel["id"]): [
                    {
                        "user_id": uid,
                        **member.flags(),
                        # Only to the member themselves: which call holds their place.
                        **(
                            {"session": member.session}
                            if uid == user_id and member.session is not None
                            else {}
                        ),
                    }
                    for uid, member in self.voice.get(channel["id"], {}).items()
                ]
                for channel in self.channels.values()
                if channel["kind"] == "voice"
            },
            "activity": self.activity.snapshot(),
        }

    def connect(self, conn: Connection) -> None:
        """Register a connection: ``ready`` to it, ``presence`` to the others."""
        first = not self.conns.get(conn.user_id)
        self.conns.setdefault(conn.user_id, set()).add(conn)
        self.activity.user_online(conn.user_id)
        conn.send(self.ready_frame(conn.user_id))
        if first:
            frame = {"type": "presence", "user_id": conn.user_id, "online": True}
            self.broadcast(frame, exclude_user=conn.user_id)

    def disconnect(self, conn: Connection, *, grace: bool = True) -> None:
        """Forget ``conn``. Its voice membership goes into the reconnect grace
        (CONTRACT-V4 A1) unless ``grace`` is False (a server-side kick)."""
        conns = self.conns.get(conn.user_id)
        if conns is None or conn not in conns:
            return
        conns.discard(conn)
        if not conns:
            del self.conns[conn.user_id]
        channel_id = self.voice_of.get(conn.user_id)
        if channel_id is not None and self.voice[channel_id][conn.user_id].conn is conn:
            if grace:
                self.voice_disconnected(conn.user_id)
            else:
                self.voice_leave(conn.user_id)
        if conn.user_id not in self.conns:
            self.broadcast({"type": "presence", "user_id": conn.user_id, "online": False})
            self.activity.user_offline(conn.user_id)

    def connection_count(self, user_id: int) -> int:
        return len(self.conns.get(user_id, ()))

    def kick(self, conn: Connection, code: int, reason: str = "") -> None:
        """Forget ``conn`` now (presence, voice, no grace) and close it with ``code``."""
        self.disconnect(conn, grace=False)
        conn.kick(code, reason)

    def kick_token(self, token_hash: str, code: int = CLOSE_UNAUTHORIZED) -> int:
        """Close every socket that signed in with this token; how many."""
        doomed = [c for conns in self.conns.values() for c in conns if c.token_hash == token_hash]
        for conn in doomed:
            self.kick(conn, code, "signed out")
        return len(doomed)

    def token_hashes(self) -> set[str]:
        return {c.token_hash for conns in self.conns.values() for c in conns}

    def sync_users(self, users: list[dict[str, Any]]) -> None:
        """Mirror the database's list of (not removed) users.

        A user who is gone (removed with the admin tool while the server ran)
        leaves ``users`` and everybody gets ``user.removed``.
        """
        current = {u["id"]: u for u in users}
        for user_id in [uid for uid in self.users if uid not in current]:
            del self.users[user_id]
            self.activity.clear(user_id)
            self.broadcast({"type": "user.removed", "user_id": user_id})
        for user in users:
            if user["id"] not in self.users:
                self.add_user(user)

    def add_user(self, user: dict[str, Any]) -> None:
        self.users[user["id"]] = user
        self.broadcast({"type": "user.joined", "user": user})

    def update_user(self, user: dict[str, Any]) -> None:
        """A rename or a new avatar: ``user.updated`` to everyone."""
        if user["id"] not in self.users:
            return  # removed meanwhile
        self.users[user["id"]] = user
        self.broadcast({"type": "user.updated", "user": user})

    def update_server(self, server: dict[str, Any]) -> None:
        self.server = server
        self.broadcast({"type": "server.updated", "server": server})

    def add_channel(self, channel: dict[str, Any]) -> None:
        self.channels[channel["id"]] = channel
        self.broadcast({"type": "channel.new", "channel": channel})

    # -- voice --------------------------------------------------------------

    def voice_member(self, user_id: int) -> tuple[int, VoiceMember] | None:
        """Where ``user_id`` is in voice WITH a voice-bound connection.

        A member in the reconnect grace has none: for signalling, state and
        rings they are not reachable (``NOT_IN_VOICE``), although they are
        still listed in the room (``voice_channel_of``).
        """
        channel_id = self.voice_of.get(user_id)
        if channel_id is None:
            return None
        member = self.voice[channel_id][user_id]
        if member.conn is None:
            return None
        return channel_id, member

    def voice_channel_of(self, user_id: int) -> int | None:
        """The voice channel ``user_id`` is listed in, reconnecting or not."""
        return self.voice_of.get(user_id)

    def _cancel_grace(self, user_id: int) -> None:
        task = self._grace_tasks.pop(user_id, None)
        if task is not None and task is not asyncio.current_task():
            task.cancel()

    def voice_disconnected(self, user_id: int) -> None:
        """The voice-bound socket closed: keep the member, marked reconnecting,
        for ``grace_seconds``; ``voice.left`` only if no resume comes."""
        channel_id = self.voice_of[user_id]
        member = self.voice[channel_id][user_id]
        member.conn = None
        member.grace_until = self.now() + self.grace_seconds
        self.broadcast(
            {"type": "voice.state", "channel_id": channel_id, "user_id": user_id, **member.flags()}
        )
        self._cancel_grace(user_id)
        try:
            task = asyncio.get_running_loop().create_task(self._grace_timer(user_id))
        except RuntimeError:  # no loop (a unit test driving the hub by hand)
            return
        self._grace_tasks[user_id] = task

    async def _grace_timer(self, user_id: int) -> None:
        await asyncio.sleep(self.grace_seconds)
        self._grace_tasks.pop(user_id, None)
        self.expire_graces(force_user=user_id)

    def expire_graces(self, *, force_user: int | None = None) -> list[int]:
        """End every grace that is over by the app clock (and ``force_user``'s,
        whose timer has run out): ``voice.left`` for each. Which users left."""
        now = self.now()
        ended = []
        for members in list(self.voice.values()):
            for user_id, member in list(members.items()):
                if member.grace_until is None:
                    continue
                if member.grace_until <= now or user_id == force_user:
                    ended.append(user_id)
        for user_id in ended:
            self.voice_leave(user_id)
        return ended

    def close(self) -> None:
        """Server shutdown: stop the grace timers (state is in memory anyway)."""
        for task in self._grace_tasks.values():
            task.cancel()
        self._grace_tasks.clear()
        self.activity.close()

    def voice_leave(self, user_id: int) -> None:
        self._cancel_grace(user_id)
        channel_id = self.voice_of.pop(user_id, None)
        if channel_id is None:
            return
        members = self.voice[channel_id]
        del members[user_id]
        if not members:
            del self.voice[channel_id]
        self.broadcast({"type": "voice.left", "channel_id": channel_id, "user_id": user_id})

    def voice_join(
        self,
        conn: Connection,
        channel_id: int,
        muted: bool,
        deafened: bool,
        camera: bool = False,
        *,
        screensharing: bool = False,
        resume: bool = False,
        session: str | None = None,
    ) -> None:
        """Leave wherever the user was, then join, bound to ``conn``.

        A ``resume`` into the channel where the user is reconnecting takes the
        membership over without ``voice.left`` (CONTRACT-V4 A1). So does a
        resume carrying the ``session`` of the current membership even while
        that one still has a connection: the server has not noticed yet that
        it is dead (a half-open socket), and the client is the same call.
        Every other join, resume or not, first leaves wherever the user was.
        """
        user_id = conn.user_id
        current = self.voice_of.get(user_id)
        existing = self.voice[channel_id].get(user_id) if current == channel_id else None
        taking_over = (
            resume
            and existing is not None
            and (existing.reconnecting or (session is not None and existing.session == session))
        )
        if taking_over:
            self._cancel_grace(user_id)
            del self.voice[channel_id][user_id]
        else:
            self.voice_leave(user_id)
        members = self.voice.setdefault(channel_id, {})
        conn.send(
            {
                "type": "voice.peers",
                "channel_id": channel_id,
                # Only peers that can be signalled now; those in their own
                # grace come back with a voice.joined {resumed: true}.
                "peers": [uid for uid, m in members.items() if not m.reconnecting],
                "reconnecting": [uid for uid, m in members.items() if m.reconnecting],
                "resumed": resume,
            }
        )
        member = VoiceMember(
            conn=conn,
            muted=muted,
            deafened=deafened,
            camera=camera,
            screensharing=screensharing,
            session=session,
        )
        members[user_id] = member
        self.voice_of[user_id] = channel_id
        self.broadcast(
            {
                "type": "voice.joined",
                "channel_id": channel_id,
                "user_id": user_id,
                **member.flags(),
                "resumed": resume,
            }
        )

    def voice_ring(self, user_id: int, channel_id: int) -> None:
        """``voice.ring`` to every online user not listed in ``channel_id``."""
        frame = {"type": "voice.ring", "channel_id": channel_id, "from": user_id}
        inside = self.voice.get(channel_id, {})
        for target in list(self.conns):
            if target not in inside:
                self.send_to_user(target, frame)

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
