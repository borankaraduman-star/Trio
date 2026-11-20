"""Who is in which text channel right now (CONTRACT-V10-GROUPS §4b).

The client already tells the server, per connection, whether it is being
looked at and which channel it shows (``client.viewing``, CONTRACT-V6-PUSH
§3). From that this board keeps, per user, the ONE text channel they are in:
the channel of their most recently reported connection that is being looked
at and shares it (``show_channel``, default true). None when no connection
is being looked at (a hidden tab, the app in the tray, a phone in the
background), when the person turned "Hangi kanalda olduğumu göster" off, or
for a client that never reports.

Everybody is told with ``presence.viewing {user_id, channel_id}``, at most one
per user per ``window`` seconds: the first change goes at once, later ones in
the window are coalesced and the state at its end is sent (if it differs from
what was sent). ``ready.viewers`` carries the state as it is now. Nothing is
stored; nothing is kept once the connection closes. Only CURRENT presence:
no "seen", no history, no read receipts.

Push decisions are not read from here: the notifier keeps its own per
connection state from the same frame, unchanged.
"""

from __future__ import annotations

import asyncio
import itertools
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

# At most one presence.viewing per user per this many seconds.
VIEWERS_WINDOW_SECONDS = 0.5
# ``client.viewing`` frames per user per minute (the client sends one per
# focus change or channel switch; fast hopping is a few a second).
VIEWING_LIMIT = 240
VIEWING_WINDOW_SECONDS = 60.0


@dataclass
class _ConnView:
    viewing: bool
    channel_id: int | None  # None: not sharing, or no channel
    order: int  # higher = reported later


class ViewerBoard:
    def __init__(
        self,
        broadcast: Callable[[dict[str, Any]], None],
        channel_ok: Callable[[int], bool],
    ) -> None:
        self._broadcast = broadcast
        self._channel_ok = channel_ok
        self.window = VIEWERS_WINDOW_SECONDS
        self._views: dict[int, dict[Any, _ConnView]] = {}  # user -> conn -> view
        self._sent: dict[int, int | None] = {}  # user -> channel last broadcast
        self._last_at: dict[int, float] = {}  # user -> loop time of that broadcast
        self._timers: dict[int, asyncio.TimerHandle] = {}
        self._order = itertools.count(1)

    # -- reading ------------------------------------------------------------

    def channel_of(self, user_id: int) -> int | None:
        best: _ConnView | None = None
        for view in self._views.get(user_id, {}).values():
            if not view.viewing or view.channel_id is None:
                continue
            if not self._channel_ok(view.channel_id):
                continue
            if best is None or view.order > best.order:
                best = view
        return None if best is None else best.channel_id

    def snapshot(self) -> dict[str, list[int]]:
        """``ready.viewers``: channel id -> the users in it now (sorted)."""
        out: dict[str, list[int]] = {}
        for user_id in sorted(self._views):
            channel_id = self.channel_of(user_id)
            if channel_id is not None:
                out.setdefault(str(channel_id), []).append(user_id)
        return out

    # -- changes ------------------------------------------------------------

    def report(self, user_id: int, conn: Any, *, viewing: bool, channel_id: int | None) -> None:
        """A ``client.viewing`` of ``conn`` (``channel_id`` None when not shared)."""
        self._views.setdefault(user_id, {})[conn] = _ConnView(
            viewing=viewing, channel_id=channel_id, order=next(self._order)
        )
        self._changed(user_id)

    def disconnected(self, user_id: int, conn: Any) -> None:
        views = self._views.get(user_id)
        if views is None or conn not in views:
            return
        del views[conn]
        if not views:
            del self._views[user_id]
        self._changed(user_id)

    def forget_user(self, user_id: int) -> None:
        self._views.pop(user_id, None)
        self._changed(user_id)

    def channel_gone(self, channel_id: int) -> None:
        """A deleted channel: whoever was in it is in none now."""
        for user_id in [u for u, sent in self._sent.items() if sent == channel_id]:
            self._changed(user_id)

    def close(self) -> None:
        for timer in self._timers.values():
            timer.cancel()
        self._timers.clear()

    # -- coalescing -----------------------------------------------------------

    def _changed(self, user_id: int) -> None:
        if user_id in self._timers:
            return  # the pending send reads the state at its time
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:  # no loop (a unit test driving the board by hand)
            self._flush(user_id, None)
            return
        now = loop.time()
        last = self._last_at.get(user_id)
        if last is None or now - last >= self.window:
            self._flush(user_id, now)
            return
        self._timers[user_id] = loop.call_later(last + self.window - now, self._fire, user_id)

    def _fire(self, user_id: int) -> None:
        self._timers.pop(user_id, None)
        try:
            now = asyncio.get_running_loop().time()
        except RuntimeError:
            now = None
        self._flush(user_id, now)

    def _flush(self, user_id: int, now: float | None) -> None:
        channel_id = self.channel_of(user_id)
        if self._sent.get(user_id) == channel_id:
            return
        if channel_id is None:
            self._sent.pop(user_id, None)
        else:
            self._sent[user_id] = channel_id
        if now is not None:
            self._last_at[user_id] = now
        self._broadcast({"type": "presence.viewing", "user_id": user_id, "channel_id": channel_id})
