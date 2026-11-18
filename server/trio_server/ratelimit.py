"""Sliding-window attempt limiter for POST /api/join, kept in process memory."""

from __future__ import annotations

import ipaddress
from collections import deque
from collections.abc import Callable

from starlette.requests import HTTPConnection


class AttemptLimiter:
    def __init__(self, limit: int, window_seconds: float, now: Callable[[], float]) -> None:
        self._limit = limit
        self._window = window_seconds
        self._now = now
        self._attempts: dict[str, deque[float]] = {}

    def allow(self, key: str) -> bool:
        """Record one attempt for ``key``; False when it is over the limit."""
        now = self._now()
        cutoff = now - self._window
        if len(self._attempts) > 10_000:
            # Bound memory: forget every key whose attempts have all expired.
            self._attempts = {k: q for k, q in self._attempts.items() if q and q[-1] > cutoff}
        attempts = self._attempts.setdefault(key, deque())
        while attempts and attempts[0] <= cutoff:
            attempts.popleft()
        if len(attempts) >= self._limit:
            return False
        attempts.append(now)
        return True

    def retry_after(self, key: str) -> int:
        attempts = self._attempts.get(key)
        if not attempts:
            return 0
        return max(1, int(attempts[0] + self._window - self._now()) + 1)


def _rate_key(address: str) -> str | None:
    try:
        ip = ipaddress.ip_address(address.strip())
    except ValueError:
        return None
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.ipv4_mapped is not None:
            return str(ip.ipv4_mapped)
        # One subscriber usually holds a whole /64.
        return str(ipaddress.ip_network(f"{ip}/64", strict=False).network_address) + "/64"
    return str(ip)


def client_address(conn: HTTPConnection) -> str:
    """The key a per-client limit counts by.

    The RIGHTMOST X-Forwarded-For entry is the one our own reverse proxy
    appended; everything left of it is whatever the client typed. The header
    may be repeated, so all its lines are joined first. Without the header
    (no proxy in front) it is the socket peer.
    """
    forwarded = ", ".join(conn.headers.getlist("x-forwarded-for"))
    if forwarded:
        key = _rate_key(forwarded.rsplit(",", 1)[-1])
        if key is not None:
            return key
    peer = conn.client.host if conn.client else ""
    return _rate_key(peer) or peer or "unknown"
