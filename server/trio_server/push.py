"""Web Push: VAPID keys, subscriptions, the send queue, the REST routes.

CONTRACT-V6-PUSH has the wire. Three rules shape this module:

- **Off the request path.** The hub's hooks (``notify.Notifier``) only put a
  job on a bounded in-process queue (``put_nowait``; a full queue drops and
  logs). Worker tasks read the subscriptions, encrypt and POST. A slow or
  failing push service can never delay chat.
- **The endpoint is a URL the CLIENT chose and the SERVER will POST to.** Only
  https on port 443 to the known push services (``ALLOWED_PUSH_HOSTS``) is
  accepted, at subscribe time and again at send time; the host is resolved,
  every address must be public, and the request goes to the address that was
  checked (Host and TLS SNI keep the name), so a second DNS answer cannot
  point it somewhere else. Redirects are never followed.
- **A subscription belongs to the token that made it.** Signing that token
  out (or revoking it) ends the device's pushes too: sends join on ``tokens``.
"""

# No ``from __future__ import annotations``: FastAPI must see the dependency
# type (``User``) as an object (see message_routes.py).
import asyncio
import contextlib
import ipaddress
import json
import logging
import random
import socket
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Annotated, Any
from urllib.parse import urlsplit

import httpx
from fastapi import Depends, FastAPI, Request
from fastapi import Path as PathParam
from fastapi.responses import Response

from trio_server.db import SQL_INT_MAX, Database, utc_now
from trio_server.errors import ApiError
from trio_server.notify import Notifier, PrefsError, default_prefs, merge_prefs
from trio_server.push_crypto import (
    MAX_PLAINTEXT,
    JwtCache,
    PushCryptoError,
    VapidKey,
    b64url_decode,
    check_subscription_keys,
    encrypt,
)
from trio_server.ratelimit import SlidingWindow

logger = logging.getLogger("trio.push")

SCHEMA = """
CREATE TABLE IF NOT EXISTS push_vapid (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    private_pem TEXT NOT NULL,
    public_key  TEXT NOT NULL,
    created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL,        -- the session that subscribed (see module doc)
    endpoint    TEXT NOT NULL UNIQUE,
    p256dh      TEXT NOT NULL,
    auth        TEXT NOT NULL,
    ua_family   TEXT NOT NULL,
    label       TEXT NOT NULL,
    origin      TEXT,                 -- the app's origin when subscribing (VAPID sub)
    created_at  TEXT NOT NULL,
    last_ok_at  TEXT,
    last_error  TEXT
);
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions (user_id);
CREATE TABLE IF NOT EXISTS push_prefs (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    data    TEXT NOT NULL
);
"""

# Hosts a subscription endpoint may name: exact names, and suffixes starting with ".".
ALLOWED_PUSH_HOSTS: tuple[str, ...] = (
    "fcm.googleapis.com",  # Chrome, Edge on Android, Samsung Internet, Opera
    "updates.push.services.mozilla.com",  # Firefox
    ".notify.windows.com",  # Edge on Windows (wns2-*.notify.windows.com)
    ".push.apple.com",  # Safari, iOS home-screen apps (web.push.apple.com)
)
MAX_SUBSCRIPTIONS_PER_USER = 10
ENDPOINT_MAX = 2048
LABEL_MAX = 40
UA_FAMILIES = ("chrome", "edge", "firefox", "safari", "samsung", "opera", "electron", "other")
QUEUE_SIZE = 500
WORKERS = 4
SEND_TIMEOUT_SECONDS = 10.0
MAX_ATTEMPTS = 4
RETRY_DELAYS = (2.0, 10.0, 60.0)
RETRY_AFTER_CAP = 300.0
TEST_LIMIT = 5
TEST_WINDOW_SECONDS = 60.0
DEFAULT_SUBJECT = "mailto:trio-push@users.noreply.github.com"

Resolver = Callable[[str, int], Awaitable[list[str]]]


class EndpointError(ValueError):
    pass


class PrivateAddressError(EndpointError):
    """An allowed name that resolved to a non-public address (not "gone": DNS can recover)."""


async def system_resolver(host: str, port: int) -> list[str]:
    loop = asyncio.get_running_loop()
    infos = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    return [str(info[4][0]) for info in infos]


