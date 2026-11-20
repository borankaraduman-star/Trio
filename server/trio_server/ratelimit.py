"""Attempt limits for POST /api/join, kept in process memory.

Two layers (see ``JoinGuard`` for why both, and why the second one is shaped
the way it is):

- a per-address window on every attempt, right or wrong;
- a GLOBAL ceiling on failed attempts (wrong invite code or wrong link code),
  which bounds brute force no matter how many addresses a caller has or can
  pretend to have.
"""

from __future__ import annotations

import ipaddress
import math
from collections import OrderedDict, deque
from collections.abc import Callable

from starlette.requests import HTTPConnection

# Distinct keys a window remembers. Past it the least recently used key is
# forgotten; that can only reset somebody's per-address budget early, which
# the global failure ceiling makes harmless for brute force.
MAX_KEYS = 10_000


class SlidingWindow:
    """At most ``limit`` events per key within ``window_seconds``.

    Memory is bounded (``max_keys`` keys of at most ``limit`` timestamps each)
    and pruning is O(1) amortised: keys are kept in the order of their newest
    event, so every key whose events have all expired sits at the front and is
    dropped exactly once.
    """

    def __init__(
        self,
        limit: int,
        window_seconds: float,
        now: Callable[[], float],
        *,
        max_keys: int = MAX_KEYS,
    ) -> None:
        self._limit = limit
        self._window = window_seconds
        self._now = now
        self._max_keys = max_keys
        self._events: OrderedDict[str, deque[float]] = OrderedDict()

    def __len__(self) -> int:
        return len(self._events)

    def _prune(self, now: float) -> None:
        cutoff = now - self._window
        while self._events:
            events = next(iter(self._events.values()))
            if events and events[-1] > cutoff:
                break
            self._events.popitem(last=False)

    def _live(self, key: str, now: float) -> deque[float] | None:
        events = self._events.get(key)
        if events is None:
            return None
        cutoff = now - self._window
        while events and events[0] <= cutoff:
            events.popleft()
        return events

    def count(self, key: str) -> int:
        now = self._now()
        self._prune(now)
        events = self._live(key, now)
        return len(events) if events else 0

    def allow(self, key: str) -> bool:
        """Record one event for ``key``; False (and nothing recorded) when over the limit."""
        now = self._now()
        self._prune(now)
        events = self._live(key, now)
        if events is not None and len(events) >= self._limit:
            return False
        if events is None:
            events = self._events[key] = deque()
        events.append(now)
        self._events.move_to_end(key)
        while len(self._events) > self._max_keys:
            self._events.popitem(last=False)
        return True

    def refund(self, key: str) -> None:
        """Take back the newest event of ``key`` (it turned out not to count)."""
        events = self._events.get(key)
        if events:
            events.pop()

    def retry_after(self, key: str) -> int:
        """Seconds until ``key``'s oldest live event leaves the window (at least 1)."""
        now = self._now()
        events = self._live(key, now)
        if not events:
            return 1
        return max(1, math.ceil(events[0] + self._window - now))


# Kept under its old name: the join route used it before the global ceiling.
AttemptLimiter = SlidingWindow


