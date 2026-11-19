"""The owner: who it is, and the REST routes only they may use (CONTRACT-V6-OPS).

The owner is ``TRIO_OWNER`` (a user name, matched like a join: case-insensitive,
Turkish I/ı aware) when set, else the active user with the lowest id. Nothing
is stored: the rule is applied every time, so removing the owner with the
admin tool passes the role on, and setting ``TRIO_OWNER`` takes it back.

The user actions (remove, revoke tokens, link code) run the admin tool's own
functions (``admin.do_*``) on a short-lived sqlite3 connection in a thread,
under ``db.write_lock``, so the CLI and the REST routes cannot drift apart.
"""

# No ``from __future__ import annotations``: see message_routes.

import asyncio
import contextlib
import hmac
import logging
import os
import platform
import shutil
import sqlite3
from collections.abc import Awaitable, Callable, Iterable
from pathlib import Path
from typing import Annotated, Any

from fastapi import Depends, FastAPI, Request
from fastapi import Path as PathParam
from fastapi.responses import JSONResponse

from trio_server import admin, persistence
from trio_server.config import Settings
from trio_server.db import SQL_INT_MAX, Database, utc_iso
from trio_server.errors import ApiError, error_response
from trio_server.hub import MAX_CONNECTIONS_PER_USER, Connection, Hub
from trio_server.ice import IceProvider
from trio_server.ops_schema import ensure_ops_schema, get_meta, set_meta_locked
from trio_server.ratelimit import JoinGuard, client_address
from trio_server.validation import clean_name, name_key
from trio_server.version import VERSION

logger = logging.getLogger("trio")

UserId = Annotated[int, PathParam(ge=1, le=SQL_INT_MAX)]
FIRST_OPEN_KEY = "first_open_at"
BOOT_COUNT_KEY = "boot_count"


def owner_id_of(users: Iterable[tuple[int, str]], configured: str | None) -> int | None:
    """The owner among ``users`` (active (id, name) pairs), or None.

    ``configured`` set: the user whose name matches it, else nobody (a typo in
    TRIO_OWNER must not silently hand the role to somebody else).
    """
    users = list(users)
    if configured:
        wanted = clean_name(configured)
        if wanted is None:
            return None
        key = name_key(wanted)
        return next((uid for uid, name in users if name_key(name) == key), None)
    return min((uid for uid, _ in users), default=None)


async def resolve_owner_id(db: Database, settings: Settings) -> int | None:
    """From the database itself (not the hub's mirror, which lags the admin tool)."""
    async with db.conn.execute(
        "SELECT id, name FROM users WHERE removed_at IS NULL ORDER BY id"
    ) as cur:
        rows = await cur.fetchall()
    return owner_id_of(((r[0], r[1]) for r in rows), settings.owner)


async def with_owner_flag(db: Database, settings: Settings, user: dict[str, Any]) -> dict[str, Any]:
    """``user`` plus ``is_owner: true`` for the owner only (the key is absent otherwise)."""
    if await resolve_owner_id(db, settings) == user["id"]:
        return {**user, "is_owner": True}
    return user


class OwnerAwareHub(Hub):
    """The hub, plus ``is_owner`` in the owner's own ``ready.user`` and a
    "last seen" per user (when their last socket closed, since this process
    started)."""

    def __init__(self, now: Callable[[], float], configured_owner: str | None) -> None:
        super().__init__(now)
        self.configured_owner = configured_owner
        self.last_seen: dict[int, float] = {}
        # CONTRACT-V6-OPS §7: decided once at startup (record_boot).
        self.persistent: bool | None = None

    def owner_id(self) -> int | None:
        return owner_id_of(
            ((u["id"], u["name"]) for u in self.users.values()), self.configured_owner
        )

    def ready_frame(self, user_id: int) -> dict[str, Any]:
        frame = super().ready_frame(user_id)
        frame["persistent"] = self.persistent
        if self.owner_id() == user_id:
            frame["user"] = {**frame["user"], "is_owner": True}
        return frame

    def disconnect(self, conn: Connection, *, grace: bool = True) -> None:
        super().disconnect(conn, grace=grace)
        if not self.conns.get(conn.user_id):
            self.last_seen[conn.user_id] = self.now()


