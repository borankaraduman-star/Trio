"""Field rules shared by the REST routes and the websocket."""

from __future__ import annotations

import unicodedata
from typing import Any

NAME_MAX = 32
CONTENT_MAX = 4000
CHANNEL_KINDS = ("text", "voice")


# Ids are SQLite INTEGERs: signed 64-bit. A larger value can be neither stored
# nor looked up (sqlite3 raises OverflowError), so it is no id at all.
ID_MAX = 2**63 - 1


def is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and -ID_MAX <= value <= ID_MAX


def clean_name(value: Any) -> str | None:
    """A user or channel name: trimmed, 1-32 characters, one line of visible text."""
    if not isinstance(value, str):
        return None
    name = unicodedata.normalize("NFC", value).strip()
    if not 1 <= len(name) <= NAME_MAX:
        return None
    # Control and format characters (newlines, NUL, bidi overrides, zero-width
    # marks) would let one name pass for another in the member list.
    if any(unicodedata.category(ch) in ("Cc", "Cf", "Cs", "Zl", "Zp") for ch in name):
        return None
    return name


def name_key(name: str) -> str:
    """What "the same name, ignoring case" compares.

    The UI is Turkish, where I/ı and İ/i are case pairs that Unicode's
    locale-free casefold does not join ("IŞIL" would not match "Işıl"), so
    all four are made one letter first.
    """
    folded = unicodedata.normalize("NFKC", name).replace("İ", "i").replace("ı", "i")
    return unicodedata.normalize("NFKC", folded.casefold()).replace("i̇", "i")


def clean_content(value: Any) -> str | None:
    if not isinstance(value, str) or "\x00" in value:
        return None
    content = value.strip()
    if not 1 <= len(content) <= CONTENT_MAX:
        return None
    return content