def host_allowed(host: str) -> bool:
    host = host.lower().rstrip(".")
    for allowed in ALLOWED_PUSH_HOSTS:
        if allowed.startswith("."):
            if host.endswith(allowed) and len(host) > len(allowed):
                return True
        elif host == allowed:
            return True
    return False


def public_address(address: str) -> bool:
    try:
        ip = ipaddress.ip_address(address.split("%", 1)[0])
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return ip.is_global and not ip.is_multicast


@dataclass(frozen=True)
class Target:
    """Where a send goes: the URL to request, and the Host/SNI name to keep."""

    url: str
    host: str
    audience: str  # VAPID aud: the endpoint's origin


def check_endpoint_shape(endpoint: Any, test_service: str | None = None) -> None:
    """Syntax only (no DNS): what PUT /api/push/subscriptions accepts."""
    if not isinstance(endpoint, str) or not 1 <= len(endpoint) <= ENDPOINT_MAX:
        raise EndpointError("endpoint must be a URL")
    if test_service is not None and endpoint.startswith(test_service.rstrip("/") + "/"):
        return
    try:
        parts = urlsplit(endpoint)
        port = parts.port
    except ValueError as exc:
        raise EndpointError("endpoint must be a URL") from exc
    if parts.scheme != "https" or not parts.hostname:
        raise EndpointError("endpoint must be https")
    if parts.username is not None or parts.password is not None or "@" in parts.netloc:
        raise EndpointError("endpoint must not carry credentials")
    if port not in (None, 443):
        raise EndpointError("endpoint must use port 443")
    if any(c in endpoint for c in "\r\n\t \\"):
        raise EndpointError("endpoint must be a URL")
    if not host_allowed(parts.hostname):
        raise EndpointError("endpoint is not a known push service")


async def resolve_target(endpoint: str, resolver: Resolver, test_service: str | None) -> Target:
    """The checked address to POST to (see the module docstring)."""
    check_endpoint_shape(endpoint, test_service)
    parts = urlsplit(endpoint)
    if test_service is not None and endpoint.startswith(test_service.rstrip("/") + "/"):
        origin = test_service.rstrip("/")
        return Target(url=endpoint, host=parts.netloc, audience=origin)
    host = parts.hostname or ""
    addresses = await resolver(host, 443)
    if not addresses or not all(public_address(a) for a in addresses):
        raise PrivateAddressError("endpoint resolves to a non-public address")
    address = addresses[0].split("%", 1)[0]
    netloc = f"[{address}]" if ":" in address else address
    path = parts.path or "/"
    if parts.query:
        path += "?" + parts.query
    return Target(url=f"https://{netloc}{path}", host=host, audience=f"https://{host}")


def ua_family(value: Any) -> str:
    return value if value in UA_FAMILIES else "other"


def clean_label(value: Any) -> str:
    if not isinstance(value, str):
        return "Cihaz"
    text = " ".join(value.split())[:LABEL_MAX]
    text = "".join(ch for ch in text if ch.isprintable())
    return text or "Cihaz"


# -- storage ----------------------------------------------------------------------


