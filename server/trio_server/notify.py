"""Who is told about what, decided on the server (CONTRACT-V6-PUSH §3-§5).

The hub calls the three hooks (``message_new``, ``voice_joined``, ``voice_ring``)
synchronously, right after its own broadcast; this module decides at that
instant (the viewing state and the clock are read then) and hands the
recipients to ``push.PushSender``, which does all I/O off the request path.
Preferences are tiny, so all of them are mirrored in memory and written
through to the database.
"""

from __future__ import annotations

import json
import logging
import re
import time
import weakref
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError, available_timezones

from trio_server.mentions import mentioned_users

logger = logging.getLogger("trio.notify")

LEVELS = ("all", "mentions", "none")
DEFAULT_TZ = "Europe/Istanbul"
# A connection that never sent client.viewing counts as viewing for this long
# after it connected (an old client, or a new one before its first report),
# and as not viewing afterwards.
UNREPORTED_VIEWING_SECONDS = 30.0
VOICE_COOLDOWN_SECONDS = 600.0
BODY_CHARS = 120
_HHMM = re.compile(r"^([01][0-9]|2[0-3]):([0-5][0-9])$")

Kind = Literal["message", "voice", "ring"]


# -- preferences ------------------------------------------------------------------


def default_prefs() -> dict[str, Any]:
    return {
        "channels": {},
        "quiet": {"enabled": False, "start": "23:00", "end": "08:00", "tz": DEFAULT_TZ},
        "voice_rooms": True,
        "calls": True,
        "calls_break_quiet": False,
    }


class PrefsError(ValueError):
    pass


def _valid_tz(name: Any) -> bool:
    if not isinstance(name, str) or not 1 <= len(name) <= 64 or ".." in name:
        return False
    if name in ("UTC", "Etc/UTC"):
        return True
    try:
        ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError, OSError):
        return False
    return name in _zones()


_ZONES: set[str] | None = None


def _zones() -> set[str]:
    global _ZONES
    if _ZONES is None:
        _ZONES = available_timezones()
    return _ZONES


def merge_prefs(
    current: dict[str, Any], patch: dict[str, Any], channel_ids: set[int]
) -> dict[str, Any]:
    """``current`` with ``patch`` applied; PrefsError names the field that is wrong."""
    known = {"channels", "quiet", "voice_rooms", "calls", "calls_break_quiet"}
    unknown = set(patch) - known
    if unknown:
        raise PrefsError(f"unknown field {sorted(unknown)[0]!r}")
    out = json.loads(json.dumps(current))
    for key in ("voice_rooms", "calls", "calls_break_quiet"):
        if key in patch:
            if not isinstance(patch[key], bool):
                raise PrefsError(f"{key!r} must be a boolean")
            out[key] = patch[key]
    if "channels" in patch:
        channels = patch["channels"]
        if not isinstance(channels, dict) or len(channels) > 200:
            raise PrefsError("'channels' must be an object of channel id -> level")
        for raw_id, level in channels.items():
            if not (isinstance(raw_id, str) and raw_id.isdigit() and int(raw_id) in channel_ids):
                raise PrefsError("'channels' names an unknown channel")
            if level is None or level == "all":
                out["channels"].pop(str(int(raw_id)), None)
            elif level in LEVELS:
                out["channels"][str(int(raw_id))] = level
            else:
                raise PrefsError("a channel level must be 'all', 'mentions' or 'none'")
    if "quiet" in patch:
        quiet = patch["quiet"]
        if not isinstance(quiet, dict) or set(quiet) - {"enabled", "start", "end", "tz"}:
            raise PrefsError("'quiet' must be {enabled, start, end, tz}")
        merged = {**out["quiet"], **quiet}
        if not isinstance(merged["enabled"], bool):
            raise PrefsError("'quiet.enabled' must be a boolean")
        for key in ("start", "end"):
            if not isinstance(merged[key], str) or not _HHMM.match(merged[key]):
                raise PrefsError(f"'quiet.{key}' must be HH:MM")
        if not _valid_tz(merged["tz"]):
            raise PrefsError("'quiet.tz' must be an IANA time zone")
        out["quiet"] = merged
    return out


def _minutes(hhmm: str) -> int:
    hours, minutes = hhmm.split(":")
    return int(hours) * 60 + int(minutes)


