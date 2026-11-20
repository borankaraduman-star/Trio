"""Identity: avatars, renames, the server's name and icon (CONTRACT-V4 C).

Files live in two subdirectories of the upload directory:

    <uploads>/avatars/<user id>-<hash>.<ext>     served at /api/avatars/<user id>/<hash>.<ext>
    <uploads>/icons/<hash>.<ext>                 served at /api/server/icon/<hash>.<ext>

``<hash>`` is the first 32 hex digits of the file's SHA-256, so a URL never
changes meaning and may be cached forever. A replaced file is deleted after
the database names its successor; a crash in between leaves a file no row
names, removed at the next start (``sweep_profile_files``).
"""

# No ``from __future__ import annotations``: see message_routes.

import contextlib
import hashlib
import logging
import re
import secrets
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Annotated, Any

from fastapi import Depends, FastAPI, Request
from fastapi import Path as PathParam
from fastapi.responses import FileResponse, Response

from trio_server.db import SQL_INT_MAX, Database, NameTakenError, StorageFullError
from trio_server.errors import ApiError, error_response
from trio_server.hub import Hub
from trio_server.images import inspect_image
from trio_server.ratelimit import SlidingWindow
from trio_server.uploads import receive_upload, storage_full
from trio_server.validation import clean_name, name_key

logger = logging.getLogger("trio")

IMAGE_MAX_BYTES = 2 * 1024 * 1024
IMAGE_MAX_PIXELS = 512  # per side
PROFILE_LIMIT = 10  # renames, avatar and server changes per user per window
PROFILE_WINDOW_SECONDS = 60
AVATARS = "avatars"
ICONS = "icons"
STORED_NAME = re.compile(r"^[0-9a-f]{32}\.(png|jpg|webp)$")
_TYPES = {"png": "image/png", "jpg": "image/jpeg", "webp": "image/webp"}


def image_headers(ext: str) -> dict[str, str]:
    return {
        "Content-Type": _TYPES[ext],
        "Content-Disposition": "inline",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox; default-src 'none'",
        # The name is the content's hash: it never changes, so neither may the cache.
        "Cache-Control": "public, max-age=31536000, immutable",
    }


def prepare_profile_dirs(upload_dir: Path) -> None:
    for name in (AVATARS, ICONS):
        directory = upload_dir / name
        directory.mkdir(parents=True, exist_ok=True)
        for partial in directory.glob("*.part"):
            with contextlib.suppress(FileNotFoundError):
                partial.unlink()


def unreferenced_profile_files(upload_dir: Path, avatars: set[str], icon: str | None) -> list[Path]:
    stray = [p for p in (upload_dir / AVATARS).iterdir() if p.is_file() and p.name not in avatars]
    stray += [p for p in (upload_dir / ICONS).iterdir() if p.is_file() and p.name != icon]
    return stray


def _read(path: Path) -> bytes:
    return path.read_bytes()


