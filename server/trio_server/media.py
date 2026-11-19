"""V6 media: what the server learns about an upload beyond its type.

- ``image_dimensions``: the width and height a browser will show an image at,
  read from the stored file's header (no imaging library, nothing decoded).
  A JPEG's EXIF orientation is honoured: a phone photo stored sideways with
  "rotate 90°" is reported as the portrait it is shown as.
- ``check_preview``: the small picture the client makes for the list and the
  gallery (a real PNG/JPEG/WebP, at most 640 px a side, at most 200 KiB),
  verified with the avatar checks of ``images.py``.
- ``parse_voice``: the voice-message marker (duration and a 64-bar waveform).
- ``audio_only``: a WebM or MP4 whose only track is sound is audio, not video
  (what MediaRecorder writes for a voice message).
"""

from __future__ import annotations

import re
import struct
from pathlib import Path
from typing import Any

from trio_server.errors import ApiError
from trio_server.images import ImageInfo, inspect_image

PREVIEW_MAX_BYTES = 200 * 1024
PREVIEW_MAX_SIDE = 640
# The extra multipart fields of a voice message.
VOICE_FIELD_MAX_BYTES = 1024
VOICE_MAX_MS = 130_000  # two minutes of recording, with room for the encoder's tail
WAVEFORM_BARS = 64

IMAGE_TYPES = frozenset({"image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"})
VIDEO_TYPES = frozenset({"video/mp4", "video/webm"})
MEDIA_TYPES = IMAGE_TYPES | VIDEO_TYPES

# What one dimension may be; anything else is "unknown".
_MAX_SIDE = 65_535
# How far into a JPEG the frame header is looked for (EXIF, ICC and thumbnails
# come first; past this the size is simply unknown).
_JPEG_SCAN_BYTES = 1024 * 1024


def _sane(width: int, height: int) -> tuple[int, int] | None:
    if 1 <= width <= _MAX_SIDE and 1 <= height <= _MAX_SIDE:
        return width, height
    return None


def _exif_orientation(app1: bytes) -> int:
    """The EXIF Orientation (1-8) in an APP1 segment's body, 1 when absent."""
    if not app1.startswith(b"Exif\x00\x00") or len(app1) < 14:
        return 1
    tiff = app1[6:]
    order = {b"II": "<", b"MM": ">"}.get(tiff[:2])
    if order is None:
        return 1
    try:
        (offset,) = struct.unpack(order + "I", tiff[4:8])
        (count,) = struct.unpack(order + "H", tiff[offset : offset + 2])
        for i in range(count):
            entry = tiff[offset + 2 + 12 * i : offset + 14 + 12 * i]
            if len(entry) < 12:
                break
            tag, kind = struct.unpack(order + "HH", entry[:4])
            if tag == 0x0112 and kind == 3:
                (value,) = struct.unpack(order + "H", entry[8:10])
                return value if 1 <= value <= 8 else 1
    except struct.error:
        return 1
    return 1


_JPEG_SOF = frozenset(
    {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}
)


def _jpeg_size(path: Path) -> tuple[int, int] | None:
    orientation = 1
    with path.open("rb") as f:
        if f.read(2) != b"\xff\xd8":
            return None
        while f.tell() < _JPEG_SCAN_BYTES:
            byte = f.read(1)
            if byte != b"\xff":
                return None
            marker = f.read(1)
            while marker == b"\xff":
                marker = f.read(1)
            if not marker:
                return None
            code = marker[0]
            if code in (0x01, *range(0xD0, 0xD8)):
                continue
            if code in (0xD9, 0xDA):
                return None  # end, or the scan, before any frame header
            raw = f.read(2)
            if len(raw) < 2:
                return None
            (length,) = struct.unpack(">H", raw)
            if length < 2:
                return None
            body = f.read(length - 2)
            if len(body) < length - 2:
                return None
            if code == 0xE1 and orientation == 1:
                orientation = _exif_orientation(body)
            elif code in _JPEG_SOF and len(body) >= 5:
                _precision, height, width = struct.unpack(">BHH", body[:5])
                if orientation >= 5:
                    width, height = height, width
                return _sane(width, height)
    return None


