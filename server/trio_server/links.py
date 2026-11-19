"""Which parts of a message are links: the client's linkify rule, in Python.

The web client turns http(s) addresses in a message into anchors
(``web/src/lib/linkify.ts``); the channel's "Bağlantılar" list must show
exactly those, so this module ports the same rule rather than inventing one:

1. candidates are ``https?://`` followed by anything but whitespace and
   ``< > " ' ``` (case-insensitive scheme), and the character before the
   scheme must not be a letter or digit (``xhttp://`` is not a link);
2. punctuation that belongs to the sentence is cut from the end
   (``trim_trailing``, the same set and the same bracket balancing);
3. what is left must parse as a URL the way the browser's ``new URL`` does
   for the cases that matter here: a non-empty host, a numeric port of at
   most 65535, no forbidden host characters, a valid IPv6 literal, and the
   WHATWG IPv4 rule for hosts that end in a number (``http://a.1`` is not a
   URL, ``http://999`` is).

Whitespace is JavaScript's ``\\s`` (which is not Python's: JS has U+FEFF and
lacks U+001C-U+001F and U+0085). The shared fixture
``shared/linkify-cases.json`` is run by both test suites, so the two
implementations cannot drift apart unnoticed.

Non-ASCII host names are accepted without the full UTS #46 mapping the
browser applies; the only consequence of a disagreement there would be a
link the list shows that the message does not underline, or the reverse.
"""

from __future__ import annotations

import ipaddress
import re
from urllib.parse import unquote_to_bytes

# JavaScript's \s: WhiteSpace + LineTerminator (ECMA-262), not Python's.
_JS_SPACE = "\t\n\v\f\r    -     　﻿"
URL_PATTERN = re.compile(f"https?://[^{_JS_SPACE}<>\"'`]+", re.IGNORECASE)
_WORD_BEFORE = re.compile(r"[A-Za-z0-9]")

TRAILING = frozenset(".,;:!?'\"»”’])}")
_OPENER = {")": "(", "]": "[", "}": "{"}

# WHATWG URL: forbidden host / domain code points.
_FORBIDDEN_HOST = frozenset("\x00\t\n\r #/:<>?@[\\]^|")
_FORBIDDEN_DOMAIN = _FORBIDDEN_HOST | frozenset(chr(c) for c in range(0x20)) | {"%", "\x7f"}

# How many links of one message are kept (a message is at most 4000 characters).
MAX_LINKS_PER_MESSAGE = 50
# A stored link is the text as written; longer ones are not listed.
MAX_LINK_LENGTH = 2048


def trim_trailing(candidate: str) -> str:
    """Cut punctuation that belongs to the sentence, not to the address."""
    counts = {ch: candidate.count(ch) for ch in "()[]{}"}
    end = len(candidate)
    while end > 0:
        last = candidate[end - 1]
        if last not in TRAILING:
            break
        opener = _OPENER.get(last)
        if opener is not None:
            if counts[last] <= counts[opener]:
                break
            counts[last] -= 1
        end -= 1
    return candidate[:end]


def _ipv4_number(part: str) -> int | None:
    """A WHATWG IPv4 number: 0x hex, a leading-zero octal, or decimal."""
    if part == "":
        return None
    radix = 10
    if len(part) >= 2 and part[:2] in ("0x", "0X"):
        part, radix = part[2:], 16
    elif len(part) >= 2 and part[0] == "0":
        part, radix = part[1:], 8
    if part == "":
        return 0
    digits = {10: "0123456789", 8: "01234567", 16: "0123456789abcdefABCDEF"}[radix]
    if any(ch not in digits for ch in part):
        return None
    return int(part, radix)


def _ends_in_number(host: str) -> bool:
    parts = host.split(".")
    if parts[-1] == "" and len(parts) > 1:
        parts.pop()
    last = parts[-1]
    if last != "" and all("0" <= ch <= "9" for ch in last):
        return True
    return _ipv4_number(last) is not None


def _valid_ipv4(host: str) -> bool:
    parts = host.split(".")
    if parts[-1] == "" and len(parts) > 1:
        parts.pop()
    if len(parts) > 4:
        return False
    numbers = [_ipv4_number(part) for part in parts]
    if any(n is None for n in numbers):
        return False
    values = [n for n in numbers if n is not None]
    if any(n > 255 for n in values[:-1]):
        return False
    return values[-1] < 256 ** (5 - len(values))


def _valid_host(raw: str) -> bool:
    if raw == "":
        return False
    if raw.startswith("["):
        if not raw.endswith("]") or "%" in raw:
            return False
        try:
            ipaddress.IPv6Address(raw[1:-1])
        except ValueError:
            return False
        return True
    try:
        host = unquote_to_bytes(raw).decode("utf-8")
    except UnicodeDecodeError:
        return False
    if host == "" or any(ch in _FORBIDDEN_DOMAIN for ch in host):
        return False
    if host.isascii() and _ends_in_number(host.lower()):
        return _valid_ipv4(host)
    return True


def is_url(value: str) -> bool:
    """What the client's ``safeHref`` accepts (``new URL`` succeeds, http(s), a host)."""
    scheme, sep, rest = value.partition(":")
    if not sep or scheme.lower() not in ("http", "https"):
        return False
    rest = rest.lstrip("/\\")
    end = len(rest)
    for i, ch in enumerate(rest):
        if ch in "/\\?#":
            end = i
            break
    authority = rest[:end]
    if "@" in authority:
        authority = authority.rsplit("@", 1)[1]
    # Host and port: a ':' inside an IPv6 literal's brackets is not the port.
    in_brackets = False
    split = -1
    for i, ch in enumerate(authority):
        if ch == "[":
            in_brackets = True
        elif ch == "]":
            in_brackets = False
        elif ch == ":" and not in_brackets:
            split = i
            break
    host, port = (authority, "") if split < 0 else (authority[:split], authority[split + 1 :])
    if port and (not port.isascii() or not port.isdigit() or int(port) > 65535):
        return False
    return _valid_host(host)


def extract_links(text: str) -> list[str]:
    """The links of a message, as written, in order (duplicates kept)."""
    found: list[str] = []
    for match in URL_PATTERN.finditer(text):
        start = match.start()
        if start > 0 and _WORD_BEFORE.match(text[start - 1]):
            continue
        value = trim_trailing(match.group(0))
        if is_url(value):
            found.append(value)
    return found


def links_to_store(text: str) -> list[str]:
    """What the links table keeps for one message: at most 50, each at most 2048 characters."""
    return [v for v in extract_links(text) if len(v) <= MAX_LINK_LENGTH][:MAX_LINKS_PER_MESSAGE]
