"""The application factory: REST routes, error envelope, static files."""

from __future__ import annotations

import asyncio
import contextlib
import hmac
import json
import logging
import mimetypes
import re
import secrets
import shutil
import time
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Any

import httpx
from fastapi import Depends, FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from starlette.exceptions import HTTPException as StarletteHTTPException

from trio_server import linkcodes, logsafe
from trio_server.config import Settings
from trio_server.db import (
    SQL_INT_MAX,
    Database,
    NameTakenError,
    ServerFullError,
    StorageFullError,
    TooManyLinkCodesError,
    hash_token,
    utc_iso,
)
from trio_server.downloads import DownloadConfig, register_download_routes
from trio_server.errors import ApiError, error_response
from trio_server.hub import Hub
from trio_server.ice import IceProvider
from trio_server.message_routes import register_message_routes
from trio_server.profile_routes import (
    prepare_profile_dirs,
    register_profile_routes,
    unreferenced_profile_files,
)
from trio_server.ratelimit import JoinGuard, client_address
from trio_server.uploads import (
    ATTACHMENT_ID,
    FRAMING_ALLOWANCE,
    ORPHAN_SECONDS,
    new_attachment_id,
    receive_upload,
    serving_headers,
    sniff_content_type,
    storage_full,
)
from trio_server.validation import CHANNEL_KINDS, clean_name, name_key
from trio_server.version import VERSION
from trio_server.ws import encodable, websocket_endpoint

logger = logging.getLogger("trio")

JOIN_ATTEMPTS = 10
JOIN_WINDOW_SECONDS = 600
# Failed joins (wrong invite code or link code) across ALL clients per window;
# see ratelimit.JoinGuard for the trickle that keeps it from locking anybody out.
JOIN_GLOBAL_FAILURES = 30
JOIN_TRICKLE_SECONDS = 10
# How often open websockets are checked against the database, so that a token
# revoked or a user removed by the admin tool (another process) is noticed.
TOKEN_RECHECK_SECONDS = 30
BODY_MAX_BYTES = 16 * 1024
MAX_CHANNELS = 200

_STATUS_CODES = {
    400: "BAD_REQUEST",
    401: "UNAUTHORIZED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    405: "METHOD_NOT_ALLOWED",
    413: "PAYLOAD_TOO_LARGE",
}


async def read_json_object(request: Request, max_bytes: int = BODY_MAX_BYTES) -> dict[str, Any]:
    """The request body as a JSON object, counted as it arrives."""
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > max_bytes:
        raise ApiError(413, "PAYLOAD_TOO_LARGE", "request body is too large")
    body = b""
    async for chunk in request.stream():
        body += chunk
        if len(body) > max_bytes:
            raise ApiError(413, "PAYLOAD_TOO_LARGE", "request body is too large")
    try:
        data = json.loads(body)
    except (ValueError, RecursionError):
        data = None
    if not isinstance(data, dict):
        raise ApiError(422, "INVALID_REQUEST", "body must be a JSON object")
    if not encodable(data):
        # "\ud800" is valid JSON and not valid text: it cannot be compared,
        # stored or hashed as UTF-8.
        raise ApiError(422, "INVALID_REQUEST", "body contains invalid text")
    return data


async def current_user(request: Request) -> dict[str, Any]:
    scheme, _, token = request.headers.get("authorization", "").partition(" ")
    token = token.strip()
    user = None
    if scheme.lower() == "bearer" and token:
        token_hash = hash_token(token)
        user = await request.app.state.db.user_for_token_hash(token_hash)
        request.state.token_hash = token_hash
    if user is None:
        raise ApiError(401, "UNAUTHORIZED", "missing or invalid token")
    return user


CurrentUser = Annotated[dict[str, Any], Depends(current_user)]


