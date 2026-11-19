"""Attachments: streaming multipart upload, file names, content types, serving headers.

The stored file is named by its id only. The client's file name is display
text: sanitised, kept in the database and in the URL's last segment, and never
joined to a path.
"""

from __future__ import annotations

import contextlib
import errno
import os
import re
import secrets
import unicodedata
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import quote

from python_multipart.exceptions import MultipartParseError
from python_multipart.multipart import MultipartParser, parse_options_header
from starlette.requests import Request

from trio_server.errors import ApiError
from trio_server.media import audio_only

FILENAME_MAX = 120
MAX_ATTACHMENTS = 10
ORPHAN_SECONDS = 24 * 60 * 60
# Multipart framing (boundaries, part headers) on top of the file itself.
FRAMING_ALLOWANCE = 64 * 1024
# What the type sniffing reads. The v2/v3 rules look at the first 64 bytes
# only (``LEGACY_SNIFF_BYTES``); V6 looks further into WebM and MP4 headers to
# tell a recording with no picture (audio) from a video.
SNIFF_BYTES = 4096
LEGACY_SNIFF_BYTES = 64

ATTACHMENT_ID = re.compile(r"^[A-Za-z0-9_-]{43}$")

# Shown in the browser; everything else downloads. html and svg are
# deliberately not here: either could run script on this origin.
INLINE_TYPES = frozenset(
    {
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "image/avif",
        "video/mp4",
        "video/webm",
        "audio/mpeg",
        "audio/ogg",
        "audio/wav",
        # V6: voice messages (MediaRecorder: WebM/Opus in Chromium, MP4/AAC in Safari).
        "audio/webm",
        "audio/mp4",
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

# ISO base media files ("ftyp" box at byte 4) by brand. The major brand is at
# bytes 8-12 and compatible brands follow from byte 16. Only what a browser's
# <video> actually plays is video/mp4: QuickTime and HEIF share the box format
# but not the codecs, and served as video/mp4 they were a broken player.
FTYP_BRANDS = {
    # MP4 proper (ISO 14496-12/14), and widely used MP4 flavours.
    "isom": "video/mp4",
    "iso2": "video/mp4",
    "iso3": "video/mp4",
    "iso4": "video/mp4",
    "iso5": "video/mp4",
    "iso6": "video/mp4",
    "mp41": "video/mp4",
    "mp42": "video/mp4",
    "avc1": "video/mp4",
    "dash": "video/mp4",  # MPEG-DASH segments
    "M4V ": "video/mp4",  # Apple iTunes video
    "MSNV": "video/mp4",  # Sony PSP / many cameras
    "mmp4": "video/mp4",  # 3GPP-flavoured MP4 from phones
    # Audio-only MP4.
    "M4A ": "audio/mp4",
    "M4B ": "audio/mp4",
    # Apple QuickTime (.mov): not reliably playable in browsers.
    "qt  ": "video/quicktime",
    # HEIF stills and sequences (iPhone photos).
    "heic": "image/heic",
    "heix": "image/heic",
    "heim": "image/heic",
    "heis": "image/heic",
    "hevc": "image/heic",
    "hevx": "image/heic",
    # AVIF: browsers render it.
    "avif": "image/avif",
    "avis": "image/avif",
}
# Generic HEIF brands: what the file is depends on the compatible brands
# (an AVIF often says "mif1" first and "avif" later).
HEIF_GENERIC = frozenset({"mif1", "msf1"})


def _ftyp_type(head: bytes) -> str | None:
    """The type an ftyp box names, or None when it names nothing we know."""
    major = head[8:12].decode("latin-1")
    compatible = [head[i : i + 4].decode("latin-1") for i in range(16, len(head) - 3, 4)]
    # Only the brands inside the box count; its size is the first 4 bytes.
    box_size = int.from_bytes(head[0:4], "big")
    if 16 <= box_size <= len(head):
        compatible = compatible[: (box_size - 16) // 4]
    if major in HEIF_GENERIC:
        if any(b in ("avif", "avis") for b in compatible):
            return "image/avif"
        return "image/heic"
    if major in FTYP_BRANDS:
        return FTYP_BRANDS[major]
    for brand in compatible:
        if brand in HEIF_GENERIC:
            return "image/heic"
        if brand in FTYP_BRANDS:
            return FTYP_BRANDS[brand]
    return None


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
    """The served type: the v3 rules on the first 64 bytes, then V6's look
    further in (``media.audio_only``) for WebM/MP4 files with no video track."""
    return audio_only(head, _legacy_sniff(head[:LEGACY_SNIFF_BYTES], filename))


def _legacy_sniff(head: bytes, filename: str) -> str:
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
        found = _ftyp_type(head)
        if found is not None:
            return found
        # Brands we do not know: never guessed to be playable; the extension
        # allowlist below decides, which for .mp4 means a download.
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
    # V6: the small extra parts asked for (``extra_parts``), by name.
    extras: dict[str, bytes] = field(default_factory=dict)


def _too_large() -> ApiError:
    return ApiError(413, "FILE_TOO_LARGE", "file is too large")


def _over_quota() -> ApiError:
    return ApiError(413, "QUOTA_EXCEEDED", "this upload would exceed your storage quota")


def storage_full() -> ApiError:
    return ApiError(507, "STORAGE_FULL", "the server's disk is full")


# Writes that fail because the disk, the volume or a quota is full.
_FULL_ERRNOS = frozenset({errno.ENOSPC, errno.EDQUOT, errno.EFBIG})
# How often (bytes written) the free space is looked at again while streaming.
SPACE_CHECK_BYTES = 1024 * 1024


def _invalid(message: str) -> ApiError:
    return ApiError(422, "INVALID_UPLOAD", message)


async def receive_upload(
    request: Request,
    destination: Path,
    max_bytes: int,
    *,
    quota_bytes: int | None = None,
    space_left: Callable[[], bool] | None = None,
    extra_parts: dict[str, tuple[int, str]] | None = None,
) -> ReceivedFile:
    """Stream the multipart part ``file`` into ``destination``.

    The size is counted as the bytes arrive; past ``max_bytes`` the partial
    file is removed and 413 FILE_TOO_LARGE raised, past ``quota_bytes`` (what
    is left of the user's quota) 413 QUOTA_EXCEEDED. ``space_left`` is asked
    again every SPACE_CHECK_BYTES; False, or the disk filling up during a
    write, is 507 STORAGE_FULL. Any refusal removes what was written.

    ``extra_parts`` (V6) names small parts kept in memory beside the file:
    ``{name: (max_bytes, error_code)}``; a part over its size is 422
    ``error_code``. Repeated parts: the first counts. Other parts are ignored.
    """
    extra_parts = extra_parts or {}
    extra_allowance = sum(limit for limit, _ in extra_parts.values())
    mime, options = parse_options_header(request.headers.get("content-type", ""))
    boundary = options.get(b"boundary")
    if mime != b"multipart/form-data" or not boundary:
        raise _invalid("expected multipart/form-data with a 'file' part")
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > max_bytes + FRAMING_ALLOWANCE + extra_allowance:
        raise _too_large()
    if (
        quota_bytes is not None
        and declared.isdigit()
        and int(declared) > quota_bytes + FRAMING_ALLOWANCE + extra_allowance
    ):
        raise _over_quota()

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
        "extra": None,
        "extras": {},
    }
    pending: list[bytes] = []

    def on_part_begin() -> None:
        state["headers"] = {}
        state["in_file"] = False
        state["extra"] = None

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
        else:
            part = (disp.get(b"name") or b"").decode("latin-1")
            if part in extra_parts and part not in state["extras"]:
                state["extra"] = part
                state["extras"][part] = b""

    def on_part_data(data: bytes, start: int, end: int) -> None:
        extra = state["extra"]
        if extra is not None:
            value = state["extras"][extra] + data[start:end]
            limit, code = extra_parts[extra]
            if len(value) > limit:
                raise ApiError(422, code, f"'{extra}' is too large")
            state["extras"][extra] = value
            return
        if not state["in_file"]:
            return
        chunk = data[start:end]
        state["size"] += len(chunk)
        if state["size"] > max_bytes:
            raise _too_large()
        if quota_bytes is not None and state["size"] > quota_bytes:
            raise _over_quota()
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
    written = 0
    next_space_check = SPACE_CHECK_BYTES
    completed = False
    try:
        fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except OSError as exc:
        if exc.errno in _FULL_ERRNOS:
            raise storage_full() from None
        raise
    try:
        try:
            with os.fdopen(fd, "wb") as out:
                async for chunk in request.stream():
                    total += len(chunk)
                    if total > max_bytes + FRAMING_ALLOWANCE + extra_allowance:
                        raise _too_large()
                    try:
                        parser.write(chunk)
                    except MultipartParseError:
                        raise _invalid("malformed multipart body") from None
                    for piece in pending:
                        out.write(piece)
                        written += len(piece)
                    pending.clear()
                    if space_left is not None and written >= next_space_check:
                        next_space_check = written + SPACE_CHECK_BYTES
                        if not space_left():
                            raise storage_full()
        except OSError as exc:
            # ENOSPC on a write or on the final flush: the volume is full.
            if exc.errno in _FULL_ERRNOS:
                raise storage_full() from None
            raise
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
        return ReceivedFile(
            filename=filename, size=state["size"], head=state["head"], extras=state["extras"]
        )
    finally:
        if not completed:
            _remove(destination)


def _remove(path: Path) -> None:
    with contextlib.suppress(FileNotFoundError):
        path.unlink()