def in_quiet_hours(quiet: dict[str, Any], now: float) -> bool:
    """Whether ``now`` (epoch seconds) falls in the daily range, in its zone.

    ``start`` inclusive, ``end`` exclusive; a range with start > end runs over
    midnight; start == end is no range. Wall-clock time: on a DST change day
    the range follows the clock on the wall (23:00 is 23:00 local).
    """
    if not quiet.get("enabled"):
        return False
    start, end = _minutes(quiet["start"]), _minutes(quiet["end"])
    if start == end:
        return False
    try:
        zone = ZoneInfo(quiet.get("tz") or DEFAULT_TZ)
    except (ZoneInfoNotFoundError, ValueError):
        zone = ZoneInfo(DEFAULT_TZ)
    local = datetime.fromtimestamp(now, UTC).astimezone(zone)
    minute = local.hour * 60 + local.minute
    if start < end:
        return start <= minute < end
    return minute >= start or minute < end


# -- the decision ----------------------------------------------------------------


@dataclass(frozen=True)
class Situation:
    """Everything one push decision reads, for one recipient and one event."""

    kind: Kind
    own: bool = False
    viewing: bool = False
    level: str = "all"
    quiet: bool = False
    mention: bool = False
    # voice: listed in any voice room; ring: listed in the rung room.
    in_voice: bool = False
    voice_rooms: bool = True
    calls: bool = True
    calls_break_quiet: bool = False


def decide(s: Situation) -> tuple[bool, str]:
    """``(push?, why)``; ``why`` is a short reason, logged and asserted by tests."""
    if s.own:
        return False, "own"
    if s.viewing:
        return False, "viewing"
    if s.kind == "message":
        if s.level == "none":
            return False, "level-none"
        if s.mention:
            return True, "mention"
        if s.level == "mentions":
            return False, "level-mentions"
        if s.quiet:
            return False, "quiet"
        return True, "message"
    if s.kind == "voice":
        if not s.voice_rooms:
            return False, "voice-off"
        if s.level != "all":
            return False, f"level-{s.level}"
        if s.in_voice:
            return False, "in-voice"
        if s.quiet:
            return False, "quiet"
        return True, "voice"
    # ring: no channel level of its own (the "Çağrılar" switch instead).
    if not s.calls:
        return False, "calls-off"
    if s.in_voice:
        return False, "in-voice"
    if s.quiet and not s.calls_break_quiet:
        return False, "quiet"
    return True, "ring"


# -- viewing state per connection ------------------------------------------------


@dataclass
class ViewState:
    connected_at: float
    viewing: bool | None = None  # None: never reported
    channel_id: int | None = None


