"""CONTRACT-V4 B: what a reaction key may be."""

from __future__ import annotations

import pytest

from trio_server.emoji import clean_reaction_key, is_emoji

REAL = [
    "👍",
    "😂",
    "❤️",  # VS16
    "❤",  # text-default, as some keyboards send it
    "©️",
    "™",
    "⭐",
    "☕",
    "✅",
    "👍🏽",  # skin tone
    "👋🏿",
    "👩‍💻",  # ZWJ
    "👨‍👩‍👧‍👦",  # family, four elements
    "🧑🏻‍🤝‍🧑🏿",  # ZWJ with skin tones
    "❤️‍🔥",
    "🏳️‍🌈",
    "🏴‍☠️",
    "🇹🇷",  # flag
    "🇺🇳",
    "🏴\U000e0067\U000e0062\U000e0073\U000e0063\U000e0074\U000e007f",  # Scotland
    "1️⃣",
    "#⃣",
    "*️⃣",
    "🫠",  # Unicode 14
    "🫨",  # Unicode 15
    "\U0001fadf",  # reserved in Extended_Pictographic today: newer emoji pass
    "🀄",
    "🅰️",
]

HOSTILE = [
    "",
    "a",
    "A",
    "ğ",
    "1",
    "#",
    "11",
    " ",
    "\t",
    "\n",
    "\x00",
    "\u200d",  # ZWJ alone
    "\ufe0f",  # VS16 alone
    "\U0001f3fd",  # a skin tone alone
    "👍\u200d",  # dangling ZWJ
    "\u200d👍",
    "👍👍",  # two emoji
    "🇹",  # half a flag
    "🇹🇷🇹",
    "👍 ",
    " 👍",
    "👍a",
    "\u202e👍",  # bidi override
    "\ue000",  # private use
    "\ufffd",
    "\ud83d",  # lone surrogate
    "\ud83d\udc4d",  # a surrogate pair as two Python code points
    "1\u20e3\u20e3",
    "🏴\U000e0067",  # tag sequence without cancel
    "\U000e007f",
    "👍" + "\u200d👍" * 10,  # eleven elements
    "<script>",
    "::",
    ":a:b:",
]


@pytest.mark.parametrize("key", REAL)
def test_real_emoji_are_keys(key):
    assert clean_reaction_key(key) == key


@pytest.mark.parametrize("key", HOSTILE)
def test_everything_else_is_not(key):
    assert clean_reaction_key(key) is None


@pytest.mark.parametrize("key", [":a:", ":parrot:", ":x_1:", ":" + "z" * 32 + ":"])
def test_custom_names(key):
    assert clean_reaction_key(key) == key


@pytest.mark.parametrize(
    "key", [":A:", ":" + "z" * 33 + ":", ":ğ:", ":a:\n", ":a b:", "parrot", ":parrot"]
)
def test_bad_custom_names(key):
    assert clean_reaction_key(key) is None


def test_the_byte_limit_is_sixty_four():
    family = "👨‍👩‍👧‍👦"  # 25 bytes
    assert is_emoji(family + "\u200d" + family)  # 51 bytes, 8 elements
    long = "\u200d".join(["👨"] * 10)  # 10 elements, 67 bytes
    assert is_emoji(long)
    assert clean_reaction_key(long) is None


@pytest.mark.parametrize("value", [None, 1, ["👍"], b"\xf0\x9f\x91\x8d"])
def test_not_a_string(value):
    assert clean_reaction_key(value) is None