class PushStore:
    """The push tables, on the app's one connection (``db.write_lock`` for writes)."""

    def __init__(self, db: Database) -> None:
        self.db = db

    async def ensure(self) -> VapidKey:
        """Create the tables (an existing database gains them) and the key, once."""
        await self.db.conn.executescript(SCHEMA)
        await self.db.conn.commit()
        async with self.db.write_lock:
            rows = await self.db._all("SELECT private_pem FROM push_vapid WHERE id = 1")
            if rows:
                return VapidKey.from_pem(rows[0]["private_pem"])
            key = VapidKey.generate()
            await self.db.conn.execute(
                "INSERT INTO push_vapid (id, private_pem, public_key, created_at) "
                "VALUES (1, ?, ?, ?)",
                (key.pem(), key.public_b64, utc_now()),
            )
            await self.db.conn.commit()
            logger.info("push.vapid.created")
            return key

    async def all_prefs(self) -> dict[int, dict[str, Any]]:
        rows = await self.db._all("SELECT user_id, data FROM push_prefs")
        out = {}
        for row in rows:
            prefs = default_prefs()
            with contextlib.suppress(ValueError, TypeError):
                stored = json.loads(row["data"])
                if isinstance(stored, dict):
                    prefs.update({k: v for k, v in stored.items() if k in prefs})
            out[row["user_id"]] = prefs
        return out

    async def save_prefs(self, user_id: int, prefs: dict[str, Any]) -> None:
        await self.db.conn.execute(
            "INSERT INTO push_prefs (user_id, data) VALUES (?, ?) "
            "ON CONFLICT (user_id) DO UPDATE SET data = excluded.data",
            (user_id, json.dumps(prefs, separators=(",", ":"))),
        )
        await self.db.conn.commit()

    @staticmethod
    def _public(row: Any) -> dict[str, Any]:
        return {
            "id": row["id"],
            "label": row["label"],
            "ua_family": row["ua_family"],
            "created_at": row["created_at"],
            "last_ok_at": row["last_ok_at"],
            "last_error": row["last_error"],
        }

    async def list_for(self, user_id: int) -> list[dict[str, Any]]:
        rows = await self.db._all(
            "SELECT * FROM push_subscriptions WHERE user_id = ? ORDER BY id", (user_id,)
        )
        return [self._public(r) for r in rows]

    async def upsert(
        self,
        user_id: int,
        token_hash: str,
        endpoint: str,
        p256dh: str,
        auth: str,
        family: str,
        label: str,
        origin: str | None,
    ) -> dict[str, Any] | None:
        """The stored subscription, or None when the user already has the maximum."""
        existing = await self.db._all(
            "SELECT id, user_id FROM push_subscriptions WHERE endpoint = ?", (endpoint,)
        )
        if existing and existing[0]["user_id"] == user_id:
            await self.db.conn.execute(
                "UPDATE push_subscriptions SET token_hash = ?, p256dh = ?, auth = ?, "
                "ua_family = ?, label = ?, origin = ?, last_error = NULL WHERE id = ?",
                (token_hash, p256dh, auth, family, label, origin, existing[0]["id"]),
            )
            sub_id = existing[0]["id"]
        else:
            (count,) = await self.db._all(
                "SELECT count(*) AS n FROM push_subscriptions WHERE user_id = ?", (user_id,)
            )
            if count["n"] >= MAX_SUBSCRIPTIONS_PER_USER:
                return None
            if existing:
                # The same browser, now signed in as somebody else: it moves.
                await self.db.conn.execute(
                    "DELETE FROM push_subscriptions WHERE id = ?", (existing[0]["id"],)
                )
            cur = await self.db.conn.execute(
                "INSERT INTO push_subscriptions (user_id, token_hash, endpoint, p256dh, auth, "
                "ua_family, label, origin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (user_id, token_hash, endpoint, p256dh, auth, family, label, origin, utc_now()),
            )
            sub_id = cur.lastrowid
        await self.db.conn.commit()
        rows = await self.db._all("SELECT * FROM push_subscriptions WHERE id = ?", (sub_id,))
        return self._public(rows[0])

    async def delete(self, user_id: int, sub_id: int) -> bool:
        cur = await self.db.conn.execute(
            "DELETE FROM push_subscriptions WHERE id = ? AND user_id = ?", (sub_id, user_id)
        )
        await self.db.conn.commit()
        return cur.rowcount > 0

    async def delete_by_id(self, sub_id: int) -> None:
        await self.db.conn.execute("DELETE FROM push_subscriptions WHERE id = ?", (sub_id,))
        await self.db.conn.commit()

    async def delete_for_token(self, token_hash: str) -> None:
        await self.db.conn.execute(
            "DELETE FROM push_subscriptions WHERE token_hash = ?", (token_hash,)
        )
        await self.db.conn.commit()

    async def live_for_users(self, user_ids: list[int]) -> list[dict[str, Any]]:
        """Subscriptions whose token still signs in (a revoked session's are skipped)."""
        if not user_ids:
            return []
        marks = ",".join("?" * len(user_ids))
        rows = await self.db._all(
            "SELECT s.* FROM push_subscriptions s JOIN tokens t ON t.token_hash = s.token_hash "  # noqa: S608 - only '?' marks
            f"WHERE s.user_id IN ({marks}) ORDER BY s.id",
            tuple(user_ids),
        )
        return [dict(r) for r in rows]

    async def get(self, user_id: int, sub_id: int) -> dict[str, Any] | None:
        rows = await self.db._all(
            "SELECT s.* FROM push_subscriptions s JOIN tokens t ON t.token_hash = s.token_hash "
            "WHERE s.id = ? AND s.user_id = ?",
            (sub_id, user_id),
        )
        return dict(rows[0]) if rows else None

    async def mark(self, sub_id: int, ok: bool, error: str | None = None) -> None:
        if ok:
            await self.db.conn.execute(
                "UPDATE push_subscriptions SET last_ok_at = ?, last_error = NULL WHERE id = ?",
                (utc_now(), sub_id),
            )
        else:
            await self.db.conn.execute(
                "UPDATE push_subscriptions SET last_error = ? WHERE id = ?",
                ((error or "error")[:120], sub_id),
            )
        await self.db.conn.commit()