def image_dimensions(path: Path, content_type: str) -> tuple[int, int] | None:
    """(width, height) as shown, or None when the header does not say (or is broken)."""
    try:
        if content_type == "image/jpeg":
            return _jpeg_size(path)
        with path.open("rb") as f:
            head = f.read(64)
    except OSError:
        return None
    if content_type == "image/png" and head[12:16] == b"IHDR" and len(head) >= 24:
        return _sane(*struct.unpack(">II", head[16:24]))
    if content_type == "image/gif" and len(head) >= 10:
        return _sane(*struct.unpack("<HH", head[6:10]))
    if content_type == "image/webp" and len(head) >= 30:
        kind = head[12:16]
        body = head[20:]
        if kind == b"VP8X":
            return _sane(
                int.from_bytes(body[4:7], "little") + 1, int.from_bytes(body[7:10], "little") + 1
            )
        if kind == b"VP8 " and body[3:6] == b"\x9d\x01\x2a":
            width, height = struct.unpack("<HH", body[6:10])
            return _sane(width & 0x3FFF, height & 0x3FFF)
        if kind == b"VP8L" and body[0] == 0x2F:
            (bits,) = struct.unpack("<I", body[1:5])
            return _sane((bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1)
    return None


def check_preview(data: bytes, original_type: str) -> ImageInfo:
    """The preview part, verified; 422 INVALID_PREVIEW otherwise."""
    if original_type not in IMAGE_TYPES:
        raise ApiError(422, "INVALID_PREVIEW", "a preview is only taken for an image")
    info = inspect_image(data) if len(data) <= PREVIEW_MAX_BYTES else None
    if info is None or max(info.width, info.height) > PREVIEW_MAX_SIDE:
        raise ApiError(
            422,
            "INVALID_PREVIEW",
            f"the preview must be a PNG, JPEG or WebP of at most {PREVIEW_MAX_SIDE} px "
            f"and {PREVIEW_MAX_BYTES // 1024} KiB",
        )
    return info


_DURATION = re.compile(r"^[0-9]{1,6}$")
_BAR = re.compile(r"^[0-9]{1,3}$")


def parse_voice(duration: bytes | None, waveform: bytes | None, content_type: str) -> Any:
    """The voice marker from the ``voice_duration_ms`` and ``voice_waveform``
    fields, or None when neither was sent; 422 INVALID_VOICE when they are
    wrong or the file is not audio."""
    if duration is None and waveform is None:
        return None

    def invalid(why: str) -> ApiError:
        return ApiError(422, "INVALID_VOICE", why)

    if duration is None or waveform is None:
        raise invalid("a voice message needs both 'voice_duration_ms' and 'voice_waveform'")
    if not content_type.startswith("audio/"):
        raise invalid("only an audio file can be a voice message")
    try:
        text = duration.decode("ascii").strip()
        bars = waveform.decode("ascii").strip().split(",")
    except UnicodeDecodeError:
        raise invalid("voice fields must be plain numbers") from None
    if not _DURATION.match(text) or not 1 <= int(text) <= VOICE_MAX_MS:
        raise invalid(f"'voice_duration_ms' must be 1-{VOICE_MAX_MS}")
    if len(bars) != WAVEFORM_BARS or not all(_BAR.match(b) and int(b) <= 255 for b in bars):
        raise invalid(f"'voice_waveform' must be {WAVEFORM_BARS} numbers 0-255")
    return {"duration_ms": int(text), "waveform": [int(b) for b in bars]}


# A Matroska/WebM CodecID element (0x86) with a one-byte size and an ASCII
# id: "V_VP8", "A_OPUS"...
_WEBM_CODEC = re.compile(rb"\x86[\x81-\xbf]([AV])_[A-Z0-9_/.]+")


def _mp4_handlers(head: bytes) -> set[bytes]:
    """Handler types ('vide', 'soun', ...) of the tracks whose 'hdlr' box is in ``head``."""
    found = set()
    start = 0
    while (index := head.find(b"hdlr", start)) >= 4:
        found.add(head[index + 12 : index + 16])
        start = index + 4
    return found


def audio_only(head: bytes, content_type: str) -> str:
    """``content_type``, or its audio counterpart when ``head`` shows tracks of
    sound and none of picture. When the track list is not within the sniffed
    bytes (an MP4 with its index at the end), the type is left as it was."""
    if content_type == "video/webm":
        kinds = {m.group(1) for m in _WEBM_CODEC.finditer(head)}
        if kinds == {b"A"}:
            return "audio/webm"
    elif content_type == "video/mp4":
        handlers = _mp4_handlers(head)
        if b"soun" in handlers and b"vide" not in handlers:
            return "audio/mp4"
    return content_type