def create_app(
    settings: Settings,
    *,
    now: Callable[[], float] = time.time,
    http_transport: httpx.AsyncBaseTransport | None = None,
    disk_free: Callable[[Path], int] | None = None,
    downloads: DownloadConfig | None = None,
) -> FastAPI:
    """Build the app.

    ``now`` is the clock (seconds since the epoch), ``http_transport`` the
    transport for outgoing HTTP (Cloudflare TURN) and ``disk_free`` the free
    bytes on the uploads volume; tests replace all three.
    """
    logsafe.install()
    db = Database(settings.db_path)
    hub = Hub(now)
    join_guard = JoinGuard(
        now,
        per_address=JOIN_ATTEMPTS,
        window_seconds=JOIN_WINDOW_SECONDS,
        global_failures=JOIN_GLOBAL_FAILURES,
        trickle_seconds=JOIN_TRICKLE_SECONDS,
    )
    invite_code = settings.invite_code.encode("utf-8")
    ice_provider = IceProvider(settings, now, http_transport)
    upload_dir = Path(settings.upload_dir)
    free_bytes = disk_free or (lambda path: shutil.disk_usage(path).free)
    # Users with an upload being received right now (one at a time each).
    uploading: set[int] = set()

    async def sweep_orphans() -> None:
        """Delete uploads never attached to a message within 24 hours."""
        async with db.write_lock:
            stale = await db.orphan_attachment_ids(now() - ORPHAN_SECONDS)
            if not stale:
                return
            await db.delete_attachments(stale)
        _remove(*(upload_dir / attachment_id for attachment_id in stale))
        logger.info("uploads.swept count=%s", len(stale))

    async def sweep_unreferenced_files() -> None:
        """Startup: remove attachment files that no row names any more.

        Deleting a message commits the rows first and unlinks the files
        after; a crash in between leaves exactly these. Only names shaped
        like an attachment id are considered (not ``*.part``, not the
        profile subdirectories).
        """
        stray = _unreferenced_files(upload_dir, await db.all_attachment_ids())
        stray += unreferenced_profile_files(
            upload_dir, await db.avatar_files(), await db.server_icon()
        )
        _remove(*stray)
        if stray:
            logger.info("uploads.unreferenced_removed count=%s", len(stray))

    async def recheck_tokens() -> None:
        """Close sockets whose token is gone; mirror removed users.

        Token lookups for REST requests and new sockets read the database
        every time, so the admin tool's changes apply to them at once. An
        OPEN socket authenticated once, at connect; this closes it (4401)
        within TOKEN_RECHECK_SECONDS of its token being revoked.
        """
        hashes = hub.token_hashes()
        live = await db.live_token_hashes(sorted(hashes)) if hashes else set()
        for token_hash in hashes - live:
            hub.kick_token(token_hash)
        # Under the write lock: a join adds its user to the hub while holding
        # it, so a list read here cannot miss a user that the hub already has.
        async with db.write_lock:
            hub.sync_users(await db.list_users())

    async def watch_tokens() -> None:
        while True:
            await asyncio.sleep(TOKEN_RECHECK_SECONDS)
            try:
                await recheck_tokens()
            except Exception:  # noqa: BLE001 - try again next round
                logger.exception("tokens.recheck.failed")

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        _prepare_upload_dir(upload_dir)
        prepare_profile_dirs(upload_dir)
        await db.open()
        hub.load(await db.list_users(), await db.list_channels())
        hub.server = await db.get_server()
        # Not only on upload: a server nobody uploads to never swept at all.
        await sweep_orphans()
        await sweep_unreferenced_files()
        watcher = asyncio.create_task(watch_tokens())
        try:
            yield
        finally:
            watcher.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await watcher
            hub.close()
            await db.close()

    # redirect_slashes off: behind a TLS edge the app sees http://, and a
    # trailing-slash redirect would point the browser at a plain-http URL.
    app = FastAPI(
        title="Trio",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        redirect_slashes=False,
    )
    app.state.settings = settings
    app.state.db = db
    app.state.hub = hub
    app.state.now = now
    app.state.join_guard = join_guard
    app.state.recheck_tokens = recheck_tokens
    app.state.sweep_orphans = sweep_orphans
    app.state.uploading = uploading

    # -- errors: always the contract's envelope ------------------------------

    @app.exception_handler(ApiError)
    async def _api_error(request: Request, exc: ApiError) -> JSONResponse:
        return error_response(exc.status, exc.code, exc.message)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        # Where and which rule, never the value that broke it.
        parts = [
            ".".join(str(p) for p in err.get("loc", ())) + ": " + str(err.get("msg", "invalid"))
            for err in exc.errors()
        ]
        return error_response(422, "INVALID_REQUEST", "; ".join(parts) or "invalid request")

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = _STATUS_CODES.get(exc.status_code, "ERROR")
        message = exc.detail if isinstance(exc.detail, str) else "error"
        return error_response(exc.status_code, code, message, headers=exc.headers)

    @app.exception_handler(Exception)
    async def _unexpected(request: Request, exc: Exception) -> JSONResponse:
        logger.exception("request.failed %s %s", request.method, request.url.path)
        return error_response(500, "INTERNAL", "internal error")

    # -- REST -----------------------------------------------------------------

    @app.get("/api/health")
    async def health() -> dict[str, Any]:
        return {"ok": True, "version": VERSION}

    @app.post("/api/join", status_code=201)
    async def join(request: Request) -> Any:
        address = client_address(request, settings.trusted_proxy_hops)
        # Every attempt counts, right or wrong, before anything is compared.
        retry_after = join_guard.admit(address)
        if retry_after is not None:
            return error_response(
                429,
                "RATE_LIMITED",
                "too many join attempts, try again later",
                headers={"Retry-After": str(retry_after)},
            )
        body = await read_json_object(request)
        if body.get("link_code") is not None:
            return await join_with_link_code(body["link_code"], address)
        supplied = body.get("invite_code")
        supplied_bytes = supplied.encode("utf-8") if isinstance(supplied, str) else b""
        if not hmac.compare_digest(supplied_bytes, invite_code):
            join_guard.failed(address)
            raise ApiError(403, "INVALID_INVITE", "invalid invite code")
        name = clean_name(body.get("name"))
        if name is None:
            raise ApiError(422, "INVALID_NAME", "name must be 1-32 characters")
        token = secrets.token_urlsafe(32)
        async with db.write_lock:
            try:
                user = await db.create_user(
                    name, name_key(name), hash_token(token), settings.max_users
                )
            except NameTakenError:
                raise ApiError(409, "NAME_TAKEN", "that name is already taken") from None
            except ServerFullError:
                raise ApiError(409, "SERVER_FULL", "the server is full") from None
            hub.add_user(user)
        logger.info("user.joined id=%s", user["id"])
        return {"token": token, "user": user}

    async def join_with_link_code(raw: Any, address: str) -> JSONResponse:
        """Another device for an existing user: a new token, the same account."""
        code = linkcodes.normalize(raw)
        user = None
        token = secrets.token_urlsafe(32)
        if code is not None:
            async with db.write_lock:
                user = await db.redeem_link_code(
                    linkcodes.hash_code(code), now(), hash_token(token)
                )
        if user is None:
            join_guard.failed(address)
            raise ApiError(403, "INVALID_LINK_CODE", "invalid or expired link code")
        logger.info("user.linked id=%s", user["id"])
        return JSONResponse({"token": token, "user": user}, status_code=200)

    @app.post("/api/link-codes", status_code=201)
    async def create_link_code(user: CurrentUser) -> dict[str, Any]:
        code = linkcodes.new_code()
        async with db.write_lock:
            try:
                expires = await db.create_link_code(
                    user["id"],
                    linkcodes.hash_code(code),
                    now(),
                    linkcodes.TTL_SECONDS,
                    linkcodes.MAX_LIVE_PER_USER,
                )
            except TooManyLinkCodesError:
                raise ApiError(
                    429, "TOO_MANY_LINK_CODES", "too many unused link codes, try again later"
                ) from None
        return {"code": code, "expires_at": utc_iso(expires)}

    @app.delete("/api/session", status_code=204)
    async def logout(request: Request, user: CurrentUser) -> Response:
        """Sign THIS token out: it stops working and its sockets close with 4401."""
        token_hash = request.state.token_hash
        async with db.write_lock:
            await db.delete_token(token_hash)
        closed = hub.kick_token(token_hash)
        logger.info("session.ended user=%s sockets=%s", user["id"], closed)
        return Response(status_code=204)

    @app.get("/api/me")
    async def me(user: CurrentUser) -> dict[str, Any]:
        return {"user": user}

    @app.get("/api/channels")
    async def list_channels(user: CurrentUser) -> dict[str, Any]:
        return {"channels": list(hub.channels.values())}

    @app.post("/api/channels", status_code=201)
    async def create_channel(request: Request, user: CurrentUser) -> dict[str, Any]:
        body = await read_json_object(request)
        name = clean_name(body.get("name"))
        kind = body.get("kind")
        if name is None or kind not in CHANNEL_KINDS:
            raise ApiError(
                422, "INVALID_CHANNEL", "name must be 1-32 characters and kind 'text' or 'voice'"
            )
        async with db.write_lock:
            if len(hub.channels) >= MAX_CHANNELS:
                raise ApiError(409, "CHANNEL_LIMIT", "too many channels")
            channel = await db.create_channel(name, kind)
            hub.add_channel(channel)
        return {"channel": channel}

    @app.get("/api/channels/{channel_id}/messages")
    async def list_messages(
        channel_id: int,
        user: CurrentUser,
        before: Annotated[int | None, Query(ge=1, le=SQL_INT_MAX)] = None,
        limit: Annotated[int, Query(ge=1, le=100)] = 50,
    ) -> dict[str, Any]:
        channel = hub.channels.get(channel_id)
        if channel is None or channel["kind"] != "text":
            raise ApiError(404, "NOT_FOUND", "no such text channel")
        messages, has_more = await db.list_messages(channel_id, before, limit)
        return {"messages": messages, "has_more": has_more}

    @app.get("/api/ice")
    async def ice(user: CurrentUser) -> Response:
        servers = await ice_provider.ice_servers(user["id"])
        return JSONResponse({"iceServers": servers}, headers={"Cache-Control": "no-store"})

    # -- attachments --------------------------------------------------------

    def space_left() -> bool:
        return free_bytes(upload_dir) >= settings.disk_reserve_bytes

    @app.post("/api/uploads", status_code=201)
    async def upload(request: Request, user: CurrentUser) -> dict[str, Any]:
        # One at a time per user: a burst of parallel uploads cannot race past
        # the quota (each would see the same "used" figure).
        if user["id"] in uploading:
            raise ApiError(429, "UPLOAD_IN_PROGRESS", "wait for your other upload to finish")
        uploading.add(user["id"])
        try:
            return await store_upload(request, user)
        finally:
            uploading.discard(user["id"])

    async def store_upload(request: Request, user: dict[str, Any]) -> dict[str, Any]:
        await sweep_orphans()
        remaining = settings.user_quota_bytes - await db.stored_bytes(user["id"])
        if remaining <= 0:
            raise ApiError(413, "QUOTA_EXCEEDED", "you have used all of your storage")
        declared = request.headers.get("content-length", "")
        expected = settings.max_upload_bytes + FRAMING_ALLOWANCE
        if declared.isdigit():
            expected = min(int(declared), expected)
        if free_bytes(upload_dir) - expected < settings.disk_reserve_bytes:
            logger.warning("upload.refused.disk_full user=%s", user["id"])
            raise storage_full()
        attachment_id = new_attachment_id()
        partial = upload_dir / f"{attachment_id}.part"
        try:
            received = await receive_upload(
                request,
                partial,
                settings.max_upload_bytes,
                quota_bytes=remaining,
                space_left=space_left,
            )
        except ApiError as exc:
            if exc.status == 507:
                logger.warning("upload.refused.disk_full_while_writing user=%s", user["id"])
            raise
        final = upload_dir / attachment_id
        try:
            partial.replace(final)
            content_type = sniff_content_type(received.head, received.filename)
            async with db.write_lock:
                attachment = await db.create_attachment(
                    attachment_id,
                    user["id"],
                    received.filename,
                    content_type,
                    received.size,
                    now(),
                )
        except StorageFullError:
            _remove(partial, final)
            raise storage_full() from None
        except BaseException:
            _remove(partial, final)
            raise
        logger.info("upload.stored user=%s size=%s", user["id"], received.size)
        return {"attachment": attachment}

    @app.api_route("/api/files/{attachment_id}/{filename:path}", methods=["GET", "HEAD"])
    async def download(attachment_id: str, filename: str) -> Response:
        # The id is the capability; the name segment is only for the browser.
        attachment = None
        if ATTACHMENT_ID.match(attachment_id):
            attachment = await db.get_attachment(attachment_id)
        path = upload_dir / attachment_id
        if attachment is None or not path.is_file():
            return error_response(404, "NOT_FOUND", "no such file")
        return FileResponse(
            path,
            media_type=attachment["content_type"],
            headers=serving_headers(attachment["content_type"], attachment["filename"]),
        )

    register_message_routes(
        app,
        db=db,
        hub=hub,
        now=now,
        upload_dir=upload_dir,
        current_user=current_user,
        read_json=read_json_object,
    )

    register_profile_routes(
        app,
        db=db,
        hub=hub,
        now=now,
        upload_dir=upload_dir,
        current_user=current_user,
        read_json=read_json_object,
        space_left=space_left,
    )

    app.add_api_websocket_route("/ws", websocket_endpoint)

    # CONTRACT-V6-DOWNLOAD: the public download page, before the static fallback.
    register_download_routes(
        app,
        downloads or DownloadConfig.from_env(),
        now=now,
        http_transport=http_transport,
        static_dir=settings.static_dir,
        page_headers=shell_headers,
        trusted_proxy_hops=settings.trusted_proxy_hops,
    )

    # Registered after every real /api route: an unknown one is a JSON 404 for
    # any method, and never falls through to the client's index.html.
    @app.api_route(
        "/api/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]
    )
    async def api_not_found(path: str) -> Response:
        return error_response(404, "NOT_FOUND", "no such endpoint")

    if settings.static_dir:
        _mount_static(app, Path(settings.static_dir))

    return app