# -- sending ----------------------------------------------------------------------


@dataclass
class Outcome:
    ok: bool
    status: int | None = None
    error: str | None = None
    retry_after: float | None = None
    gone: bool = False
    # Not worth retrying (a refused address, a payload or key problem).
    final: bool = False


@dataclass
class Delivery:
    sub: dict[str, Any]
    payload: dict[str, Any]
    ttl: int
    urgency: str
    attempt: int = 1


@dataclass
class Fanout:
    user_ids: list[int]
    payload: dict[str, Any]
    ttl: int
    urgency: str


def _retry_after(response: httpx.Response) -> float | None:
    raw = response.headers.get("retry-after", "").strip()
    if raw.isdigit():
        return min(float(raw), RETRY_AFTER_CAP)
    return None


class PushSender:
    def __init__(
        self,
        store: PushStore,
        *,
        now: Callable[[], float],
        transport: httpx.AsyncBaseTransport | None,
        resolver: Resolver = system_resolver,
        subject: str | None = None,
        test_service: str | None = None,
    ) -> None:
        self.store = store
        self.now = now
        self.transport = transport
        self.resolver = resolver
        self.subject = subject
        self.test_service = test_service
        self.queue: asyncio.Queue[Fanout | Delivery] = asyncio.Queue(QUEUE_SIZE)
        self.jwt: JwtCache | None = None
        self.key: VapidKey | None = None
        self._client: httpx.AsyncClient | None = None
        self._tasks: list[asyncio.Task[None]] = []
        self._timers: set[asyncio.TimerHandle] = set()
        self.dropped = 0
        self.retry_delays: tuple[float, ...] = RETRY_DELAYS
        # Each finished delivery: (subscription id, Outcome). Tests and logs read it.
        self.on_outcome: Callable[[int, Outcome], None] | None = None

    async def start(self, key: VapidKey) -> None:
        self.key = key
        self.jwt = JwtCache(key, self.now)
        self._client = httpx.AsyncClient(
            transport=self.transport,
            follow_redirects=False,
            timeout=SEND_TIMEOUT_SECONDS,
            trust_env=False,
        )
        self._tasks = [asyncio.create_task(self._worker()) for _ in range(WORKERS)]

    async def stop(self) -> None:
        for timer in self._timers:
            timer.cancel()
        self._timers.clear()
        for task in self._tasks:
            task.cancel()
        for task in self._tasks:
            with contextlib.suppress(asyncio.CancelledError):
                await task
        self._tasks = []
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    # -- the queue --------------------------------------------------------------

    def enqueue(self, user_ids: list[int], payload: dict[str, Any], opts: dict[str, Any]) -> None:
        """Called from the hub's hooks (synchronously): never blocks."""
        self._put(Fanout(list(user_ids), payload, int(opts["ttl"]), str(opts["urgency"])))

    def _put(self, item: Fanout | Delivery) -> None:
        try:
            self.queue.put_nowait(item)
        except asyncio.QueueFull:
            self.dropped += 1
            logger.warning("push.queue.full dropped=%s", self.dropped)

    async def _worker(self) -> None:
        while True:
            item = await self.queue.get()
            try:
                if isinstance(item, Fanout):
                    subs = await self.store.live_for_users(item.user_ids)
                    for sub in subs:
                        self._put(Delivery(sub, item.payload, item.ttl, item.urgency))
                else:
                    await self._deliver_and_follow_up(item)
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - one bad job must not stop the worker
                logger.exception("push.worker.failed")
            finally:
                self.queue.task_done()

    async def _deliver_and_follow_up(self, item: Delivery) -> None:
        outcome = await self.deliver(item.sub, item.payload, ttl=item.ttl, urgency=item.urgency)
        sub_id = item.sub["id"]
        async with self.store.db.write_lock:
            if outcome.ok:
                await self.store.mark(sub_id, True)
            elif outcome.gone:
                await self.store.delete_by_id(sub_id)
            else:
                await self.store.mark(sub_id, False, outcome.error)
        if outcome.gone:
            logger.info("push.subscription.gone id=%s status=%s", sub_id, outcome.status)
        elif not outcome.ok:
            retryable = not outcome.final and (
                outcome.status is None or outcome.status == 429 or outcome.status >= 500
            )
            if retryable and item.attempt < MAX_ATTEMPTS:
                delay = outcome.retry_after or self.retry_delays[item.attempt - 1]
                delay *= 1 + random.random() * 0.2  # noqa: S311 - jitter, not security
                self._later(
                    delay,
                    Delivery(item.sub, item.payload, item.ttl, item.urgency, item.attempt + 1),
                )
        if self.on_outcome is not None:
            self.on_outcome(sub_id, outcome)

    def _later(self, delay: float, item: Delivery) -> None:
        loop = asyncio.get_running_loop()
        handle: asyncio.TimerHandle

        def fire() -> None:
            self._timers.discard(handle)
            self._put(item)

        handle = loop.call_later(delay, fire)
        self._timers.add(handle)

    # -- one request --------------------------------------------------------------

    def _subject(self, sub: dict[str, Any]) -> str:
        if self.subject:
            return self.subject
        origin = sub.get("origin") or ""
        if origin.startswith("https://"):
            return origin
        return DEFAULT_SUBJECT

    async def deliver(
        self, sub: dict[str, Any], payload: dict[str, Any], *, ttl: int, urgency: str
    ) -> Outcome:
        """Encrypt and POST one message to one subscription; never raises."""
        if self._client is None or self.jwt is None:
            return Outcome(False, error="not started")
        try:
            target = await resolve_target(sub["endpoint"], self.resolver, self.test_service)
        except PrivateAddressError as exc:
            logger.warning("push.endpoint.private sub=%s", sub.get("id"))
            return Outcome(False, error=str(exc), final=True)
        except EndpointError as exc:
            return Outcome(False, error=str(exc), gone=True)
        except OSError:
            return Outcome(False, error="dns")
        data = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        if len(data) > MAX_PLAINTEXT:
            return Outcome(False, error="payload too large", final=True)
        try:
            body = encrypt(data, b64url_decode(sub["p256dh"]), b64url_decode(sub["auth"]))
        except PushCryptoError:
            return Outcome(False, error="bad subscription keys", gone=True)
        headers = {
            "Host": target.host,
            "TTL": str(ttl),
            "Urgency": urgency,
            "Content-Encoding": "aes128gcm",
            "Content-Type": "application/octet-stream",
            "Authorization": self.jwt.header(target.audience, self._subject(sub)),
        }
        extensions = {} if target.url == sub["endpoint"] else {"sni_hostname": target.host}
        try:
            response = await self._client.post(
                target.url, content=body, headers=headers, extensions=extensions
            )
        except httpx.HTTPError as exc:
            return Outcome(False, error=type(exc).__name__)
        status = response.status_code
        if 200 <= status < 300:
            return Outcome(True, status)
        if status in (404, 410):
            return Outcome(False, status, error=f"HTTP {status}", gone=True)
        return Outcome(False, status, error=f"HTTP {status}", retry_after=_retry_after(response))


