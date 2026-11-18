"""One-time codes that sign a second device in as an EXISTING user (CONTRACT-V3 §2).

A code is shown on a device that is already signed in and typed on the new
one, so it is short and made of characters that cannot be mistaken for each
other: no 0/O, 1/I/L. Only its SHA-256 is stored, and a code is looked up by
that hash, so no secret is ever compared character by character in Python.
"""

from __future__ import annotations

import hashlib
import secrets
from typing import Any

# 31 symbols; 10 of them are ~49.5 bits. A code lives 10 minutes and the
# global failure ceiling allows at most ~90 checked guesses per 10 minutes.
ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"
CODE_LENGTH = 10
TTL_SECONDS = 10 * 60
MAX_LIVE_PER_USER = 5
# Room for separators people add when typing ("ABCDE-FGHJK", spaces).
INPUT_MAX = 64


def new_code() -> str:
    return "".join(secrets.choice(ALPHABET) for _ in range(CODE_LENGTH))


def normalize(raw: Any) -> str | None:
    """What a typed code means: case, spaces and dashes ignored. None if it cannot be one."""
    if not isinstance(raw, str) or len(raw) > INPUT_MAX:
        return None
    code = "".join(ch for ch in raw.upper() if ch not in " -\t")
    if len(code) != CODE_LENGTH or any(ch not in ALPHABET for ch in code):
        return None
    return code


def hash_code(code: str) -> str:
    return hashlib.sha256(("trio-link:" + code).encode("ascii")).hexdigest()
