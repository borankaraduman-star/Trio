"""Attachments: streaming multipart upload, file names, content types, serving headers.

The stored file is named by its id only. The client's file name is display
text: sanitised, kept in the database and in the URL's last segment, and never
joined to a path.
"""

from __future__ import annotations

import contextlib
import os
import re
import secrets
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import quote

from python_multipart.exceptions import MultipartParseError
from python_multipart.multipart import MultipartParser, parse_options_header
from starlette.requests import Request

from trio_server.errors import ApiError

FILENAME_MAX = 120
MAX_ATTACHMENTS = 10
ORPHAN_SECONDS = 24 * 60 * 60
# Multipart framing (boundaries, part headers) on top of the file itself.
FRAMING_ALLOWANCE = 64 * 1024
SNIFF_BYTES = 64

ATTACHMENT_ID = re.compile(r"^[A-Za-z0-9_-]{43}$")

# Shown in the browser; everything else downloads. html and svg are
# deliberately not here: either could run script on this origin.
INLINE_TYPES = frozenset(
    {
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "video/mp4",
        "video/webm",
        "audio/mpeg",
        "audio/ogg",
        "audio/wav",
        "application/pdf",
    }
)

# Used only when the leading bytes say nothing. The sniffable image, video and
# pdf types are absent on purpose: a ".png" that is not a PNG is not served as
# one.
EXTENSION_TYPES = {
    ".txt": "text/plain",
    ".log": "text/plain",
    ".md": "text/markdown",
    ".csv": "text/csv",
    ".json": "application/json",
    ".xml": "application/xml",
    ".html": "text/html",
    ".htm": "text/html",
    ".svg": "image/svg+xml",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".oga": "audio/ogg",
    ".opus": "audio/ogg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".flac": "audio/flac",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
    ".zip": "application/zip",
    ".7z": "application/x-7z-compressed",
    ".gz": "application/gzip",
    ".tar": "application/x-tar",
    ".rar": "application/vnd.rar",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".odt": "application/vnd.oasis.opendocument.text",
}
OCTET_STREAM = "application/octet-stream"


def new_attachment_id() -> str:
    return secrets.token_urlsafe(32)  # 43 characters


def clean_filename(raw: str) -> str | None:
    """Basename, control and format characters removed, at most 120 characters."""
    name = unicodedata.normalize("NFC", raw).replace("\\", "/").rsplit("/", 1)[-1]
    name = "".join(
        ch for ch in name if unicodedata.category(ch) not in ("Cc", "Cf", "Cs", "Zl", "Zp")
    ).strip()
    if name in ("", ".", ".."):
        return None
    if len(name) > FILENAME_MAX:
        stem, dot, ext = name.rpartition(".")
        if dot and stem and 0 < len(ext) <= 16:
            name = stem[: FILENAME_MAX - len(ext) - 1].rstrip() + "." + ext
        else:
            name = name[:FILENAME_MAX].rstrip()
    return name or None


def sniff_content_type(head: bytes, filename: str) -> str:
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if head.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if head.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp"
    if head[:4] == b"RIFF" and head[8:12] == b"WAVE":
        return "audio/wav"
    if head.startswith(b"%PDF-"):
        return "application/pdf"
    if head[4:8] == b"ftyp":
        return "audio/mp4" if head[8:12] == b"M4A " else "video/mp4"
    if head.startswith(b"\x1a\x45\xdf\xa3") and b"webm" in head:
        return "video/webm"
    if head.startswith(b"OggS"):
        return "audio/ogg"
    if head.startswith(b"ID3"):
        return "audio/mpeg"
    return EXTENSION_TYPES.get(Path(filename).suffix.lower(), OCTET_STREAM)


def content_disposition(content_type: str, filename: str) -> str:
    kind = "inline" if content_type in INLINE_TYPES else "attachment"
    fallback = "".join(
        ch if 0x20 <= ord(ch) < 0x7F and ch not in '"\\;%' else "_" for ch in filename
    )
    return f"{kind}; filename=\"{fallback}\"; filename*=UTF-8''{quote(filename, safe='')}"


def serving_headers(content_type: str, filename: str) -> dict[str, str]:
    return {
        "Content-Disposition": content_disposition(content_type, filename),
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox; default-src 'none'",
        "Cache-Control": "private, max-age=31536000, immutable",
    }


