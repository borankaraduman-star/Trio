"""CONTRACT-V3 §10: a repeated `message.send` nonce stores nothing twice."""

from __future__ import annotations

from trio_server.nonces import PER_USER_MAX, TTL_SECONDS, NonceCache

from .conftest import quiet
from .test_uploads import PNG, upload

TEXT = 1


def send(sock, content: str, nonce: str | None, **extra):
    frame = {"type": "message.send", "channel_id": TEXT, "content": content, **extra}
    if nonce is not None:
        frame["nonce"] = nonce
    sock.send_json(frame)


def drain_presence(sock, count: int) -> None:
    for _ in range(count):
        assert sock.receive_json()["type"] == "presence"


def listed(trio, user) -> list[dict]:
    return trio.client.get(f"/api/channels/{TEXT}/messages", headers=user["auth"]).json()[
        "messages"
    ]


def test_a_repeated_nonce_is_stored_once_and_answered_to_the_sender_only(trio):
    ali, berk = trio.user("Ali"), trio.user("Berk")
    with trio.ws(ali) as a, trio.ws(ali) as a2, trio.ws(berk) as b:
        drain_presence(a, 1)
        drain_presence(a2, 1)
        send(a, "selam", "n-1")
        first = a.receive_json()
        assert first["nonce"] == "n-1"
        assert a2.receive_json() == first
        assert b.receive_json() == {"type": "message.new", "message": first["message"]}

        # The acknowledgement was "lost": the client retries, from another tab even.
        send(a2, "selam", "n-1")
        again = a2.receive_json()
        assert again == first
        assert a.receive_json() == first
        quiet(b)  # the others hear nothing new
        assert [m["id"] for m in listed(trio, ali)] == [first["message"]["id"]]


def test_a_different_nonce_and_a_missing_nonce_are_new_messages(trio):
    ali = trio.user("Ali")
    with trio.ws(ali) as a:
        send(a, "bir", "n-1")
        one = a.receive_json()["message"]
        send(a, "bir", "n-2")
        two = a.receive_json()["message"]
        send(a, "bir", None)
        three = a.receive_json()["message"]
        send(a, "bir", None)
        four = a.receive_json()["message"]
    assert len({one["id"], two["id"], three["id"], four["id"]}) == 4
    assert len(listed(trio, ali)) == 4


def test_nonces_are_per_user(trio):
    ali, berk = trio.user("Ali"), trio.user("Berk")
    with trio.ws(ali) as a, trio.ws(berk) as b:
        drain_presence(a, 1)
        send(a, "ali", "same")
        from_ali = a.receive_json()["message"]
        assert b.receive_json()["message"] == from_ali
        send(b, "berk", "same")
        from_berk = b.receive_json()["message"]
        assert a.receive_json()["message"] == from_berk
    assert from_ali["id"] != from_berk["id"]
    assert from_berk["author"]["id"] == berk["id"]


def test_a_retry_with_attachments_is_not_invalid_and_keeps_them_on_the_first(trio):
    ali, berk = trio.user("Ali"), trio.user("Berk")
    attachment = upload(trio, ali, PNG, "kedi.png").json()["attachment"]
    with trio.ws(ali) as a, trio.ws(berk) as b:
        drain_presence(a, 1)
        send(a, "", "n-att", attachment_ids=[attachment["id"]])
        first = a.receive_json()
        assert first["type"] == "message.new", first
        assert [att["id"] for att in first["message"]["attachments"]] == [attachment["id"]]
        b.receive_json()
        send(a, "", "n-att", attachment_ids=[attachment["id"]])
        again = a.receive_json()
        assert again == first  # not an INVALID_ATTACHMENT error
        quiet(b)
    messages = listed(trio, ali)
    assert [m["id"] for m in messages] == [first["message"]["id"]]
    assert [att["id"] for att in messages[0]["attachments"]] == [attachment["id"]]


def test_a_nonce_is_forgotten_after_ten_minutes(trio):
    ali = trio.user("Ali")
    with trio.ws(ali) as a:
        send(a, "bir", "n-1")
        first = a.receive_json()["message"]
        trio.clock.value += TTL_SECONDS - 1
        send(a, "bir", "n-1")
        assert a.receive_json()["message"] == first
        trio.clock.value += 2
        send(a, "bir", "n-1")
        later = a.receive_json()["message"]
    assert later["id"] != first["id"]
    assert len(listed(trio, ali)) == 2


def test_a_refused_send_is_not_remembered(trio):
    ali = trio.user("Ali")
    with trio.ws(ali) as a:
        send(a, "", "n-1", attachment_ids=["0" * 32])
        assert a.receive_json()["type"] == "error"
        send(a, "şimdi oldu", "n-1")
        frame = a.receive_json()
        assert frame["type"] == "message.new"
        assert frame["message"]["content"] == "şimdi oldu"


def test_the_cache_is_bounded_per_user_and_expires():
    cache = NonceCache(ttl=10, per_user=3)
    for i in range(5):
        cache.put(1, f"n{i}", {"id": i}, now=float(i))
    assert len(cache) == 3
    assert cache.get(1, "n0", now=5.0) is None
    assert cache.get(1, "n4", now=5.0) == {"id": 4}
    cache.put(2, "n0", {"id": 99}, now=5.0)
    assert cache.get(2, "n0", now=5.0) == {"id": 99}
    # Everything of user 1 was stored at t <= 4: gone at t = 14.5.
    assert cache.get(1, "n4", now=14.5) is None
    assert len(cache) == 1
    assert cache.get(2, "n0", now=15.0) is None
    assert len(cache) == 0


def test_the_default_bounds():
    assert TTL_SECONDS == 600
    assert PER_USER_MAX >= 100
