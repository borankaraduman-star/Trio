"""``@ad`` and ``@herkes`` in message text (CONTRACT-V6-PUSH §4).

Plain text matching against the CURRENT user names, with the same folding
as name uniqueness (``validation.name_key``: NFKC, Turkish I/ı/İ/i made one
letter, case ignored), done per character so that a match can be mapped back
to the original text (the client emphasises the span; ``web/src/lib/notify/
mentions.ts`` is the same algorithm, and both run the shared cases in
``web/src/lib/notify/mentionCases.json``).

- A mention is ``@`` + a whole name. The character before ``@`` must not be a
  letter, digit, mark or ``_`` (so ``ali@example.com`` mentions nobody), and
  the character after the name must not be one either (``@Alikan`` is not
  ``@Ali``).
- Longer names are matched first and a span is used once: ``@Ali Veli``
  mentions "Ali Veli", not also "Ali".
- ``@herkes`` mentions everybody.
"""

from __future__ import annotations

import unicodedata

EVERYONE = "herkes"


def fold_char(ch: str) -> str:
    """One character folded; may be empty or several characters."""
    out = unicodedata.normalize("NFKC", ch).replace("İ", "i").replace("ı", "i")
    return out.lower().replace("̇", "")


def fold(text: str) -> tuple[str, list[int]]:
    """The folded text and, per folded character, the index of its source character."""
    text = unicodedata.normalize("NFC", text)
    folded: list[str] = []
    origin: list[int] = []
    for index, ch in enumerate(text):
        for out in fold_char(ch):
            folded.append(out)
            origin.append(index)
    return "".join(folded), origin


def _wordish(ch: str) -> bool:
    return ch == "_" or unicodedata.category(ch)[0] in ("L", "N", "M")


def find_mentions(text: str, names: dict[int, str]) -> list[tuple[int, int, int | None]]:
    """``(start, end, user_id)`` spans in the NFC form of ``text``; user_id None = @herkes."""
    folded, origin = fold(text)
    candidates: list[tuple[str, int | None]] = [(fold(n)[0], uid) for uid, n in names.items()]
    candidates.append((EVERYONE, None))
    # Longest first; equal length: the lower id first (deterministic).
    candidates.sort(key=lambda c: (-len(c[0]), -1 if c[1] is None else c[1]))
    taken = [False] * len(folded)
    spans: list[tuple[int, int, int | None]] = []
    for name, uid in candidates:
        if not name:
            continue
        needle = "@" + name
        start = folded.find(needle)
        while start != -1:
            end = start + len(needle)
            before_ok = start == 0 or not _wordish(folded[start - 1])
            after_ok = end == len(folded) or not _wordish(folded[end])
            if before_ok and after_ok and not any(taken[start:end]):
                for i in range(start, end):
                    taken[i] = True
                last = origin[end - 1] + 1
                spans.append((origin[start], last, uid))
            start = folded.find(needle, start + 1)
    spans.sort()
    return spans


def mentioned_users(text: str, names: dict[int, str]) -> tuple[set[int], bool]:
    """Who ``text`` names, and whether it says ``@herkes``."""
    spans = find_mentions(text, names)
    return {uid for _, _, uid in spans if uid is not None}, any(uid is None for *_, uid in spans)