def _prepare_upload_dir(directory: Path) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    # Partial files left by a crash mid-upload; nothing refers to them.
    _remove(*directory.glob("*.part"))


def _unreferenced_files(directory: Path, known: set[str]) -> list[Path]:
    return [
        path
        for path in directory.iterdir()
        if ATTACHMENT_ID.match(path.name) and path.is_file() and path.name not in known
    ]


def _remove(*paths: Path) -> None:
    for path in paths:
        with contextlib.suppress(FileNotFoundError):
            path.unlink()


_HOST = re.compile(r"^(?:[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*|\[[0-9A-Fa-f:.]+\])(?::[0-9]{1,5})?$")


def shell_headers(host: str) -> dict[str, str]:
    """Headers for the app shell (index.html): what the page may load and who may frame it.

    connect-src: CSP Level 3 lets 'self' match ws:/wss: on the same host, but
    browsers that predate that rule (Safari before 15.4) would block the
    websocket, so the page's own host is also named explicitly, for both
    schemes. That is tighter than "ws: wss:" (any host) and works everywhere.
    The Host header comes from the request; it is only used when it is a
    plain host[:port], so it cannot add a directive.
    """
    connect = "'self'"
    if _HOST.match(host):
        connect += f" ws://{host} wss://{host}"
    policy = "; ".join(
        (
            "default-src 'self'",
            # wasm-unsafe-eval + blob: for the RNNoise AudioWorklet and its wasm.
            "script-src 'self' 'wasm-unsafe-eval' blob:",
            "worker-src 'self' blob:",
            f"connect-src {connect}",
            "img-src 'self' blob: data:",
            "media-src 'self' blob:",
            "style-src 'self' 'unsafe-inline'",
            "object-src 'none'",
            "base-uri 'none'",
            "frame-ancestors 'none'",
        )
    )
    return {
        "Content-Security-Policy": policy,
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Permissions-Policy": "camera=(self), microphone=(self), display-capture=(self)",
        "Cache-Control": "no-cache",
    }


