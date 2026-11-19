"""CONTRACT-V5: "oyun durumu" — what game a user is in, kept in memory only.

It is presence, like voice state: the hub is in memory by design (CLAUDE.md),
nothing here touches the database, and a restart forgets everything (the
desktop app re-sends within one heartbeat).

    client -> server   activity.set   {game, since, detail?: {character, realm, level,
                                       class, zone, subzone, source: "log" | "saved"}}
    client -> server   activity.clear {}
    server -> everyone activity       {user_id, activity | null, updated_at}
    ready.activity     {"<user id>": {activity, updated_at}}

An entry goes away (``activity {activity: null}`` to everyone) when:

- it is not refreshed for ``ttl_seconds`` (10 minutes);
- the user's last socket closed and none came back within ``grace_seconds``
  (a reconnect after a deploy keeps it);
- the user asks (``activity.clear``) or is removed.

Every method that broadcasts is synchronous, like the hub's: on the single
event loop each one is atomic with respect to a ``ready`` snapshot.
"""

from __future__ import annotations

import asyncio
import unicodedata
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from trio_server.ratelimit import SlidingWindow

ACTIVITY_TTL_SECONDS = 600.0
ACTIVITY_GRACE_SECONDS = 30.0
ACTIVITY_LIMIT = 30
ACTIVITY_WINDOW_SECONDS = 60.0
SWEEP_SECONDS = 15.0

GAME_MAX = 64
SOURCES = ("log", "saved")
LEVEL_MIN = 1
LEVEL_MAX = 999
# ``since`` is a unix time in seconds: when the game process was first seen.
# Not before 2000, and at most a few minutes in the future (clock skew).
SINCE_MIN = 946_684_800
SINCE_SKEW_SECONDS = 300
# Lengths in code points after trim. A WoW character name (Forever allows
# spaces, e.g. "Kahve Kokusu") and a realm are short; zone names are
# localized and can be long.
CHARACTER_MAX = 48
REALM_MAX = 64
ZONE_MAX = 96
CLASS_MAX = 24
KEYS = {"type", "game", "since", "detail"}
DETAIL_KEYS = {"character", "realm", "level", "class", "zone", "subzone", "source"}


class ActivityError(ValueError):
    pass


def iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _text(frame: dict[str, Any], key: str, maximum: int, *, required: bool = False) -> str:
    value = frame.get(key, "")
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise ActivityError(f"'{key}' must be a string")
    text = unicodedata.normalize("NFC", value).strip()
    if len(text) > maximum:
        raise ActivityError(f"'{key}' is at most {maximum} characters")
    if required and not text:
        raise ActivityError(f"'{key}' is required")
    if any(unicodedata.category(ch) in ("Cc", "Cf", "Cs", "Zl", "Zp") for ch in text):
        raise ActivityError(f"'{key}' must be one line of visible text")
    return text


def _detail(value: Any) -> dict[str, Any] | None:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ActivityError("'detail' must be an object or null")
    unknown = set(value) - DETAIL_KEYS
    if unknown:
        raise ActivityError("unknown detail field " + repr(sorted(unknown)[0]))
    level = value.get("level")
    if not isinstance(level, int) or isinstance(level, bool) or not LEVEL_MIN <= level <= LEVEL_MAX:
        raise ActivityError(f"'detail.level' must be an integer {LEVEL_MIN}-{LEVEL_MAX}")
    klass = _text(value, "class", CLASS_MAX)
    if klass and not all("A" <= ch <= "Z" or ch == "_" for ch in klass):
        raise ActivityError("'detail.class' must be a class token like ROGUE")
    source = value.get("source")
    if source not in SOURCES:
        raise ActivityError('\'detail.source\' must be "log" or "saved"')
    return {
        "character": _text(value, "character", CHARACTER_MAX, required=True),
        "realm": _text(value, "realm", REALM_MAX),
        "level": level,
        "class": klass,
        "zone": _text(value, "zone", ZONE_MAX),
        "subzone": _text(value, "subzone", ZONE_MAX),
        "source": source,
    }