class JoinGuard:
    """Who may have their code checked by POST /api/join.

    Per address: ``per_address`` attempts (right or wrong) per window. That
    alone is not a bound on brute force, because an "address" is only as good
    as the header it was read from.

    Globally: at most ``global_failures`` FAILED attempts per window across
    every client. A global ceiling is itself a lock-out lever: somebody who
    floods wrong codes could keep the door shut for the friend who has the
    right one. So the ceiling never shuts the door completely. Once it is
    reached ("overflow"), one request every ``trickle_seconds`` is still let
    through to the constant-time check, and only from an address that has no
    failure of its own in the window. Consequences:

    - brute force is bounded at ``global_failures + window / trickle_seconds``
      checked guesses per window, from all clients together (30 + 60 per ten
      minutes with the defaults), whatever the addresses look like;
    - a legitimate join with the correct code gets through within one trickle
      period during a flood, unless the flooder can produce a fresh, clean
      address for every trickle slot. Behind a correctly configured
      TRIO_TRUSTED_PROXY_HOPS that means a new real IP every 10 seconds; when
      the address can be spoofed it degrades to "first one in each slot";
    - successes never count, so friends joining or linking devices never move
      anybody towards the ceiling.
    """

    def __init__(
        self,
        now: Callable[[], float],
        *,
        per_address: int = 10,
        window_seconds: float = 600,
        global_failures: int = 30,
        trickle_seconds: float = 10,
        max_keys: int = MAX_KEYS,
    ) -> None:
        self._now = now
        self._window = window_seconds
        self._ceiling = global_failures
        self._trickle = trickle_seconds
        self.attempts = SlidingWindow(per_address, window_seconds, now, max_keys=max_keys)
        # Failures per address; only "has any" is read.
        self.address_failures = SlidingWindow(
            global_failures, window_seconds, now, max_keys=max_keys
        )
        # Bounded by construction: only the newest ``ceiling`` failures matter.
        self._failures: deque[float] = deque(maxlen=global_failures)
        self._last_trickle = -math.inf

    def _global_failures(self, now: float) -> int:
        cutoff = now - self._window
        while self._failures and self._failures[0] <= cutoff:
            self._failures.popleft()
        return len(self._failures)

    @property
    def overflowing(self) -> bool:
        return self._global_failures(self._now()) >= self._ceiling

    def admit(self, address: str) -> int | None:
        """None: go on and check the code. An int: refuse, with that Retry-After."""
        if not self.attempts.allow(address):
            return self.attempts.retry_after(address)
        now = self._now()
        if self._global_failures(now) < self._ceiling:
            return None
        if self.address_failures.count(address):
            return self.address_failures.retry_after(address)
        wait = self._last_trickle + self._trickle - now
        if wait > 0:
            return max(1, math.ceil(wait))
        self._last_trickle = now
        return None

    def succeeded(self, address: str) -> None:
        """CONTRACT-V10-GROUPS §5: an account was made or a device linked. Its
        attempt is given back, so a group setting up together on one network
        (an office, a dorm: one public address) is not stopped after ten; a
        guesser never succeeds, so nothing changes for brute force."""
        self.attempts.refund(address)

    def failed(self, address: str) -> None:
        """The code that was checked was wrong."""
        self._failures.append(self._now())
        self.address_failures.allow(address)


def _rate_key(address: str) -> str | None:
    address = address.strip()
    # "[2001:db8::1]:443" and "203.0.113.7:51234" (some proxies add the port).
    if address.startswith("[") and "]" in address:
        address = address[1 : address.index("]")]
    elif address.count(":") == 1:
        address = address.split(":", 1)[0]
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return None
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.ipv4_mapped is not None:
            return str(ip.ipv4_mapped)
        # One subscriber usually holds a whole /64.
        return str(ipaddress.ip_network(f"{ip}/64", strict=False).network_address) + "/64"
    return str(ip)


def forwarded_entries(conn: HTTPConnection) -> list[str]:
    """Every X-Forwarded-For entry, in order, from ALL the header's lines.

    A header may legally be repeated, and a proxy that appends may add a
    line rather than extend the first one; reading only the first line would
    read the client's own value.
    """
    return [
        entry.strip()
        for line in conn.headers.getlist("x-forwarded-for")
        for entry in line.split(",")
        if entry.strip()
    ]


def client_address(conn: HTTPConnection, trusted_hops: int = 1) -> str:
    """The key a per-client limit counts by.

    Each trusted proxy appends the address it received the request from, so
    with ``trusted_hops`` proxies the client is the ``trusted_hops``-th entry
    from the right; everything left of it is whatever the client typed. With
    fewer entries than that, or an entry that is not an address, the request
    did not come through the proxies we expect and the socket peer is used.
    ``trusted_hops == 0`` ignores the header entirely (the app is reached
    directly).
    """
    if trusted_hops > 0:
        entries = forwarded_entries(conn)
        if len(entries) >= trusted_hops:
            key = _rate_key(entries[-trusted_hops])
            if key is not None:
                return key
    peer = conn.client.host if conn.client else ""
    return _rate_key(peer) or peer or "unknown"