def _mount_static(app: FastAPI, directory: Path) -> None:
    """Serve the built client, falling back to index.html for client-side routes."""
    # python:3.12-slim has no /etc/mime.types and Python 3.12's own table lacks
    # .webp, so the themed artwork would otherwise go out with the wrong type.
    mimetypes.add_type("image/webp", ".webp")
    root = directory.resolve()
    if not (root / "index.html").is_file():
        logger.warning("static.missing index.html not found in TRIO_STATIC_DIR")

    @app.api_route("/{path:path}", methods=["GET", "HEAD"])
    async def static_files(path: str, request: Request) -> Response:
        if path in ("api", "ws") or path.startswith(("api/", "ws/")):
            return error_response(404, "NOT_FOUND", "no such endpoint")
        if path and "\x00" not in path:
            candidate = (root / path).resolve()
            # resolve() follows ".." and symlinks; anything outside the root is not ours.
            if candidate == root / "index.html":
                return FileResponse(
                    candidate, headers=shell_headers(request.headers.get("host", ""))
                )
            if candidate.is_relative_to(root) and candidate.is_file():
                headers = {"X-Content-Type-Options": "nosniff"}
                if path.startswith("assets/"):
                    # Vite puts a content hash in every file name under assets/.
                    headers["Cache-Control"] = "public, max-age=31536000, immutable"
                return FileResponse(candidate, headers=headers)
        # A missing asset or file with an extension is a 404, not HTML that a
        # <script> tag would then fail to parse.
        last = path.rsplit("/", 1)[-1]
        index = root / "index.html"
        if path.startswith("assets/") or "." in last or not index.is_file():
            return error_response(404, "NOT_FOUND", "not found")
        return FileResponse(index, headers=shell_headers(request.headers.get("host", "")))
