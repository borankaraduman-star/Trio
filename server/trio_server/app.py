"""The application factory: REST routes, error envelope, static files."""

from __future__ import annotations

import contextlib
import hmac
import json
import logging
import secrets
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

from trio_server import logsafe
from trio_server.config import Settings
from trio_server.db import Database, NameTakenError, ServerFullError, hash_token
from trio_server.errors import ApiError, error_response
from trio_server.hub import Hub
from trio_server.ice import IceProvider
from trio_server.ratelimit import AttemptLimiter, client_address
from trio_server.uploads import (
    ATTACHMENT_ID,
    ORPHAN_SECONDS,
    new_attachment_id,
    receive_upload,
    serving_headers,
    sniff_content_type,
)
from trio_server.validation import CHANNEL_KINDS, clean_name, name_key
from trio_server.ws import websocket_endpoint

logger = logging.getLogger("trio")

JOIN_ATTEMPTS = 10
JOIN_WINDOW_SECONDS = 600
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


async def read_json_object(request: Request) -> dict[str, Any]:
    """The request body as a JSON object, counted as it arrives."""
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > BODY_MAX_BYTES:
        raise ApiError(413, "PAYLOAD_TOO_LARGE", "request body is too large")
    body = b""
    async for chunk in request.stream():
        body += chunk
        if len(body) > BODY_MAX_BYTES:
            raise ApiError(413, "PAYLOAD_TOO_LARGE", "request body is too large")
    try:
        data = json.loads(body)
    except (ValueError, RecursionError):
        data = None
    if not isinstance(data, dict):
        raise ApiError(422, "INVALID_REQUEST", "body must be a JSON object")
    return data


async def current_user(request: Request) -> dict[str, Any]:
    scheme, _, token = request.headers.get("authorization", "").partition(" ")
    token = token.strip()
    user = None
    if scheme.lower() == "bearer" and token:
        user = await request.app.state.db.user_for_token(token)
    if user is None:
        raise ApiError(401, "UNAUTHORIZED", "missing or invalid token")
    return user


CurrentUser = Annotated[dict[str, Any], Depends(current_user)]


def create_app(
    settings: Settings,
    *,
    now: Callable[[], float] = time.time,
    http_transport: httpx.AsyncBaseTransport | None = None,
) -> FastAPI:
    """Build the app.

    ``now`` is the clock (seconds since the epoch) and ``http_transport`` the
    transport for outgoing HTTP (Cloudflare TURN); tests replace both.
    """
    logsafe.install()
    db = Database(settings.db_path)
    hub = Hub()
    join_limiter = AttemptLimiter(JOIN_ATTEMPTS, JOIN_WINDOW_SECONDS, now)
    invite_code = settings.invite_code.encode("utf-8")
    ice_provider = IceProvider(settings, now, http_transport)
    upload_dir = Path(settings.upload_dir)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        _prepare_upload_dir(upload_dir)
        await db.open()
        hub.load(await db.list_users(), await db.list_channels())
        try:
            yield
        finally:
            await db.close()

    app = FastAPI(title="Trio", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.settings = settings
    app.state.db = db
    app.state.hub = hub
    app.state.now = now

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
    async def health() -> dict[str, bool]:
        return {"ok": True}

    @app.post("/api/join", status_code=201)
    async def join(request: Request) -> Any:
        address = client_address(request)
        # Every attempt counts, right or wrong, before anything is compared.
        if not join_limiter.allow(address):
            return error_response(
                429,
                "RATE_LIMITED",
                "too many join attempts, try again later",
                headers={"Retry-After": str(join_limiter.retry_after(address))},
            )
        body = await read_json_object(request)
        supplied = body.get("invite_code")
        supplied_bytes = supplied.encode("utf-8") if isinstance(supplied, str) else b""
        if not hmac.compare_digest(supplied_bytes, invite_code):
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
        before: Annotated[int | None, Query(ge=1)] = None,
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

    async def sweep_orphans() -> None:
        """Delete uploads never attached to a message within 24 hours."""
        async with db.write_lock:
            stale = await db.orphan_attachment_ids(now() - ORPHAN_SECONDS)
            if not stale:
                return
            await db.delete_attachments(stale)
        _remove(*(upload_dir / attachment_id for attachment_id in stale))
        logger.info("uploads.swept count=%s", len(stale))

    @app.post("/api/uploads", status_code=201)
    async def upload(request: Request, user: CurrentUser) -> dict[str, Any]:
        await sweep_orphans()
        attachment_id = new_attachment_id()
        partial = upload_dir / f"{attachment_id}.part"
        received = await receive_upload(request, partial, settings.max_upload_bytes)
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

    app.add_api_websocket_route("/ws", websocket_endpoint)

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


def _remove(*paths: Path) -> None:
    for path in paths:
        with contextlib.suppress(FileNotFoundError):
            path.unlink()


def _mount_static(app: FastAPI, directory: Path) -> None:
    """Serve the built client, falling back to index.html for client-side routes."""
    root = directory.resolve()
    if not (root / "index.html").is_file():
        logger.warning("static.missing index.html not found in TRIO_STATIC_DIR")

    @app.api_route("/{path:path}", methods=["GET", "HEAD"])
    async def static_files(path: str) -> Response:
        if path in ("api", "ws") or path.startswith(("api/", "ws/")):
            return error_response(404, "NOT_FOUND", "no such endpoint")
        if path and "\x00" not in path:
            candidate = (root / path).resolve()
            # resolve() follows ".." and symlinks; anything outside the root is not ours.
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
        return FileResponse(
            index, headers={"Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff"}
        )