def register_profile_routes(
    app: FastAPI,
    *,
    db: Database,
    hub: Hub,
    now: Callable[[], float],
    upload_dir: Path,
    current_user: Callable[..., Awaitable[dict[str, Any]]],
    read_json: Callable[..., Awaitable[dict[str, Any]]],
    space_left: Callable[[], bool],
) -> None:
    User = Annotated[dict[str, Any], Depends(current_user)]
    limit = SlidingWindow(PROFILE_LIMIT, PROFILE_WINDOW_SECONDS, now)
    app.state.profile_limit = limit
    avatars_dir, icons_dir = upload_dir / AVATARS, upload_dir / ICONS

    def spend(user: dict[str, Any]) -> None:
        if not limit.allow(str(user["id"])):
            raise ApiError(429, "RATE_LIMITED", "too many profile changes, try again in a minute")

    async def receive_image(request: Request, directory: Path) -> tuple[Path, str]:
        """Stream the ``file`` part to a partial file and check it is an image.
        (the partial path, "<hash>.<ext>"); the caller renames or removes it."""
        if not space_left():
            raise storage_full()
        partial = directory / f"{secrets.token_hex(16)}.part"
        await receive_upload(request, partial, IMAGE_MAX_BYTES, space_left=space_left)
        try:
            data = _read(partial)
            info = inspect_image(data)
            if info is None:
                raise ApiError(422, "INVALID_IMAGE", "the file must be a PNG, JPEG or WebP image")
            if info.width > IMAGE_MAX_PIXELS or info.height > IMAGE_MAX_PIXELS:
                raise ApiError(
                    422, "INVALID_IMAGE", f"the image may be at most {IMAGE_MAX_PIXELS} px a side"
                )
        except BaseException:
            _remove(partial)
            raise
        return partial, f"{hashlib.sha256(data).hexdigest()[:32]}.{info.ext}"

    # -- me ----------------------------------------------------------------------

    @app.patch("/api/me")
    async def rename(request: Request, user: User) -> Any:
        spend(user)
        body = await read_json(request)
        name = clean_name(body.get("name"))
        if name is None:
            raise ApiError(422, "INVALID_NAME", "name must be 1-32 characters")
        async with db.write_lock:
            try:
                renamed = await db.rename_user(user["id"], name, name_key(name))
            except NameTakenError:
                raise ApiError(409, "NAME_TAKEN", "that name is already taken") from None
            except StorageFullError:
                raise storage_full() from None
            if renamed != user:
                hub.update_user(renamed)
        return {"user": renamed}

    @app.put("/api/me/avatar")
    async def put_avatar(request: Request, user: User) -> Any:
        spend(user)
        partial, stored = await receive_image(request, avatars_dir)
        final = avatars_dir / f"{user['id']}-{stored}"
        try:
            partial.replace(final)
            async with db.write_lock:
                updated, old = await db.set_avatar(user["id"], stored)
                if old != stored:
                    hub.update_user(updated)
        except StorageFullError:
            _remove(partial, final)
            raise storage_full() from None
        except BaseException:
            _remove(partial)
            raise
        if old is not None and old != stored:
            _remove(avatars_dir / f"{user['id']}-{old}")
        return {"user": updated}

    @app.delete("/api/me/avatar")
    async def delete_avatar(user: User) -> Any:
        spend(user)
        async with db.write_lock:
            try:
                updated, old = await db.set_avatar(user["id"], None)
            except StorageFullError:
                raise storage_full() from None
            if old is not None:
                hub.update_user(updated)
        if old is not None:
            _remove(avatars_dir / f"{user['id']}-{old}")
        return {"user": updated}

    @app.api_route("/api/avatars/{user_id}/{stored}", methods=["GET", "HEAD"])
    async def get_avatar(
        user_id: Annotated[int, PathParam(ge=1, le=SQL_INT_MAX)], stored: str
    ) -> Response:
        path = avatars_dir / f"{user_id}-{stored}"
        if not STORED_NAME.match(stored) or await db.user_avatar(user_id) != stored:
            return error_response(404, "NOT_FOUND", "no such avatar")
        if not path.is_file():
            return error_response(404, "NOT_FOUND", "no such avatar")
        return FileResponse(path, headers=image_headers(stored.rsplit(".", 1)[1]))

    # -- the server ------------------------------------------------------------

    @app.get("/api/server")
    async def get_server(user: User) -> Any:
        # CONTRACT-V10-GROUPS §2: the room cap beside the profile.
        return {"server": hub.server, "voice_room_max": hub.voice_room_max}

    @app.patch("/api/server")
    async def patch_server(request: Request, user: User) -> Any:
        spend(user)
        body = await read_json(request)
        name = clean_name(body.get("name"))
        if name is None:
            raise ApiError(422, "INVALID_NAME", "name must be 1-32 characters")
        async with db.write_lock:
            try:
                server = await db.set_server_name(name)
            except StorageFullError:
                raise storage_full() from None
            if server != hub.server:
                hub.update_server(server)
        logger.info("server.renamed by=%s", user["id"])
        return {"server": server}

    @app.put("/api/server/icon")
    async def put_icon(request: Request, user: User) -> Any:
        spend(user)
        partial, stored = await receive_image(request, icons_dir)
        final = icons_dir / stored
        try:
            partial.replace(final)
            async with db.write_lock:
                server, old = await db.set_server_icon(stored)
                if old != stored:
                    hub.update_server(server)
        except StorageFullError:
            _remove(partial, final)
            raise storage_full() from None
        except BaseException:
            _remove(partial)
            raise
        if old is not None and old != stored:
            _remove(icons_dir / old)
        return {"server": server}

    @app.delete("/api/server/icon")
    async def delete_icon(user: User) -> Any:
        spend(user)
        async with db.write_lock:
            try:
                server, old = await db.set_server_icon(None)
            except StorageFullError:
                raise storage_full() from None
            if old is not None:
                hub.update_server(server)
        if old is not None:
            _remove(icons_dir / old)
        return {"server": server}

    @app.api_route("/api/server/icon/{stored}", methods=["GET", "HEAD"])
    async def get_icon(stored: str) -> Response:
        if not STORED_NAME.match(stored) or await db.server_icon() != stored:
            return error_response(404, "NOT_FOUND", "no such icon")
        path = icons_dir / stored
        if not path.is_file():
            return error_response(404, "NOT_FOUND", "no such icon")
        return FileResponse(path, headers=image_headers(stored.rsplit(".", 1)[1]))


def _remove(*paths: Path) -> None:
    for path in paths:
        with contextlib.suppress(FileNotFoundError):
            path.unlink()
