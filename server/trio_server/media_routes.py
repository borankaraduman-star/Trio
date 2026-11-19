"""V6 media and everyday chat (CONTRACT-V6-MEDIA): what an upload carries
beyond its file, the preview files, and the channel's gallery lists.

- ``UPLOAD_EXTRA_PARTS`` / ``upload_extras``: the optional multipart parts of
  ``POST /api/uploads`` — ``preview`` (a small picture of an image) and the
  voice-message fields — checked once the file is stored.
- Previews live in ``<uploads>/previews/<attachment id>``, are counted in the
  uploader's quota, and go when their attachment goes (``remove_previews``;
  the start-up sweep removes any whose row is gone).
- ``GET /api/previews/{id}``, ``GET /api/channels/{id}/attachments`` and
  ``GET /api/channels/{id}/links``.
"""

# No ``from __future__ import annotations``: FastAPI must see the dependency
# type as an object (see message_routes.py).
import contextlib
import errno
import re
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Annotated, Any

from fastapi import Depends, FastAPI, Query
from fastapi.responses import FileResponse, JSONResponse, Response

from trio_server.db import SQL_INT_MAX, Database
from trio_server.errors import ApiError, error_response
from trio_server.hub import Hub
from trio_server.media import (
    IMAGE_TYPES,
    PREVIEW_MAX_BYTES,
    VOICE_FIELD_MAX_BYTES,
    check_preview,
    image_dimensions,
    parse_voice,
)
from trio_server.uploads import ATTACHMENT_ID, ReceivedFile, storage_full

PREVIEWS = "previews"
UPLOAD_EXTRA_PARTS = {
    "preview": (PREVIEW_MAX_BYTES, "INVALID_PREVIEW"),
    "voice_duration_ms": (VOICE_FIELD_MAX_BYTES, "INVALID_VOICE"),
    "voice_waveform": (VOICE_FIELD_MAX_BYTES, "INVALID_VOICE"),
}
GALLERY_LIMIT_DEFAULT = 60
GALLERY_LIMIT_MAX = 100
_CURSOR = re.compile(r"^([1-9][0-9]{0,18})-([0-9]{1,4})$")


def previews_dir(upload_dir: Path) -> Path:
    return upload_dir / PREVIEWS


def prepare_previews_dir(upload_dir: Path) -> None:
    previews_dir(upload_dir).mkdir(parents=True, exist_ok=True)


def remove_previews(upload_dir: Path, attachment_ids: Any) -> None:
    for attachment_id in attachment_ids:
        with contextlib.suppress(FileNotFoundError):
            (previews_dir(upload_dir) / attachment_id).unlink()


def unreferenced_previews(upload_dir: Path, known: set[str]) -> list[Path]:
    folder = previews_dir(upload_dir)
    if not folder.is_dir():
        return []
    return [
        p
        for p in folder.iterdir()
        if p.is_file() and not (ATTACHMENT_ID.match(p.name) and p.name in known)
    ]


def upload_extras(
    received: ReceivedFile,
    content_type: str,
    stored: Path,
    upload_dir: Path,
    attachment_id: str,
    remaining_quota: int,
) -> dict[str, Any]:
    """The V6 columns of a stored upload; writes the preview file.

    422 INVALID_PREVIEW / INVALID_VOICE for parts that are wrong; 413
    QUOTA_EXCEEDED when the file and its preview together do not fit. The
    caller removes the stored file on any error (and the preview with it).
    """
    voice = parse_voice(
        received.extras.get("voice_duration_ms"),
        received.extras.get("voice_waveform"),
        content_type,
    )
    preview = received.extras.get("preview")
    info = check_preview(preview, content_type) if preview is not None else None
    if preview is not None and received.size + len(preview) > remaining_quota:
        raise ApiError(413, "QUOTA_EXCEEDED", "this upload would exceed your storage quota")
    size = image_dimensions(stored, content_type) if content_type in IMAGE_TYPES else None
    fields: dict[str, Any] = {
        "width": size[0] if size else None,
        "height": size[1] if size else None,
        "voice": voice,
    }
    if preview is not None and info is not None:
        target = previews_dir(upload_dir) / attachment_id
        try:
            target.write_bytes(preview)
        except OSError as exc:
            if exc.errno in (errno.ENOSPC, errno.EDQUOT, errno.EFBIG):
                raise storage_full() from None
            raise
        fields["preview_type"] = info.content_type
        fields["preview_size"] = len(preview)
    return fields


def _cursor(raw: str | None) -> tuple[int, int] | None:
    if raw is None:
        return None
    match = _CURSOR.match(raw)
    if match is None or int(match.group(1)) > SQL_INT_MAX:
        raise ApiError(422, "INVALID_REQUEST", "'before' must be a cursor this server gave")
    return int(match.group(1)), int(match.group(2))


def _page(items: list[dict[str, Any]], has_more: bool) -> dict[str, Any]:
    last = items[-1] if items else None
    return {
        "items": [{k: v for k, v in item.items() if k != "position"} for item in items],
        "has_more": has_more,
        "next_before": f"{last['message_id']}-{last['position']}" if last and has_more else None,
    }


def register_media_routes(
    app: FastAPI,
    *,
    db: Database,
    hub: Hub,
    upload_dir: Path,
    current_user: Callable[..., Awaitable[dict[str, Any]]],
) -> None:
    User = Annotated[dict[str, Any], Depends(current_user)]
    Limit = Annotated[int, Query(ge=1, le=GALLERY_LIMIT_MAX)]

    def text_channel(channel_id: int) -> None:
        channel = hub.channels.get(channel_id)
        if channel is None or channel["kind"] != "text":
            raise ApiError(404, "NOT_FOUND", "no such text channel")

    @app.api_route("/api/previews/{attachment_id}", methods=["GET", "HEAD"])
    async def preview(attachment_id: str) -> Response:
        # No auth, like /api/files: the attachment id is the capability.
        kind = await db.preview_of(attachment_id) if ATTACHMENT_ID.match(attachment_id) else None
        path = previews_dir(upload_dir) / attachment_id
        if kind is None or not path.is_file():
            return error_response(404, "NOT_FOUND", "no such preview")
        return FileResponse(
            path,
            media_type=kind,
            headers={
                "Content-Disposition": "inline",
                "X-Content-Type-Options": "nosniff",
                "Content-Security-Policy": "sandbox; default-src 'none'",
                "Cache-Control": "private, max-age=31536000, immutable",
            },
        )

    @app.get("/api/channels/{channel_id}/attachments")
    async def channel_attachments(
        channel_id: int,
        user: User,
        kind: Annotated[str, Query(pattern="^(media|file)$")] = "media",
        before: str | None = None,
        limit: Limit = GALLERY_LIMIT_DEFAULT,
    ) -> Any:
        text_channel(channel_id)
        items, more = await db.channel_attachments(
            channel_id, kind == "media", _cursor(before), limit
        )
        return JSONResponse(_page(items, more))

    @app.get("/api/channels/{channel_id}/links")
    async def channel_links(
        channel_id: int,
        user: User,
        before: str | None = None,
        limit: Limit = GALLERY_LIMIT_DEFAULT,
    ) -> Any:
        text_channel(channel_id)
        items, more = await db.channel_links(channel_id, _cursor(before), limit)
        return JSONResponse(_page(items, more))