def _open(db_path: str) -> sqlite3.Connection:
    """A plain connection for the admin functions. Never ``admin.connect``: that
    may switch the process's user, which the server must never do."""
    conn = sqlite3.connect(db_path, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def _run_admin[T](db_path: str, work: Callable[[sqlite3.Connection], T]) -> T:
    conn = _open(db_path)
    try:
        return work(conn)
    finally:
        conn.close()


def tree_size(directory: Path, skip: Callable[[str], bool] = lambda name: False) -> tuple[int, int]:
    """(bytes, files) under ``directory``, not following links."""
    total = files = 0
    stack = [directory]
    while stack:
        current = stack.pop()
        try:
            entries = list(os.scandir(current))
        except OSError:
            continue
        for entry in entries:
            if skip(entry.name):
                continue
            with contextlib.suppress(OSError):
                if entry.is_dir(follow_symlinks=False):
                    stack.append(Path(entry.path))
                elif entry.is_file(follow_symlinks=False):
                    total += entry.stat(follow_symlinks=False).st_size
                    files += 1
    return total, files


def db_files_size(db_path: str) -> int:
    total = 0
    for suffix in ("", "-wal", "-shm"):
        with contextlib.suppress(OSError):
            total += os.stat(db_path + suffix).st_size
    return total


def register_owner_routes(
    app: FastAPI,
    *,
    db: Database,
    hub: OwnerAwareHub,
    settings: Settings,
    now: Callable[[], float],
    upload_dir: Path,
    current_user: Callable[..., Awaitable[dict[str, Any]]],
    read_json: Callable[..., Awaitable[dict[str, Any]]],
    join_guard: JoinGuard,
    ice_provider: IceProvider,
    recheck_tokens: Callable[[], Awaitable[None]],
    free_bytes: Callable[[Path], int],
    limits: dict[str, Any],
) -> None:
    # Imported here: they import this module's helpers.
    from trio_server import backup, client_errors, storage_routes

    started_at = now()
    invite_code = settings.invite_code.encode("utf-8")
    data_dir = os.path.dirname(os.path.abspath(settings.db_path))
    boot: dict[str, Any] = {"persistent": None, "data_since": None, "boot_count": None}
    app.state.boot = boot

    async def record_boot() -> None:
        """Startup (CONTRACT-V6-OPS §7): persistence, the data's age, a boot counter.
        Never stops the server from starting."""
        try:
            persistent = await asyncio.to_thread(persistence.detect_persistent, data_dir)
        except Exception:  # noqa: BLE001 - unknown, never a failed start
            logger.exception("storage.detect.failed")
            persistent = None
        persistence.log_verdict(persistent, data_dir)
        boot["persistent"] = hub.persistent = persistent
        try:
            await ensure_ops_schema(db)
            async with db.write_lock:
                first = await get_meta(db, FIRST_OPEN_KEY)
                if first is None:
                    first = utc_iso(now())
                    await set_meta_locked(db, FIRST_OPEN_KEY, first)
                count = int(await get_meta(db, BOOT_COUNT_KEY) or 0) + 1
                await set_meta_locked(db, BOOT_COUNT_KEY, count)
            boot["data_since"], boot["boot_count"] = first, count
        except Exception:  # noqa: BLE001 - a full disk must not stop the start
            logger.exception("meta.boot.failed")

    app.state.record_boot = record_boot

    async def owner_user(user: Annotated[dict[str, Any], Depends(current_user)]) -> dict[str, Any]:
        if await resolve_owner_id(db, settings) != user["id"]:
            raise ApiError(403, "FORBIDDEN", "only the server's owner may do that")
        return user

    Owner = Annotated[dict[str, Any], Depends(owner_user)]

    def confirm(request: Request, body: dict[str, Any]) -> JSONResponse | None:
        """The invite code again, for a destructive action; None when it is right.

        It spends the join limiter's budget exactly like a join: every attempt
        counts per address, a wrong code is a failed join.
        """
        address = client_address(request, settings.trusted_proxy_hops)
        retry_after = join_guard.admit(address)
        if retry_after is not None:
            return error_response(
                429,
                "RATE_LIMITED",
                "too many attempts, try again later",
                headers={"Retry-After": str(retry_after)},
            )
        supplied = body.get("confirm_code")
        supplied_bytes = supplied.encode("utf-8") if isinstance(supplied, str) else b""
        if not hmac.compare_digest(supplied_bytes, invite_code):
            join_guard.failed(address)
            return error_response(403, "INVALID_CONFIRM_CODE", "the invite code is not right")
        return None

    async def admin_action[T](work: Callable[[sqlite3.Connection], T]) -> T:
        async with db.write_lock:
            try:
                return await asyncio.to_thread(_run_admin, settings.db_path, work)
            except admin.TooManyCodesError:
                raise ApiError(
                    429, "TOO_MANY_LINK_CODES", "too many unused link codes, try again later"
                ) from None
            except admin.AdminError:
                raise ApiError(404, "NOT_FOUND", "no such active user") from None

    def short(row: sqlite3.Row) -> dict[str, Any]:
        return {"id": row["id"], "name": row["name"]}

    @app.post("/api/owner/users/{user_id}/revoke-tokens")
    async def revoke_tokens(user_id: UserId, request: Request, user: Owner) -> Any:
        refused = confirm(request, await read_json(request))
        if refused is not None:
            return refused
        target, sessions = await admin_action(
            lambda conn: admin.do_revoke_tokens(conn, f"#{user_id}")
        )
        # At once, not within the 30-second recheck: their sockets close with 4401.
        await recheck_tokens()
        logger.info("owner.revoke_tokens target=%s sessions=%s", user_id, sessions)
        return {"user": short(target), "sessions_ended": sessions}

    @app.post("/api/owner/users/{user_id}/remove")
    async def remove_user(user_id: UserId, request: Request, user: Owner) -> Any:
        body = await read_json(request)
        if user_id == user["id"]:
            raise ApiError(409, "CANNOT_REMOVE_OWNER", "the owner cannot remove themselves")
        refused = confirm(request, body)
        if refused is not None:
            return refused
        target, sessions = await admin_action(
            lambda conn: admin.do_remove_user(conn, f"#{user_id}")
        )
        await recheck_tokens()
        logger.info("owner.remove_user target=%s sessions=%s", user_id, sessions)
        return {"user": short(target), "sessions_ended": sessions}

    @app.post("/api/owner/users/{user_id}/link-code", status_code=201)
    async def link_code(user_id: UserId, request: Request, user: Owner) -> Any:
        # Signs a device in AS that user: as destructive as the others.
        refused = confirm(request, await read_json(request))
        if refused is not None:
            return refused
        clock = now()
        target, code, expires = await admin_action(
            lambda conn: admin.do_new_link_code(conn, f"#{user_id}", clock)
        )
        logger.info("owner.link_code target=%s", user_id)
        return JSONResponse(
            {"user": short(target), "code": code, "expires_at": utc_iso(expires)},
            status_code=201,
        )

    async def user_rows() -> list[dict[str, Any]]:
        sql = (
            "SELECT u.id, u.name, u.created_at, u.removed_at, "
            "(SELECT coalesce(sum(size), 0) FROM attachments a "
            " WHERE a.uploader_id = u.id AND a.deleted_at IS NULL) AS bytes, "
            "(SELECT count(*) FROM attachments a "
            " WHERE a.uploader_id = u.id AND a.deleted_at IS NULL) AS files, "
            "(SELECT count(*) FROM tokens t WHERE t.user_id = u.id) AS sessions "
            "FROM users u ORDER BY u.id"
        )
        async with db.conn.execute(sql) as cur:
            rows = await cur.fetchall()
        owner = await resolve_owner_id(db, settings)
        out = []
        for r in rows:
            connections = hub.connection_count(r["id"])
            seen = hub.last_seen.get(r["id"])
            out.append(
                {
                    "id": r["id"],
                    "name": r["name"],
                    "created_at": r["created_at"],
                    "removed": r["removed_at"] is not None,
                    "is_owner": r["id"] == owner,
                    "online": connections > 0,
                    "connections": connections,
                    "sessions": r["sessions"],
                    "last_seen_at": utc_iso(now())
                    if connections
                    else (utc_iso(seen) if seen is not None else None),
                    "stored_bytes": r["bytes"],
                    "file_count": r["files"],
                }
            )
        return out

    async def counts() -> dict[str, int]:
        found = {}
        for key, sql in (
            ("messages", "SELECT count(*) FROM messages"),
            ("channels", "SELECT count(*) FROM channels"),
            ("attachments", "SELECT count(*) FROM attachments WHERE deleted_at IS NULL"),
        ):
            async with db.conn.execute(sql) as cur:
                (found[key],) = await cur.fetchone()
        return found

    def storage_facts() -> dict[str, Any]:
        uploads, files = tree_size(upload_dir, skip=backup.is_staging_name)
        usage = shutil.disk_usage(upload_dir)
        return {
            "uploads_bytes": uploads,
            "upload_files": files,
            "db_bytes": db_files_size(settings.db_path),
            "disk_free_bytes": free_bytes(upload_dir),
            "disk_total_bytes": usage.total,
            "user_quota_bytes": settings.user_quota_bytes,
            "disk_reserve_bytes": settings.disk_reserve_bytes,
            "max_upload_bytes": settings.max_upload_bytes,
        }

    def turn_facts() -> dict[str, Any]:
        if settings.cloudflare_turn:
            provider = "cloudflare"
        elif settings.turn_host and settings.turn_secret:
            provider = "coturn"
        else:
            provider = "none"
        last = ice_provider.last_call
        return {
            "provider": provider,
            "stun": list(settings.stun_urls),
            "last_call": None
            if last is None
            else {
                "ok": last["ok"],
                "at": utc_iso(last["at"]),
                "age_seconds": max(0, round(now() - last["at"])),
                "detail": last["detail"],
            },
        }

    @app.get("/api/owner/overview")
    async def overview(user: Owner) -> Any:
        clock = now()
        return {
            "users": await user_rows(),
            "counts": await counts(),
            "storage": await asyncio.to_thread(storage_facts),
            "server": {
                "version": VERSION,
                "started_at": utc_iso(started_at),
                "uptime_seconds": max(0, round(clock - started_at)),
                "python": platform.python_version(),
                "owner_rule": "TRIO_OWNER" if settings.owner else "lowest_id",
                "persistent": boot["persistent"],
                "data_since": boot["data_since"],
                "boot_count": boot["boot_count"],
            },
            "turn": turn_facts(),
            "limits": {
                "max_users": settings.max_users,
                "user_quota_bytes": settings.user_quota_bytes,
                "disk_reserve_bytes": settings.disk_reserve_bytes,
                "max_upload_bytes": settings.max_upload_bytes,
                "max_connections_per_user": MAX_CONNECTIONS_PER_USER,
                "trusted_proxy_hops": settings.trusted_proxy_hops,
                **limits,
            },
            "backup": await backups.status(),
        }

    backups = backup.register_backup_routes(
        app,
        db=db,
        settings=settings,
        now=now,
        upload_dir=upload_dir,
        owner_user=owner_user,
        resolve_owner=lambda: resolve_owner_id(db, settings),
    )
    storage_routes.register_storage_routes(
        app,
        db=db,
        hub=hub,
        settings=settings,
        upload_dir=upload_dir,
        current_user=current_user,
    )
    client_errors.register_client_error_routes(
        app,
        db=db,
        now=now,
        current_user=current_user,
        owner_user=owner_user,
        read_json=read_json,
    )
