"""Moving to a new address, where sessions are, the owner's recovery code (CONTRACT-V11-ADDRESS).

Nothing here makes a request cross from one origin to the other: the old
page asks its own origin for a move code (``POST /api/move``), the new page
redeems it on ITS origin (``POST /api/join``/``/api/move/peek``/``adopt``),
and the server joins the two halves through the code. No CORS header exists.
"""

import hashlib
import hmac
import json
import logging
import secrets
from collections.abc import Awaitable, Callable
from typing import Annotated, Any

import httpx
from fastapi import Depends, FastAPI, Request
from fastapi.responses import JSONResponse

from trio_server import linkcodes
from trio_server.config import Settings
from trio_server.db import Database, _user, hash_token, utc_iso
from trio_server.downloads import page_origin
from trio_server.errors import ApiError, error_response
from trio_server.ops_schema import ensure_ops_schema, get_meta, set_meta_locked
from trio_server.owner import resolve_owner_id
from trio_server.ratelimit import JoinGuard, client_address

logger = logging.getLogger("trio")

MOVE_TTL_SECONDS = 10 * 60
MOVE_BODY_MAX_BYTES = 160 * 1024
PREF_VALUE_MAX = 32 * 1024
PREFS_TOTAL_MAX = 64 * 1024
RECOVERY_MAX_PER_BOOT = 3
RECOVERY_USED_KEY = "recovery_used_at"
REACHABLE_CACHE_SECONDS = 60
REACHABLE_TIMEOUT_SECONDS = 5
OTHER_ORIGINS_SHOWN = 5

# §3: the localStorage keys a move carries, in priority order (the total cap
# drops from the end). trio.invite is checked against the invite code.
MOVE_PREF_KEYS = (
    "trio.settings",
    "trio.voice6",
    "trio.music8",
    "trio.channel",
    "trio.lastName",
    "trio.seenVersion",
    "trio.invite",
    "trio.v7.stageCollapsed",
    "trio.v10.membersHidden",
    "trio.v10.showChannel",
    "trio.sendOriginal",
    "trio.gameShare",
    "trio.recentEmoji",
    "trio.desktopUpdateDismissed",
    "trio.desktopUpdateLater",
    "trio.desktopUpdateHint",
    "trio.lastRead",
    "trio.drafts",
)


def hash_move_code(code: str) -> str:
    return hashlib.sha256(("trio-move:" + code).encode("ascii")).hexdigest()


def same_origin(a: str | None, b: str | None) -> bool:
    return a is not None and b is not None and a.lower() == b.lower()


def clean_prefs(raw: Any, invite_code: str) -> dict[str, str]:
    """The allowlisted string values, each and all together within their caps."""
    if not isinstance(raw, dict):
        return {}
    kept: dict[str, str] = {}
    total = 0
    for key in MOVE_PREF_KEYS:
        value = raw.get(key)
        if not isinstance(value, str) or len(value.encode("utf-8")) > PREF_VALUE_MAX:
            continue
        if key == "trio.invite" and not hmac.compare_digest(
            hashlib.sha256(value.encode("utf-8")).digest(),
            hashlib.sha256(invite_code.encode("utf-8")).digest(),
        ):
            continue
        size = len(key) + len(value.encode("utf-8"))
        if total + size > PREFS_TOTAL_MAX:
            continue
        kept[key] = value
        total += size
    return kept


class SessionOrigins:
    """§4: the origin each session was last seen through, written only on change."""

    def __init__(self, db: Database) -> None:
        self.db = db
        self.seen: dict[str, str] = {}

    async def note(self, token_hash: str, origin: str | None) -> None:
        if origin is None or self.seen.get(token_hash) == origin:
            return
        if len(self.seen) > 10_000:
            self.seen.clear()
        self.seen[token_hash] = origin
        async with self.db.write_lock:
            await self.db.conn.execute(
                "UPDATE tokens SET last_origin = ? WHERE token_hash = ? "
                "AND (last_origin IS NULL OR last_origin != ?)",
                (origin, token_hash, origin),
            )
            await self.db.conn.commit()

    def forget(self, token_hash: str) -> None:
        self.seen.pop(token_hash, None)


