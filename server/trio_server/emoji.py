"""Is a reaction key one emoji? (CONTRACT-V4 B)

The standard library has no grapheme segmentation and no emoji properties, so
this is a small grammar over code-point ranges instead of a full UAX #29
segmenter. It accepts what emoji keyboards and pickers actually produce:

- a pictographic character (the ``Extended_Pictographic`` ranges of Unicode's
  emoji-data.txt, which deliberately include not-yet-assigned code points so
  that emoji newer than this Python's Unicode tables still pass), optionally
  followed by VS15/VS16 and/or one skin-tone modifier;
- such elements joined with ZERO WIDTH JOINER (families, professions, ❤️‍🔥);
- a flag: exactly two regional indicators;
- a keycap: ``0-9 # *``, optional VS16, U+20E3;
- a subdivision flag: U+1F3F4, tag characters, CANCEL TAG.

Everything else is refused: letters, digits on their own, whitespace, control
and format characters (other than ZWJ and the variation selectors in the
positions above), lone surrogates, private-use characters, and anything over
``KEY_MAX_BYTES``. It does not check that a sequence is one Unicode actually
lists (``👍‍🐈`` passes): the key is a label the clients render, and an
unlisted ZWJ sequence renders as its parts, which is harmless.
"""

from __future__ import annotations

import re

KEY_MAX_BYTES = 64
MAX_ELEMENTS = 10
CUSTOM_KEY = re.compile(r":[a-z0-9_]{1,32}:", re.ASCII)

ZWJ = 0x200D
VS15, VS16 = 0xFE0E, 0xFE0F
KEYCAP = 0x20E3
MODIFIERS = range(0x1F3FB, 0x1F400)
REGIONAL = range(0x1F1E6, 0x1F200)
TAG_SPEC = range(0xE0020, 0xE007F)
CANCEL_TAG = 0xE007F
BLACK_FLAG = 0x1F3F4
KEYCAP_BASES = frozenset(map(ord, "0123456789#*"))

# Extended_Pictographic (emoji-data.txt), as inclusive ranges.
_PICTOGRAPHIC = (
    (0x00A9, 0x00A9), (0x00AE, 0x00AE), (0x203C, 0x203C), (0x2049, 0x2049),
    (0x2122, 0x2122), (0x2139, 0x2139), (0x2194, 0x2199), (0x21A9, 0x21AA),
    (0x231A, 0x231B), (0x2328, 0x2328), (0x2388, 0x2388), (0x23CF, 0x23CF),
    (0x23E9, 0x23F3), (0x23F8, 0x23FA), (0x24C2, 0x24C2), (0x25AA, 0x25AB),
    (0x25B6, 0x25B6), (0x25C0, 0x25C0), (0x25FB, 0x25FE), (0x2600, 0x2605),
    (0x2607, 0x2612), (0x2614, 0x2685), (0x2690, 0x2705), (0x2708, 0x2712),
    (0x2714, 0x2714), (0x2716, 0x2716), (0x271D, 0x271D), (0x2721, 0x2721),
    (0x2728, 0x2728), (0x2733, 0x2734), (0x2744, 0x2744), (0x2747, 0x2747),
    (0x274C, 0x274C), (0x274E, 0x274E), (0x2753, 0x2755), (0x2757, 0x2757),
    (0x2763, 0x2767), (0x2795, 0x2797), (0x27A1, 0x27A1), (0x27B0, 0x27B0),
    (0x27BF, 0x27BF), (0x2934, 0x2935), (0x2B05, 0x2B07), (0x2B1B, 0x2B1C),
    (0x2B50, 0x2B50), (0x2B55, 0x2B55), (0x3030, 0x3030), (0x303D, 0x303D),
    (0x3297, 0x3297), (0x3299, 0x3299), (0x1F000, 0x1F0FF), (0x1F10D, 0x1F10F),
    (0x1F12F, 0x1F12F), (0x1F16C, 0x1F171), (0x1F17E, 0x1F17F), (0x1F18E, 0x1F18E),
    (0x1F191, 0x1F19A), (0x1F1AD, 0x1F1E5), (0x1F201, 0x1F20F), (0x1F21A, 0x1F21A),
    (0x1F22F, 0x1F22F), (0x1F232, 0x1F23A), (0x1F23C, 0x1F23F), (0x1F249, 0x1F3FA),
    (0x1F400, 0x1F53D), (0x1F546, 0x1F64F), (0x1F680, 0x1F6FF), (0x1F774, 0x1F77F),
    (0x1F7D5, 0x1F7FF), (0x1F80C, 0x1F80F), (0x1F848, 0x1F84F), (0x1F85A, 0x1F85F),
    (0x1F888, 0x1F88F), (0x1F8AE, 0x1F8FF), (0x1F90C, 0x1F93A), (0x1F93C, 0x1F945),
    (0x1F947, 0x1FAFF), (0x1FC00, 0x1FFFD),
)  # fmt: skip


def is_pictographic(cp: int) -> bool:
    return any(lo <= cp <= hi for lo, hi in _PICTOGRAPHIC)


def _element(cps: list[int], i: int) -> int | None:
    """Parse one ZWJ element at ``i``; the index after it, or None."""
    if i >= len(cps) or not is_pictographic(cps[i]):
        return None
    i += 1
    if i < len(cps) and cps[i] in (VS15, VS16):
        i += 1
    if i < len(cps) and cps[i] in MODIFIERS:
        i += 1
        if i < len(cps) and cps[i] == VS16:
            i += 1
    return i


def is_emoji(text: str) -> bool:
    """One emoji (see the module docstring for exactly what that means here)."""
    cps = [ord(ch) for ch in text]
    if not cps:
        return False
    if len(cps) == 2 and all(cp in REGIONAL for cp in cps):
        return True
    if cps[0] in KEYCAP_BASES and cps[-1] == KEYCAP:
        return cps[1:-1] in ([], [VS16])
    if cps[0] == BLACK_FLAG and len(cps) >= 3 and cps[-1] == CANCEL_TAG:
        return all(cp in TAG_SPEC for cp in cps[1:-1])
    i, elements = 0, 0
    while True:
        after = _element(cps, i)
        if after is None:
            return False
        elements += 1
        if after == len(cps):
            return elements <= MAX_ELEMENTS
        if cps[after] != ZWJ:
            return False
        i = after + 1


def clean_reaction_key(value: object) -> str | None:
    """The key as stored, or None when it is not a valid reaction key.

    Keys compare exactly (no normalisation): "❤" and "❤️" are two keys, so a
    client should send what its picker shows, fully qualified (with VS16).
    """
    if not isinstance(value, str) or not value:
        return None
    try:
        size = len(value.encode("utf-8"))
    except UnicodeEncodeError:  # a lone surrogate
        return None
    if size > KEY_MAX_BYTES:
        return None
    if CUSTOM_KEY.fullmatch(value) or is_emoji(value):
        return value
    return None