@dataclass
class ReceivedFile:
    filename: str
    size: int
    head: bytes


def _too_large() -> ApiError:
    return ApiError(413, "FILE_TOO_LARGE", "file is too large")


def _invalid(message: str) -> ApiError:
    return ApiError(422, "INVALID_UPLOAD", message)


async def receive_upload(request: Request, destination: Path, max_bytes: int) -> ReceivedFile:
    """Stream the multipart part ``file`` into ``destination``.

    The size is counted as the bytes arrive; past ``max_bytes`` the partial
    file is removed and 413 raised. Any refusal removes what was written.
    """
    mime, options = parse_options_header(request.headers.get("content-type", ""))
    boundary = options.get(b"boundary")
    if mime != b"multipart/form-data" or not boundary:
        raise _invalid("expected multipart/form-data with a 'file' part")
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > max_bytes + FRAMING_ALLOWANCE:
        raise _too_large()

    state: dict[str, Any] = {
        "header_field": b"",
        "header_value": b"",
        "headers": {},
        "in_file": False,
        "done_file": False,
        "filename": None,
        "size": 0,
        "head": b"",
        "ended": False,
    }
    pending: list[bytes] = []

    def on_part_begin() -> None:
        state["headers"] = {}
        state["in_file"] = False

    def on_header_field(data: bytes, start: int, end: int) -> None:
        state["header_field"] += data[start:end]

    def on_header_value(data: bytes, start: int, end: int) -> None:
        state["header_value"] += data[start:end]

    def on_header_end() -> None:
        state["headers"][state["header_field"].lower()] = state["header_value"]
        state["header_field"] = b""
        state["header_value"] = b""

    def on_headers_finished() -> None:
        _, disp = parse_options_header(state["headers"].get(b"content-disposition", b""))
        if disp.get(b"name") == b"file" and not state["done_file"]:
            state["in_file"] = True
            raw = disp.get(b"filename")
            name = raw.decode("utf-8", "replace") if raw is not None else ""
            # Browsers send '"', CR and LF in a file name as %22, %0D, %0A (the
            # HTML form-data rules); nothing else is percent-decoded.
            for encoded, plain in (("%22", '"'), ("%0D", "\r"), ("%0A", "\n")):
                name = name.replace(encoded, plain).replace(encoded.lower(), plain)
            state["filename"] = name

    def on_part_data(data: bytes, start: int, end: int) -> None:
        if not state["in_file"]:
            return
        chunk = data[start:end]
        state["size"] += len(chunk)
        if state["size"] > max_bytes:
            raise _too_large()
        if len(state["head"]) < SNIFF_BYTES:
            state["head"] = (state["head"] + chunk)[:SNIFF_BYTES]
        pending.append(chunk)

    def on_part_end() -> None:
        if state["in_file"]:
            state["in_file"] = False
            state["done_file"] = True

    def on_end() -> None:
        state["ended"] = True

    parser = MultipartParser(
        boundary,
        {
            "on_part_begin": on_part_begin,
            "on_header_field": on_header_field,
            "on_header_value": on_header_value,
            "on_header_end": on_header_end,
            "on_headers_finished": on_headers_finished,
            "on_part_data": on_part_data,
            "on_part_end": on_part_end,
            "on_end": on_end,
        },
    )

    total = 0
    completed = False
    fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "wb") as out:
            async for chunk in request.stream():
                total += len(chunk)
                if total > max_bytes + FRAMING_ALLOWANCE:
                    raise _too_large()
                try:
                    parser.write(chunk)
                except MultipartParseError:
                    raise _invalid("malformed multipart body") from None
                for piece in pending:
                    out.write(piece)
                pending.clear()
        try:
            parser.finalize()
        except MultipartParseError:
            raise _invalid("malformed multipart body") from None
        if not state["ended"] or not state["done_file"]:
            raise _invalid("a 'file' part is required")
        filename = clean_filename(state["filename"] or "")
        if filename is None:
            raise _invalid("the file needs a name")
        if state["size"] == 0:
            raise _invalid("the file is empty")
        completed = True
        return ReceivedFile(filename=filename, size=state["size"], head=state["head"])
    finally:
        if not completed:
            _remove(destination)


def _remove(path: Path) -> None:
    with contextlib.suppress(FileNotFoundError):
        path.unlink()
