"""What an avatar or icon file really is: PNG, JPEG or WebP, and its size.

Pure Python, no imaging library: the file is not decoded, its container is
walked strictly. That is enough to refuse anything that is not one of the
three formats (whatever its name or the client's claimed type says), to
read the dimensions the browser will use, and to refuse a file whose
structure is broken (bad PNG CRCs, a JPEG with no frame header or scan, a
WebP whose RIFF sizes do not add up). It cannot prove the compressed pixels
decode; a browser simply shows nothing for such a file, and it is served with
the same sandboxing headers as every upload.
"""

from __future__ import annotations

import struct
import zlib
from dataclasses import dataclass


@dataclass(frozen=True)
class ImageInfo:
    content_type: str
    ext: str
    width: int
    height: int


PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
_PNG_COLOUR_DEPTHS = {0: {1, 2, 4, 8, 16}, 2: {8, 16}, 3: {1, 2, 4, 8}, 4: {8, 16}, 6: {8, 16}}
# Start-of-frame markers (baseline, extended, progressive, lossless...).
# Not C4 (DHT), C8 (JPG extension) or CC (DAC).
_JPEG_SOF = frozenset(
    {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}
)
_JPEG_STANDALONE = frozenset({0x01, *range(0xD0, 0xD8)})


def _png(data: bytes) -> ImageInfo | None:
    pos, size, first = 8, None, True
    seen_idat = False
    while pos + 12 <= len(data):
        (length,) = struct.unpack(">I", data[pos : pos + 4])
        kind = data[pos + 4 : pos + 8]
        end = pos + 12 + length
        if length > 2**31 - 1 or end > len(data):
            return None
        body = data[pos + 8 : pos + 8 + length]
        (crc,) = struct.unpack(">I", data[end - 4 : end])
        if zlib.crc32(kind + body) != crc:
            return None
        if first:
            if kind != b"IHDR" or length != 13:
                return None
            width, height, depth, colour = struct.unpack(">IIBB", body[:10])
            if depth not in _PNG_COLOUR_DEPTHS.get(colour, ()):
                return None
            size = (width, height)
            first = False
        elif kind == b"IHDR":
            return None
        elif kind == b"IDAT":
            seen_idat = True
        elif kind == b"IEND":
            if end != len(data) or not seen_idat or size is None:
                return None
            return ImageInfo("image/png", "png", *size)
        pos = end
    return None


def _jpeg(data: bytes) -> ImageInfo | None:
    pos, size = 2, None
    while pos < len(data):
        if data[pos] != 0xFF:
            return None
        while pos < len(data) and data[pos] == 0xFF:
            pos += 1  # fill bytes
        if pos >= len(data):
            return None
        marker = data[pos]
        pos += 1
        if marker in _JPEG_STANDALONE:
            continue
        if marker in (0x00, 0xD8, 0xD9):
            return None  # EOI (or a second SOI) before any scan
        if pos + 2 > len(data):
            return None
        (length,) = struct.unpack(">H", data[pos : pos + 2])
        if length < 2 or pos + length > len(data):
            return None
        segment = data[pos + 2 : pos + length]
        if marker in _JPEG_SOF:
            if size is not None or len(segment) < 6:
                return None
            _precision, height, width, components = struct.unpack(">BHHB", segment[:6])
            if components not in (1, 3, 4) or len(segment) != 6 + 3 * components:
                return None
            size = (width, height)
        elif marker == 0xDA:
            # Start of scan: the entropy-coded data runs to the end; the file
            # must have had its frame header and must end with EOI.
            if size is None or not data.endswith(b"\xff\xd9"):
                return None
            return ImageInfo("image/jpeg", "jpg", *size)
        pos += length
    return None


def _vp8(chunk: bytes) -> tuple[int, int] | None:
    if len(chunk) < 10 or chunk[0] & 1 or chunk[3:6] != b"\x9d\x01\x2a":
        return None  # not a key frame
    width, height = struct.unpack("<HH", chunk[6:10])
    return width & 0x3FFF, height & 0x3FFF


def _vp8l(chunk: bytes) -> tuple[int, int] | None:
    if len(chunk) < 5 or chunk[0] != 0x2F:
        return None
    (bits,) = struct.unpack("<I", chunk[1:5])
    if bits >> 29:  # version must be 0
        return None
    return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1


def _webp(data: bytes) -> ImageInfo | None:
    (riff_size,) = struct.unpack("<I", data[4:8])
    if riff_size + 8 != len(data) or riff_size % 2:
        return None
    pos, chunks = 12, []
    while pos < len(data):
        if pos + 8 > len(data):
            return None
        kind = data[pos : pos + 4]
        (length,) = struct.unpack("<I", data[pos + 4 : pos + 8])
        end = pos + 8 + length
        if end > len(data):
            return None
        chunks.append((kind, data[pos + 8 : end]))
        pos = end + (length & 1)
    if pos != len(data) or not chunks:
        return None
    kinds = [kind for kind, _ in chunks]
    kind, body = chunks[0]
    if kind == b"VP8 " and len(chunks) == 1:
        size = _vp8(body)
    elif kind == b"VP8L" and len(chunks) == 1:
        size = _vp8l(body)
    elif kind == b"VP8X":
        if len(body) != 10 or body[0] & 0x02:  # animation: not an avatar
            return None
        canvas = (
            int.from_bytes(body[4:7], "little") + 1,
            int.from_bytes(body[7:10], "little") + 1,
        )
        images = [(k, b) for k, b in chunks[1:] if k in (b"VP8 ", b"VP8L")]
        if len(images) != 1 or kinds.count(b"VP8X") != 1:
            return None
        image_kind, image_body = images[0]
        inner = _vp8(image_body) if image_kind == b"VP8 " else _vp8l(image_body)
        size = canvas if inner == canvas else None
    else:
        return None
    if size is None:
        return None
    return ImageInfo("image/webp", "webp", *size)


def inspect_image(data: bytes) -> ImageInfo | None:
    """The image's real type and dimensions, or None when it is not a
    well-formed PNG, JPEG or WebP with both sides at least 1 pixel."""
    info = None
    if data.startswith(PNG_SIGNATURE):
        info = _png(data)
    elif data.startswith(b"\xff\xd8"):
        info = _jpeg(data)
    elif len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        info = _webp(data)
    if info is None or info.width < 1 or info.height < 1:
        return None
    return info
