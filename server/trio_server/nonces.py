"""`message.send` de-duplication by nonce (CONTRACT-V3 §10).

A client that loses the acknowledgement of a send (the socket dropped after
the server stored the message but before ``message.new`` reached it) sends
the same frame again with the same nonce. Without this the message would be
stored twice. The hub is one process by design, so the memory is in-process:
a restart forgets it, which costs at most one duplicate per send that was in
flight at the moment of the restart.

Memory is bounded twice: an entry lives ``TTL_SECONDS``, and each user keeps
at most ``PER_USER_MAX`` (the oldest go first). Entries of one user are kept
in insertion order, which is also expiry order, so pruning is O(1) amortised.
"""

from __future__ import annotations

from collections import OrderedDict

# (channel id, message id) of the stored message.
Ref = tuple[int, int]

TTL_SECONDS = 10 * 60
PER_USER_MAX = 500


class NonceCache:
    def __init__(self, ttl: float = TTL_SECONDS, per_user: int = PER_USER_MAX) -> None:
        self.ttl = ttl
        self.per_user = per_user
        # user id -> nonce -> (stored at, (channel id, message id)). Only the
        # reference is kept: a retry re-reads the message (CONTRACT-V4 B).
        self._by_user: dict[int, OrderedDict[str, tuple[float, Ref]]] = {}

    def _prune(self, user_id: int, now: float) -> OrderedDict[str, tuple[float, Ref]] | None:
        entries = self._by_user.get(user_id)
        if entries is None:
            return None
        while entries:
            nonce, (stored_at, _) = next(iter(entries.items()))
            if now - stored_at < self.ttl:
                break
            del entries[nonce]
        if not entries:
            del self._by_user[user_id]
            return None
        return entries

    def get(self, user_id: int, nonce: str, now: float) -> Ref | None:
        """Which message an earlier send with this nonce stored, if still remembered."""
        entries = self._prune(user_id, now)
        if entries is None:
            return None
        found = entries.get(nonce)
        return found[1] if found is not None else None

    def put(self, user_id: int, nonce: str, message: Ref, now: float) -> None:
        entries = self._prune(user_id, now)
        if entries is None:
            entries = self._by_user.setdefault(user_id, OrderedDict())
        entries.pop(nonce, None)
        entries[nonce] = (now, message)
        while len(entries) > self.per_user:
            entries.popitem(last=False)

    def __len__(self) -> int:
        return sum(len(entries) for entries in self._by_user.values())