@dataclass
class Notifier:
    """Mirror of the preferences, viewing states and cool-downs; the hub's hooks."""

    hub: Any
    enqueue: Callable[[list[int], dict[str, Any], dict[str, Any]], None]
    now: Callable[[], float] = time.time
    prefs: dict[int, dict[str, Any]] = field(default_factory=dict)
    voice_announced: dict[int, float] = field(default_factory=dict)
    views: weakref.WeakKeyDictionary[Any, ViewState] = field(
        default_factory=weakref.WeakKeyDictionary
    )

    # -- state ----------------------------------------------------------------

    def prefs_of(self, user_id: int) -> dict[str, Any]:
        return self.prefs.get(user_id) or default_prefs()

    def connected(self, conn: Any) -> None:
        self.views[conn] = ViewState(connected_at=self.now())

    def set_viewing(self, conn: Any, viewing: bool, channel_id: int | None) -> None:
        state = self.views.get(conn)
        if state is None:
            state = self.views[conn] = ViewState(connected_at=self.now())
        state.viewing = viewing
        state.channel_id = channel_id

    def is_viewing(self, user_id: int) -> bool:
        """True when ANY open connection of the user is being looked at."""
        now = self.now()
        for conn in self.hub.conns.get(user_id, ()):
            if getattr(conn, "closed", False):
                continue
            state = self.views.get(conn)
            if state is None:
                continue
            if state.viewing is None:
                if now - state.connected_at < UNREPORTED_VIEWING_SECONDS:
                    return True
            elif state.viewing:
                return True
        return False

    def _level(self, prefs: dict[str, Any], channel_id: int) -> str:
        return prefs["channels"].get(str(channel_id), "all")

    def _situation(self, user_id: int, kind: Kind, **extra: Any) -> Situation:
        prefs = self.prefs_of(user_id)
        return Situation(
            kind=kind,
            viewing=self.is_viewing(user_id),
            quiet=in_quiet_hours(prefs["quiet"], self.now()),
            voice_rooms=prefs["voice_rooms"],
            calls=prefs["calls"],
            calls_break_quiet=prefs["calls_break_quiet"],
            **extra,
        )

    def _recipients(self, author: int, decide_for: Callable[[int], Situation]) -> list[int]:
        out = []
        for user_id in list(self.hub.users):
            if user_id == author:
                continue
            push, why = decide(decide_for(user_id))
            logger.debug("notify.decide user=%s push=%s why=%s", user_id, push, why)
            if push:
                out.append(user_id)
        return out

    # -- hooks ------------------------------------------------------------------

    def message_new(self, message: dict[str, Any]) -> None:
        try:
            self._message_new(message)
        except Exception:  # noqa: BLE001 - a notification must never break chat
            logger.exception("notify.message.failed")

    def _message_new(self, message: dict[str, Any]) -> None:
        channel_id = message["channel_id"]
        author = message["author"]["id"]
        names = {uid: u["name"] for uid, u in self.hub.users.items()}
        named, everyone = mentioned_users(message.get("content") or "", names)

        def situation(user_id: int) -> Situation:
            prefs = self.prefs_of(user_id)
            return self._situation(
                user_id,
                "message",
                level=self._level(prefs, channel_id),
                mention=everyone or user_id in named,
            )

        recipients = self._recipients(author, situation)
        if not recipients:
            return
        channel = self.hub.channels.get(channel_id, {})
        base = message_payload(message, channel.get("name", ""))
        mentioned = [u for u in recipients if everyone or u in named]
        plain = [u for u in recipients if u not in mentioned]
        if plain:
            self.enqueue(plain, base, {"ttl": 6 * 3600, "urgency": "high"})
        if mentioned:
            self.enqueue(
                mentioned,
                {**base, "kind": "mention", "renotify": True},
                {"ttl": 24 * 3600, "urgency": "high"},
            )

    def voice_joined(self, channel_id: int, user_id: int, *, opened: bool, resumed: bool) -> None:
        """A join; ``opened``: the room was empty before it."""
        try:
            if not opened or resumed:
                return
            now = self.now()
            last = self.voice_announced.get(channel_id)
            if last is not None and now - last < VOICE_COOLDOWN_SECONDS:
                return
            self.voice_announced[channel_id] = now

            def situation(target: int) -> Situation:
                prefs = self.prefs_of(target)
                return self._situation(
                    target,
                    "voice",
                    level=self._level(prefs, channel_id),
                    in_voice=self.hub.voice_channel_of(target) is not None,
                )

            recipients = self._recipients(user_id, situation)
            if not recipients:
                return
            name = self.hub.users.get(user_id, {}).get("name", "Biri")
            room = self.hub.channels.get(channel_id, {}).get("name", "")
            payload = {
                "v": 1,
                "kind": "voice",
                "title": f"{name} ses odasına girdi",
                "body": f"🔊 {room}",
                "tag": f"voice-{channel_id}",
                "channel_id": channel_id,
            }
            self.enqueue(
                recipients, payload, {"ttl": int(VOICE_COOLDOWN_SECONDS), "urgency": "normal"}
            )
        except Exception:  # noqa: BLE001
            logger.exception("notify.voice.failed")

    def voice_ring(self, user_id: int, channel_id: int) -> None:
        try:
            inside = self.hub.voice.get(channel_id, {})

            def situation(target: int) -> Situation:
                return self._situation(target, "ring", in_voice=target in inside)

            recipients = self._recipients(user_id, situation)
            if not recipients:
                return
            name = self.hub.users.get(user_id, {}).get("name", "Biri")
            room = self.hub.channels.get(channel_id, {}).get("name", "")
            payload = {
                "v": 1,
                "kind": "ring",
                "title": "Trio — sesli çağrı",
                "body": f"{name} seni {room} odasına çağırıyor",
                "tag": f"ring-{channel_id}",
                "channel_id": channel_id,
                "renotify": True,
            }
            self.enqueue(recipients, payload, {"ttl": 60, "urgency": "high"})
        except Exception:  # noqa: BLE001
            logger.exception("notify.ring.failed")


def message_payload(message: dict[str, Any], channel_name: str) -> dict[str, Any]:
    """The payload of a message push: ids and short text only (it must stay < 4 KB)."""
    content = (message.get("content") or "").strip()
    if content:
        body = " ".join(content.split())
        if len(body) > BODY_CHARS:
            body = body[: BODY_CHARS - 1].rstrip() + "…"
    else:
        types = [a.get("content_type", "") for a in message.get("attachments") or []]
        if types and all(t.startswith("audio/") for t in types):
            body = "🎤 sesli mesaj"
        elif types and all(t.startswith("image/") for t in types):
            body = "📎 fotoğraf"
        elif types and all(t.startswith("video/") for t in types):
            body = "📎 video"
        else:
            body = "📎 dosya"
    author = message["author"]["name"][:40]
    return {
        "v": 1,
        "kind": "message",
        "title": f"{author} — #{channel_name[:40]}",
        "author": author,
        "channel": channel_name[:40],
        "body": body,
        "tag": f"ch-{message['channel_id']}",
        "channel_id": message["channel_id"],
        "message_id": message["id"],
    }
