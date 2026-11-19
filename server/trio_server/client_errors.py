"""The client's error log, with no third party (CONTRACT-V6-OPS §5).

``POST /api/client-errors`` takes one uncaught error from a signed-in client:
deduplicated by a hash of the message and the top stack frame (a repeat adds
to its counter), at most 10 reports per user per hour, at most 200 rows kept
(the least recently seen go first). The owner reads the last 50 and may clear
them. What is stored is cleaned again here: URLs lose their query and
fragment, anything shaped like ``token=…`` is redacted, every field is cut to
its limit.
"""

# No ``from __future__ import annotations``: see message_routes.

import hashlib
import json
import re
from collections.abc import Awaitable, Callable
from typing import Annotated, Any

from fastapi import Depends, FastAPI, Request
from fastapi.responses import Response

from trio_server.db import Database, utc_iso
from trio_server.errors import ApiError
from trio_server.ops_schema import ensure_ops_schema
from trio_server.ratelimit import SlidingWindow

BODY_MAX_BYTES = 4096
REPORT_LIMIT = 10
REPORT_WINDOW_SECONDS = 60 * 60
MAX_ROWS = 200
LIST_LIMIT = 50
MAX_VERSIONS = 5
LIMITS = {"message": 500, "stack": 2048, "version": 40, "build": 40, "context": 120, "browser": 40}

# The query/fragment of a URL, up to a stack frame's ":line:col" (kept) or the URL's end.
_URL_TAIL = re.compile(
    r"((?:https?|wss?|blob):[^\s?#()'\"]*)[?#][^\s()'\"]*?(?=(?::\d+){1,2}(?=[\s)'\"]|$)|[\s()'\"]|$)",
    re.IGNORECASE,
)
_SECRET = re.compile(r"((?:token|ticket|code|key|password)=)[^&\s\"']+", re.IGNORECASE)
_FRAME = re.compile(r"^\s*(at\s|\S*@\S)")


def scrub(text: str, limit: int) -> str:
    """No query strings or fragments on URLs, no ``secret=…`` values, at most ``limit``."""
    text = "".join(ch for ch in text if ch in "\n\t" or ord(ch) >= 0x20)
    text = _URL_TAIL.sub(r"\1", text)
    text = _SECRET.sub(r"\1[redacted]", text)
    return text[:limit]


def top_frame(stack: str) -> str:
    for line in stack.splitlines():
        if _FRAME.match(line):
            return line.strip()
    return ""


def error_hash(message: str, stack: str) -> str:
    return hashlib.sha256(f"{message}\n{top_frame(stack)}".encode()).hexdigest()


def _field(body: dict[str, Any], key: str, *, required: bool = False) -> str:
    value = body.get(key)
    if value is None and not required:
        return ""
    if not isinstance(value, str) or (required and not value.strip()):
        raise ApiError(422, "INVALID_REQUEST", f"{key} must be a string")
    return scrub(value, LIMITS[key])


def register_client_error_routes(
    app: FastAPI,
    *,
    db: Database,
    now: Callable[[], float],
    current_user: Callable[..., Awaitable[dict[str, Any]]],
    owner_user: Callable[..., Awaitable[dict[str, Any]]],
    read_json: Callable[..., Awaitable[dict[str, Any]]],
) -> None:
    User = Annotated[dict[str, Any], Depends(current_user)]
    Owner = Annotated[dict[str, Any], Depends(owner_user)]
    reports = SlidingWindow(REPORT_LIMIT, REPORT_WINDOW_SECONDS, now)
    app.state.client_error_limit = reports

    @app.post("/api/client-errors", status_code=204)
    async def report(request: Request, user: User) -> Response:
        body = await read_json(request, max_bytes=BODY_MAX_BYTES)
        message = _field(body, "message", required=True)
        stack = _field(body, "stack")
        version = _field(body, "version")
        build = _field(body, "build")
        context = _field(body, "context")
        browser = _field(body, "browser")
        if not reports.allow(str(user["id"])):
            raise ApiError(429, "RATE_LIMITED", "too many error reports, try again later")
        label = version + (f" ({build})" if build else "") or "?"
        digest = error_hash(message, stack)
        clock = now()
        await ensure_ops_schema(db)
        async with db.write_lock:
            async with db.conn.execute(
                "SELECT versions FROM client_errors WHERE hash = ?", (digest,)
            ) as cur:
                found = await cur.fetchone()
            try:
                if found is None:
                    await db.conn.execute(
                        "INSERT INTO client_errors (hash, message, stack, context, browser, "
                        "versions, user_id, count, first_at, last_at, last_ts) "
                        "VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)",
                        (
                            digest,
                            message,
                            stack,
                            context,
                            browser,
                            json.dumps([label]),
                            user["id"],
                            utc_iso(clock),
                            utc_iso(clock),
                            clock,
                        ),
                    )
                else:
                    versions = [v for v in json.loads(found["versions"]) if v != label]
                    versions = [*versions, label][-MAX_VERSIONS:]
                    await db.conn.execute(
                        "UPDATE client_errors SET count = count + 1, last_at = ?, last_ts = ?, "
                        "versions = ?, user_id = ?, context = ?, browser = ? WHERE hash = ?",
                        (
                            utc_iso(clock),
                            clock,
                            json.dumps(versions),
                            user["id"],
                            context,
                            browser,
                            digest,
                        ),
                    )
                await db.conn.execute(
                    "DELETE FROM client_errors WHERE id NOT IN (SELECT id FROM client_errors "
                    "ORDER BY last_ts DESC, id DESC LIMIT ?)",
                    (MAX_ROWS,),
                )
                await db.conn.commit()
            except BaseException:
                await db.conn.rollback()
                raise
        return Response(status_code=204)

    @app.get("/api/owner/errors")
    async def list_errors(user: Owner) -> Any:
        await ensure_ops_schema(db)
        async with db.conn.execute(
            "SELECT e.*, u.name AS user_name FROM client_errors e "
            "LEFT JOIN users u ON u.id = e.user_id "
            "ORDER BY e.last_ts DESC, e.id DESC LIMIT ?",
            (LIST_LIMIT,),
        ) as cur:
            rows = await cur.fetchall()
        async with db.conn.execute(
            "SELECT count(*), coalesce(sum(count), 0) FROM client_errors"
        ) as cur:
            distinct, total = await cur.fetchone()
        return {
            "errors": [
                {
                    "id": r["id"],
                    "message": r["message"],
                    "stack": r["stack"],
                    "context": r["context"],
                    "browser": r["browser"],
                    "versions": json.loads(r["versions"]),
                    "count": r["count"],
                    "first_at": r["first_at"],
                    "last_at": r["last_at"],
                    "user": None
                    if r["user_id"] is None
                    else {"id": r["user_id"], "name": r["user_name"]},
                }
                for r in rows
            ],
            "distinct": distinct,
            "total": total,
        }

    @app.delete("/api/owner/errors", status_code=204)
    async def clear_errors(user: Owner) -> Response:
        await ensure_ops_schema(db)
        async with db.write_lock:
            await db.conn.execute("DELETE FROM client_errors")
            await db.conn.commit()
        return Response(status_code=204)
