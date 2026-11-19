"""Small real image files for the avatar tests, made without an imaging library.

``png`` writes a true PNG (zlib-compressed scanlines, valid CRCs). ``jpeg``
is a tiny baseline JPEG encoder for a flat grey picture: one component, an
identity quantisation table and one-symbol Huffman tables, so every 8x8 block
is "DC difference 0, end of block" — two bits. Both were checked against
Pillow when written; WebP files are Pillow's output, embedded.
"""

from __future__ import annotations

import math
import struct
import zlib


def png_chunk(kind: bytes, body: bytes) -> bytes:
    return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))


def png(width: int, height: int, *, ihdr_size: tuple[int, int] | None = None) -> bytes:
    rows = b"".join(b"\x00" + b"\x10\x80\xf0" * width for _ in range(height))
    w, h = ihdr_size or (width, height)
    return (
        b"\x89PNG\r\n\x1a\n"
        + png_chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
        + png_chunk(b"IDAT", zlib.compress(rows))
        + png_chunk(b"IEND", b"")
    )


def _segment(marker: int, body: bytes) -> bytes:
    return bytes([0xFF, marker]) + struct.pack(">H", len(body) + 2) + body


def jpeg(width: int, height: int) -> bytes:
    blocks = math.ceil(width / 8) * math.ceil(height / 8)
    bits = "00" * blocks
    bits += "1" * (-len(bits) % 8)
    scan = bytearray()
    for i in range(0, len(bits), 8):
        byte = int(bits[i : i + 8], 2)
        scan.append(byte)
        if byte == 0xFF:
            scan.append(0)
    one_code = bytes([1] + [0] * 15)  # a single code of length 1
    return (
        b"\xff\xd8"
        + _segment(0xE0, b"JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00")
        + _segment(0xDB, b"\x00" + b"\x01" * 64)
        + _segment(0xC0, struct.pack(">BHHB", 8, height, width, 1) + b"\x01\x11\x00")
        + _segment(0xC4, b"\x00" + one_code + b"\x00")
        + _segment(0xC4, b"\x10" + one_code + b"\x00")
        + _segment(0xDA, b"\x01\x01\x00\x00\x3f\x00")
        + bytes(scan)
        + b"\xff\xd9"
    )


# Pillow 12: Image.new(...).save(..., "WEBP", ...).
WEBP_LOSSLESS_4X4 = bytes.fromhex(
    "524946461e000000574542505650384c110000002f03c0000007508f2297a7ff8188e87f0000"
)
WEBP_LOSSY_16X16 = bytes.fromhex(
    "524946463800000057454250565038202c0000009001009d012a1000100001402625a00274ba"
    "00039800fef0fa2baef16946bffbc67ffdc67ffdc67feee00000"
)
WEBP_ALPHA_5X3 = bytes.fromhex(
    "524946465c00000057454250565038580a00000010000000040000020000414c50480a000000"
    "010750c088084444ff03565038202c0000009001009d012a0500030001402625a00274ba0003"
    "9800fef0fa2baef16946bffbc67ffdc67ffdc67feee00000"
)