# -- routes -----------------------------------------------------------------------


def register_push_routes(
    app: FastAPI,
    *,
    store: PushStore,
    sender: PushSender,
    notifier: Notifier,
    hub: Any,
    now: Callable[[], float],
    current_user: Callable[..., Awaitable[dict[str, Any]]],
    read_json: Callable[..., Awaitable[dict[str, Any]]],
    test_service: str | None,
) -> None:
    User = Annotated[dict[str, Any], Depends(current_user)]
    SubId = Annotated[int, PathParam(ge=1, le=SQL_INT_MAX)]
    tests = SlidingWindow(TEST_LIMIT, TEST_WINDOW_SECONDS, now)
    db = store.db

    @app.get("/api/push/key")
    async def push_key(user: User) -> dict[str, Any]:
        assert sender.key is not None
        return {"public_key": sender.key.public_b64}

    @app.get("/api/push/subscriptions")
    async def list_subscriptions(user: User) -> dict[str, Any]:
        return {"subscriptions": await store.list_for(user["id"])}

    @app.put("/api/push/subscriptions")
    async def put_subscription(request: Request, user: User) -> dict[str, Any]:
        body = await read_json(request)
        endpoint = body.get("endpoint")
        keys = body.get("keys")
        try:
            check_endpoint_shape(endpoint, test_service)
        except EndpointError as exc:
            raise ApiError(422, "PUSH_ENDPOINT_NOT_ALLOWED", str(exc)) from None
        if not isinstance(keys, dict):
            raise ApiError(422, "INVALID_SUBSCRIPTION", "'keys' must be {p256dh, auth}")
        p256dh, auth = keys.get("p256dh"), keys.get("auth")
        try:
            check_subscription_keys(p256dh, auth)
        except PushCryptoError as exc:
            raise ApiError(422, "INVALID_SUBSCRIPTION", str(exc)) from None
        origin = request.headers.get("origin")
        if not (isinstance(origin, str) and origin.startswith("https://") and len(origin) < 200):
            origin = None
        async with db.write_lock:
            sub = await store.upsert(
                user["id"],
                request.state.token_hash,
                endpoint,
                p256dh,
                auth,
                ua_family(body.get("ua_family")),
                clean_label(body.get("label")),
                origin,
            )
        if sub is None:
            raise ApiError(
                409,
                "TOO_MANY_SUBSCRIPTIONS",
                f"at most {MAX_SUBSCRIPTIONS_PER_USER} devices; remove one first",
            )
        return {"subscription": sub}

    @app.delete("/api/push/subscriptions/{sub_id}", status_code=204)
    async def delete_subscription(sub_id: SubId, user: User) -> Response:
        async with db.write_lock:
            removed = await store.delete(user["id"], sub_id)
        if not removed:
            raise ApiError(404, "NOT_FOUND", "no such subscription")
        return Response(status_code=204)

    @app.post("/api/push/test")
    async def push_test(request: Request, user: User) -> dict[str, Any]:
        body = await read_json(request)
        sub_id = body.get("subscription_id")
        if (
            not isinstance(sub_id, int)
            or isinstance(sub_id, bool)
            or not 1 <= sub_id <= SQL_INT_MAX
        ):
            raise ApiError(422, "INVALID_REQUEST", "'subscription_id' must be an id")
        sub = await store.get(user["id"], sub_id)
        if sub is None:
            raise ApiError(404, "NOT_FOUND", "no such subscription")
        if not tests.allow(str(user["id"])):
            raise ApiError(429, "RATE_LIMITED", "at most 5 test notifications a minute")
        payload = {
            "v": 1,
            "kind": "test",
            "title": "Trio — deneme bildirimi",
            "body": "Bu cihaza bildirimler ulaşıyor.",
            "tag": "test",
        }
        outcome = await sender.deliver(sub, payload, ttl=60, urgency="high")
        async with db.write_lock:
            if outcome.gone:
                await store.delete_by_id(sub["id"])
            else:
                await store.mark(sub["id"], outcome.ok, outcome.error)
        return {
            "ok": outcome.ok,
            "status": outcome.status,
            "error": outcome.error,
            "removed": outcome.gone,
        }

    @app.get("/api/push/prefs")
    async def get_prefs(user: User) -> dict[str, Any]:
        return {"prefs": notifier.prefs_of(user["id"])}

    @app.put("/api/push/prefs")
    async def put_prefs(request: Request, user: User) -> dict[str, Any]:
        body = await read_json(request)
        try:
            prefs = merge_prefs(notifier.prefs_of(user["id"]), body, set(hub.channels))
        except PrefsError as exc:
            raise ApiError(422, "INVALID_PREFS", str(exc)) from None
        async with db.write_lock:
            await store.save_prefs(user["id"], prefs)
            notifier.prefs[user["id"]] = prefs
        return {"prefs": prefs}