def parse_activity(frame: dict[str, Any], now: float) -> dict[str, Any]:
    """The validated activity of an ``activity.set`` frame, or ActivityError."""
    unknown = set(frame) - KEYS
    if unknown:
        raise ActivityError("unknown field " + repr(sorted(unknown)[0]))
    game = _text(frame, "game", GAME_MAX, required=True)
    since = frame.get("since")
    if (
        not isinstance(since, int)
        or isinstance(since, bool)
        or not SINCE_MIN <= since <= now + SINCE_SKEW_SECONDS
    ):
        raise ActivityError("'since' must be a unix time in seconds, not in the future")
    return {"game": game, "since": since, "detail": _detail(frame.get("detail"))}


@dataclass
class Entry:
    activity: dict[str, Any]
    updated_at: float
    # App-clock time the user's last socket closed; None while online.
    offline_since: float | None = None

    def public(self) -> dict[str, Any]:
        return {"activity": self.activity, "updated_at": iso(self.updated_at)}


class ActivityBoard:
    def __init__(
        self,
        broadcast: Callable[[dict[str, Any]], None],
        now: Callable[[], float],
    ) -> None:
        self._broadcast = broadcast
        self.now = now
        self.ttl_seconds = ACTIVITY_TTL_SECONDS
        self.grace_seconds = ACTIVITY_GRACE_SECONDS
        self.limit = SlidingWindow(ACTIVITY_LIMIT, ACTIVITY_WINDOW_SECONDS, now)
        self.entries: dict[int, Entry] = {}
        self._sweeper: asyncio.Task[None] | None = None

    # -- reading ------------------------------------------------------------

    def snapshot(self) -> dict[str, dict[str, Any]]:
        """``ready.activity``: the live entries.

        Stale ones are left out but NOT cleared here: clearing broadcasts, and
        this runs while a new socket is being registered, before its ``ready``.
        """
        return {
            str(uid): entry.public() for uid, entry in self.entries.items() if self._live(entry)
        }

    def _live(self, entry: Entry) -> bool:
        now = self.now()
        if now - entry.updated_at >= self.ttl_seconds:
            return False
        return entry.offline_since is None or now - entry.offline_since < self.grace_seconds

    # -- changes ------------------------------------------------------------

    def allow(self, user_id: int) -> bool:
        return self.limit.allow(str(user_id))

    def set(self, user_id: int, activity: dict[str, Any]) -> None:
        self.expire()
        now = self.now()
        self.entries[user_id] = Entry(activity=activity, updated_at=now)
        self._broadcast(
            {"type": "activity", "user_id": user_id, "activity": activity, "updated_at": iso(now)}
        )
        self._ensure_sweeper()

    def clear(self, user_id: int) -> None:
        """Forget ``user_id``'s activity; broadcast only when there was one."""
        if self.entries.pop(user_id, None) is None:
            return
        frame = {"type": "activity", "user_id": user_id, "activity": None}
        self._broadcast({**frame, "updated_at": iso(self.now())})

    def user_online(self, user_id: int) -> None:
        entry = self.entries.get(user_id)
        if entry is not None:
            entry.offline_since = None

    def user_offline(self, user_id: int) -> None:
        entry = self.entries.get(user_id)
        if entry is not None and entry.offline_since is None:
            entry.offline_since = self.now()

    def expire(self) -> list[int]:
        """Clear every entry past its TTL or its offline grace; which users."""
        ended = [uid for uid, entry in self.entries.items() if not self._live(entry)]
        for uid in ended:
            self.clear(uid)
        return ended

    # -- the sweeper ----------------------------------------------------------

    def _ensure_sweeper(self) -> None:
        if self._sweeper is not None and not self._sweeper.done():
            return
        try:
            self._sweeper = asyncio.get_running_loop().create_task(self._sweep())
        except RuntimeError:  # no loop (a unit test driving the board by hand)
            self._sweeper = None

    async def _sweep(self) -> None:
        while self.entries:
            await asyncio.sleep(SWEEP_SECONDS)
            self.expire()

    def close(self) -> None:
        if self._sweeper is not None:
            self._sweeper.cancel()
            self._sweeper = None