def register_address_routes(
    app: FastAPI,
    *,
    db: Database,
    hub: Any,
    settings: Settings,
    now: Callable[[], float],
    current_user: Callable[..., Awaitable[dict[str, Any]]],
    read_json: Callable[..., Awaitable[dict[str, Any]]],
    join_guard: JoinGuard,
    delete_push_for_token: Callable[[str], Awaitable[None]],
    http_transport: httpx.AsyncBaseTransport | None,
) -> None:
    public_url = settings.public_url
    state: dict[str, Any] = {"recovery_uses": 0, "reachable": None, "reachable_ts": None}
    origins = SessionOrigins(db)
    app.state.session_origins = origins

    User = Annotated[dict[str, Any], Depends(current_user)]

    async def boot() -> None:
        """A restart without the variable forgets that it was used (§6)."""
        if settings.recovery_code is None:
            try:
                if await get_meta(db, RECOVERY_USED_KEY) is not None:
                    await ensure_ops_schema(db)
                    async with db.write_lock:
                        await db.conn.execute(
                            "DELETE FROM meta WHERE key = ?", (RECOVERY_USED_KEY,)
                        )
                        await db.conn.commit()
            except Exception:  # noqa: BLE001 - a full disk must not stop the start
                logger.exception("recovery.boot.failed")

    app.state.address_boot = boot

    def admit(request: Request) -> tuple[str, JSONResponse | None]:
        address = client_address(request, settings.trusted_proxy_hops)
        retry_after = join_guard.admit(address)
        if retry_after is None:
            return address, None
        return address, error_response(
            429,
            "RATE_LIMITED",
            "too many attempts, try again later",
            headers={"Retry-After": str(retry_after)},
        )

    def require_canonical(request: Request) -> None:
        if public_url is None or not same_origin(page_origin(request), public_url):
            raise ApiError(409, "NOT_CANONICAL", "use the server's canonical address")

    async def find_move(code_hash: str) -> dict[str, Any] | None:
        """A live move code whose session and user still exist."""
        async with db.conn.execute(
            "SELECT m.user_id, m.from_token_hash, m.prefs, m.expires_ts, u.name, u.avatar "
            "FROM move_codes m JOIN users u ON u.id = m.user_id "
            "JOIN tokens t ON t.token_hash = m.from_token_hash "
            "WHERE m.code_hash = ? AND m.expires_ts > ? AND u.removed_at IS NULL",
            (code_hash, now()),
        ) as cur:
            row = await cur.fetchone()
        if row is None:
            return None
        return {
            "user": {"id": row["user_id"], "name": row["name"], "avatar": row["avatar"]},
            "from": row["from_token_hash"],
            "prefs": json.loads(row["prefs"]),
            "expires": row["expires_ts"],
        }

    async def take_move(code_hash: str) -> dict[str, Any] | None:
        """find_move, then the code is deleted (single use). Caller holds write_lock."""
        found = await find_move(code_hash)
        await db.conn.execute("DELETE FROM move_codes WHERE code_hash = ?", (code_hash,))
        await db.conn.commit()
        return found

    async def end_session(token_hash: str) -> int:
        """Caller holds write_lock."""
        cur = await db.conn.execute("DELETE FROM tokens WHERE token_hash = ?", (token_hash,))
        await db.conn.execute("DELETE FROM move_codes WHERE from_token_hash = ?", (token_hash,))
        await db.conn.commit()
        await delete_push_for_token(token_hash)
        origins.forget(token_hash)
        return cur.rowcount

    def public_user(user: dict[str, Any]) -> dict[str, Any]:
        return _user(user["id"], user["name"], user.get("avatar"))

    # -- the old origin ------------------------------------------------------

    @app.post("/api/move", status_code=201)
    async def create_move(request: Request, user: User) -> Any:
        if public_url is None:
            raise ApiError(409, "NO_PUBLIC_URL", "this server has no canonical address")
        here = page_origin(request)
        sent_origin = request.headers.get("origin")
        if sent_origin is not None and not same_origin(sent_origin, here):
            raise ApiError(403, "FORBIDDEN", "cross-origin request")
        if same_origin(here, public_url):
            raise ApiError(409, "ALREADY_HERE", "this is the canonical address already")
        body = await read_json(request, MOVE_BODY_MAX_BYTES)
        raw = body.get("prefs", {})
        if not isinstance(raw, dict):
            raise ApiError(422, "INVALID_PREFS", "prefs must be an object")
        prefs = clean_prefs(raw, settings.invite_code)
        token_hash = request.state.token_hash
        code = linkcodes.new_code()
        clock = now()
        async with db.write_lock:
            await db.conn.execute("DELETE FROM move_codes WHERE expires_ts <= ?", (clock,))
            await db.conn.execute("DELETE FROM move_codes WHERE from_token_hash = ?", (token_hash,))
            await db.conn.execute(
                "INSERT INTO move_codes (code_hash, user_id, from_token_hash, prefs, "
                "created_ts, expires_ts) VALUES (?, ?, ?, ?, ?, ?)",
                (
                    hash_move_code(code),
                    user["id"],
                    token_hash,
                    json.dumps(prefs),
                    clock,
                    clock + MOVE_TTL_SECONDS,
                ),
            )
            await db.conn.commit()
        logger.info("move.code user=%s prefs=%s", user["id"], len(prefs))
        return {
            "code": code,
            "expires_at": utc_iso(clock + MOVE_TTL_SECONDS),
            "public_url": public_url,
            "url": f"{public_url}/#tasi={code}",
        }

    # -- the canonical origin --------------------------------------------------

    @app.post("/api/move/peek")
    async def peek(request: Request) -> Any:
        address, refused = admit(request)
        if refused is not None:
            return refused
        require_canonical(request)
        body = await read_json(request)
        code = linkcodes.normalize(body.get("code"))
        found = None if code is None else await find_move(hash_move_code(code))
        if found is None:
            join_guard.failed(address)
            raise ApiError(403, "INVALID_MOVE_CODE", "invalid or expired move code")
        return {"user": public_user(found["user"]), "expires_at": utc_iso(found["expires"])}

    async def redeem_via_join(raw: Any, request: Request, address: str) -> JSONResponse | None:
        """Called by /api/join when a link_code is not a link code: maybe a move code."""
        code = linkcodes.normalize(raw)
        if code is None:
            return None
        code_hash = hash_move_code(code)
        if await find_move(code_hash) is None:
            return None
        require_canonical(request)
        token = secrets.token_urlsafe(32)
        async with db.write_lock:
            found = await take_move(code_hash)
            if found is None:
                return None
            await db.conn.execute(
                "INSERT INTO tokens (token_hash, user_id, created_at, last_origin, via_move, "
                "moved_from) VALUES (?, ?, ?, ?, 1, ?)",
                (hash_token(token), found["user"]["id"], utc_iso(now()), public_url, found["from"]),
            )
            await db.conn.commit()
        join_guard.succeeded(address)
        logger.info("move.redeemed user=%s", found["user"]["id"])
        return JSONResponse(
            {"token": token, "user": public_user(found["user"]), "move": {"prefs": found["prefs"]}},
            status_code=200,
        )

    app.state.redeem_move_via_join = redeem_via_join

    @app.post("/api/move/adopt")
    async def adopt(request: Request, user: User) -> Any:
        address, refused = admit(request)
        if refused is not None:
            return refused
        require_canonical(request)
        body = await read_json(request)
        code = linkcodes.normalize(body.get("code"))
        async with db.write_lock:
            found = None if code is None else await take_move(hash_move_code(code))
            if found is None:
                join_guard.failed(address)
                raise ApiError(403, "INVALID_MOVE_CODE", "invalid or expired move code")
            if found["user"]["id"] != user["id"]:
                raise ApiError(409, "OTHER_ACCOUNT", "that code belongs to another account")
            ended = await end_session(found["from"])
        hub.kick_token(found["from"])
        join_guard.succeeded(address)
        logger.info("move.adopted user=%s", user["id"])
        return {"user": public_user(found["user"]), "prefs": found["prefs"], "ended": ended}

    @app.post("/api/move/confirm")
    async def confirm(request: Request, user: User) -> Any:
        token_hash = request.state.token_hash
        async with db.write_lock:
            async with db.conn.execute(
                "SELECT moved_from FROM tokens WHERE token_hash = ?", (token_hash,)
            ) as cur:
                row = await cur.fetchone()
            old = row["moved_from"] if row is not None else None
            ended = 0
            if old:
                await db.conn.execute(
                    "UPDATE tokens SET moved_from = NULL WHERE token_hash = ?", (token_hash,)
                )
                ended = await end_session(old)
        if old:
            hub.kick_token(old)
            logger.info("move.confirmed user=%s ended=%s", user["id"], ended)
        return {"ended": ended}

    # -- recovery (§6) ----------------------------------------------------------

    async def recover(raw: Any, address: str) -> JSONResponse:
        configured = settings.recovery_code
        supplied = raw.encode("utf-8") if isinstance(raw, str) else b""
        if configured is not None and state["recovery_uses"] >= RECOVERY_MAX_PER_BOOT:
            raise ApiError(429, "RECOVERY_LIMIT", "the recovery code was used too often")
        expected = (configured or secrets.token_urlsafe(32)).encode("utf-8")
        right = hmac.compare_digest(
            hashlib.sha256(supplied).digest(), hashlib.sha256(expected).digest()
        )
        if configured is None or not right:
            join_guard.failed(address)
            raise ApiError(403, "INVALID_RECOVERY_CODE", "invalid recovery code")
        owner_id = await resolve_owner_id(db, settings)
        if owner_id is None:
            raise ApiError(409, "NO_OWNER", "this server has no owner")
        token = secrets.token_urlsafe(32)
        stamp = utc_iso(now())
        await ensure_ops_schema(db)
        async with db.write_lock:
            await db.conn.execute(
                "INSERT INTO tokens (token_hash, user_id, created_at) VALUES (?, ?, ?)",
                (hash_token(token), owner_id, stamp),
            )
            await db.conn.commit()
            await set_meta_locked(db, RECOVERY_USED_KEY, stamp)
        state["recovery_uses"] += 1
        join_guard.succeeded(address)
        user = await db.user_for_token_hash(hash_token(token))
        logger.warning(
            "recovery.used owner=%s use=%s/%s - remove TRIO_RECOVERY_CODE when done",
            owner_id,
            state["recovery_uses"],
            RECOVERY_MAX_PER_BOOT,
        )
        return JSONResponse({"token": token, "user": user, "recovery": True}, status_code=200)

    app.state.recover = recover

    # -- the owner's view (§4) ------------------------------------------------------

    async def reachable() -> dict[str, Any] | None:
        if public_url is None:
            return None
        clock = now()
        cached = state["reachable"]
        if cached is not None and clock - state["reachable_ts"] < REACHABLE_CACHE_SECONDS:
            return cached
        result: dict[str, Any] = {"ok": False, "same_server": False, "at": utc_iso(clock)}
        try:
            async with httpx.AsyncClient(
                transport=http_transport, timeout=REACHABLE_TIMEOUT_SECONDS
            ) as client:
                response = await client.get(
                    f"{public_url}/api/health", headers={"User-Agent": "trio-server"}
                )
            body = response.json() if response.status_code == 200 else None
            result["ok"] = isinstance(body, dict) and body.get("ok") is True
            ours = app.state.boot.get("data_since")
            result["same_server"] = bool(
                result["ok"] and ours is not None and body.get("data_since") == ours
            )
            result["detail"] = f"HTTP {response.status_code}"
        except Exception as exc:  # noqa: BLE001 - an unreachable address is a fact to show
            result["detail"] = type(exc).__name__
        state["reachable"], state["reachable_ts"] = result, clock
        return result

    async def owner_user(user: User) -> dict[str, Any]:
        if await resolve_owner_id(db, settings) != user["id"]:
            raise ApiError(403, "FORBIDDEN", "only the server's owner may do that")
        return user

    Owner = Annotated[dict[str, Any], Depends(owner_user)]

    @app.get("/api/owner/address")
    async def owner_address(request: Request, user: Owner) -> Any:
        async with db.conn.execute(
            "SELECT t.last_origin, t.via_move FROM tokens t JOIN users u ON u.id = t.user_id "
            "WHERE u.removed_at IS NULL"
        ) as cur:
            rows = await cur.fetchall()
        counts = {"total": len(rows), "canonical": 0, "other": 0, "unknown": 0, "moved": 0}
        others: dict[str, int] = {}
        for row in rows:
            origin = row["last_origin"]
            if row["via_move"]:
                counts["moved"] += 1
            if origin is None:
                counts["unknown"] += 1
            elif public_url is not None and same_origin(origin, public_url):
                counts["canonical"] += 1
            else:
                counts["other"] += 1
                others[origin] = others.get(origin, 0) + 1
        shown = sorted(others.items(), key=lambda item: (-item[1], item[0]))[:OTHER_ORIGINS_SHOWN]
        reach = await reachable()
        used_at = await get_meta(db, RECOVERY_USED_KEY) if settings.recovery_code else None
        return {
            "public_url": public_url,
            "request_origin": page_origin(request),
            "reachable": reach,
            "sessions": counts,
            "other_origins": [{"origin": o, "sessions": n} for o, n in shown],
            "recovery": {
                "configured": settings.recovery_code is not None,
                "used_at": used_at,
                "uses_this_boot": state["recovery_uses"],
                "max_per_boot": RECOVERY_MAX_PER_BOOT,
            },
            "safe_to_retire": bool(
                public_url is not None
                and reach is not None
                and reach["same_server"]
                and counts["other"] == 0
            ),
        }
