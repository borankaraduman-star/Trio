"""CONTRACT-V4 B: edit, delete, reactions, reply, pins."""

from __future__ import annotations

import os
from urllib.parse import quote

import pytest

from trio_server.message_routes import EDIT_LIMIT, MAX_PINS, MAX_REACTION_KEYS, REACTION_LIMIT

from .conftest import quiet
from .test_uploads import PNG, upload, upload_dir
from .test_ws import expect, expect_error

TEXT = 1


def code(response) -> str:
    return response.json()["error"]["code"]


def send(sock, content: str = "selam", channel_id: int = TEXT, **extra) -> dict:
    sock.send_json({"type": "message.send", "channel_id": channel_id, "content": content, **extra})
    frame = sock.receive_json()
    assert frame["type"] == "message.new", frame
    return frame["message"]


def react(trio, user, message_id, key, method="put"):
    url = f"/api/messages/{message_id}/reactions/{quote(key, safe='')}"
    return getattr(trio.client, method)(url, headers=user["auth"])


def listed(trio, user, channel_id=TEXT) -> list[dict]:
    return trio.client.get(f"/api/channels/{channel_id}/messages", headers=user["auth"]).json()[
        "messages"
    ]


@pytest.fixture
def pair(trio):
    return trio.user("Ali"), trio.user("Berk")


# -- edit -----------------------------------------------------------------------------


def test_the_author_edits_and_everybody_hears_it(trio, pair):
    ali, berk = pair
    with trio.ws(ali) as a, trio.ws(berk) as b:
        expect(a, "presence")
        message = send(a, "ilk hali")
        expect(b, "message.new")
        trio.clock.value += 5
        response = trio.client.patch(
            f"/api/messages/{message['id']}", json={"content": "  yeni hali "}, headers=ali["auth"]
        )
        assert response.status_code == 200, response.text
        edited = response.json()["message"]
        assert edited["content"] == "yeni hali"
        assert edited["edited_at"] == "2027-01-15T08:00:05.000Z"
        assert edited["rev"] == 1
        assert edited["created_at"] == message["created_at"]
        # The author's own sockets get the broadcast too, without a nonce.
        for sock in (a, b):
            assert sock.receive_json() == {"type": "message.updated", "message": edited}
        assert listed(trio, berk)[0] == edited
        # The same content again changes nothing and broadcasts nothing.
        again = trio.client.patch(
            f"/api/messages/{message['id']}", json={"content": "yeni hali"}, headers=ali["auth"]
        )
        assert again.json()["message"] == edited
        quiet(a)
        quiet(b)


def test_only_the_author_edits_and_bad_edits_are_refused(trio, pair):
    ali, berk = pair
    with trio.ws(ali) as a:
        message = send(a, "benim")
    url = f"/api/messages/{message['id']}"
    assert code(trio.client.patch(url, json={"content": "x"}, headers=berk["auth"])) == "FORBIDDEN"
    for body in ({"content": ""}, {"content": "   "}, {"content": 5}, {}, {"content": "a\x00"}):
        response = trio.client.patch(url, json=body, headers=ali["auth"])
        assert response.status_code == 422 and code(response) == "INVALID_MESSAGE", body
    response = trio.client.patch(url, json={"content": "x" * 4001}, headers=ali["auth"])
    assert code(response) == "INVALID_MESSAGE"
    assert (
        trio.client.patch(url, json={"content": "é" * 4000}, headers=ali["auth"]).status_code == 200
    )
    for missing in ("/api/messages/999", "/api/messages/0", f"/api/messages/{2**63}"):
        response = trio.client.patch(missing, json={"content": "x"}, headers=ali["auth"])
        assert response.status_code in (404, 422), missing
    assert (
        code(trio.client.patch("/api/messages/999", json={"content": "x"}, headers=ali["auth"]))
        == "NOT_FOUND"
    )
    assert trio.client.patch(url, json={"content": "x"}).status_code == 401
    response = trio.client.patch(
        url,
        content=b'{"content": "\\ud800"}',
        headers={**ali["auth"], "Content-Type": "application/json"},
    )
    assert response.status_code == 422 and code(response) == "INVALID_REQUEST"
    assert listed(trio, ali)[0]["content"] == "é" * 4000


def test_an_attachment_message_may_be_edited_to_empty_content(trio, pair):
    ali, _ = pair
    attachment = upload(trio, ali, PNG, "kedi.png").json()["attachment"]
    with trio.ws(ali) as a:
        message = send(a, "açıklama", attachment_ids=[attachment["id"]])
    response = trio.client.patch(
        f"/api/messages/{message['id']}", json={"content": ""}, headers=ali["auth"]
    )
    assert response.status_code == 200
    assert response.json()["message"]["content"] == ""
    assert response.json()["message"]["attachments"] == [attachment]


# -- delete ---------------------------------------------------------------------------


def test_delete_removes_the_row_its_files_and_returns_the_quota(make_trio):
    trio = make_trio(user_quota_mb=1, max_upload_mb=1)
    ali, berk = trio.user("Ali"), trio.user("Berk")
    big = PNG + b"\x00" * (700 * 1024)
    first = upload(trio, ali, big, "a.png").json()["attachment"]
    with trio.ws(ali) as a, trio.ws(berk) as b:
        expect(a, "presence")
        message = send(a, "", attachment_ids=[first["id"]])
        expect(b, "message.new")
        reply = send(a, "cevap", reply_to=message["id"])
        expect(b, "message.new")
        # Over quota while the first file is kept.
        assert code(upload(trio, ali, big, "b.png")) == "QUOTA_EXCEEDED"
        assert react(trio, berk, message["id"], "👍").status_code == 200
        assert (
            trio.client.put(f"/api/messages/{message['id']}/pin", headers=berk["auth"]).status_code
            == 200
        )
        for sock in (a, b):
            expect(sock, "message.updated")
            expect(sock, "message.updated")
        # Only the author.
        response = trio.client.delete(f"/api/messages/{message['id']}", headers=berk["auth"])
        assert code(response) == "FORBIDDEN"
        response = trio.client.delete(f"/api/messages/{message['id']}", headers=ali["auth"])
        assert response.status_code == 204 and response.content == b""
        deleted = {"type": "message.deleted", "channel_id": TEXT, "message_id": message["id"]}
        assert a.receive_json() == deleted
        assert b.receive_json() == deleted
        quiet(a)
    assert first["id"] not in os.listdir(upload_dir(trio))
    assert trio.client.get(first["url"]).status_code == 404
    assert trio.client.get(f"/api/channels/{TEXT}/pins", headers=ali["auth"]).json() == {
        "messages": []
    }
    # The reply now names a deleted message.
    (left,) = listed(trio, ali)
    assert left["id"] == reply["id"]
    assert left["reply_to"] == {"id": message["id"], "deleted": True}
    # The bytes came back.
    assert upload(trio, ali, big, "b.png").status_code == 201
    # Deleting twice is a 404.
    response = trio.client.delete(f"/api/messages/{message['id']}", headers=ali["auth"])
    assert code(response) == "NOT_FOUND"


def test_files_left_by_a_crash_between_commit_and_unlink_are_swept_at_start(make_trio, tmp_path):
    db, uploads = str(tmp_path / "keep.db"), tmp_path / "keep-up"
    trio = make_trio(db_path=db, upload_dir=str(uploads))
    ali = trio.user("Ali")
    kept = upload(trio, ali, PNG, "kept.png").json()["attachment"]
    orphan = upload(trio, ali, PNG, "o.png").json()["attachment"]
    # A crash after the rows went and before the unlink: the row is gone, the file stays.
    trio.client.portal.call(trio.client.app.state.db.delete_attachments, [orphan["id"]])
    (uploads / "notes.txt").write_text("not ours")
    (uploads / "avatars").mkdir(exist_ok=True)
    assert orphan["id"] in os.listdir(uploads)
    trio.client.__exit__(None, None, None)
    again = make_trio(db_path=db, upload_dir=str(uploads))
    names = os.listdir(uploads)
    assert orphan["id"] not in names
    assert kept["id"] in names and "notes.txt" in names and "avatars" in names
    assert again.client.get(kept["url"]).content == PNG


# -- reactions ------------------------------------------------------------------------


def test_reactions_are_idempotent_ordered_and_only_your_own_comes_off(trio, pair):
    ali, berk = pair
    with trio.ws(ali) as a, trio.ws(berk) as b:
        expect(a, "presence")
        message = send(a)
        expect(b, "message.new")
        mid = message["id"]
        assert react(trio, berk, mid, "👍").json()["message"]["reactions"] == [
            {"key": "👍", "count": 1, "user_ids": [berk["id"]]}
        ]
        react(trio, ali, mid, "🎉")
        response = react(trio, ali, mid, "👍")
        reactions = response.json()["message"]["reactions"]
        assert reactions == [
            {"key": "👍", "count": 2, "user_ids": [berk["id"], ali["id"]]},
            {"key": "🎉", "count": 1, "user_ids": [ali["id"]]},
        ]
        assert response.json()["message"]["rev"] == 3
        for sock in (a, b):
            for _ in range(3):
                expect(sock, "message.updated")
        # Idempotent both ways: no change, no broadcast, same rev.
        assert react(trio, ali, mid, "👍").json()["message"]["rev"] == 3
        assert react(trio, berk, mid, "🎉", "delete").json()["message"]["rev"] == 3
        quiet(a)
        quiet(b)
        # Removing only takes the caller's own.
        after = react(trio, berk, mid, "👍", "delete").json()["message"]
        # Order is by each key's earliest REMAINING reaction: Ali's 👍 came after 🎉.
        assert after["reactions"] == [
            {"key": "🎉", "count": 1, "user_ids": [ali["id"]]},
            {"key": "👍", "count": 1, "user_ids": [ali["id"]]},
        ]
        assert expect(b, "message.updated")["message"] == after
        # A key that empties goes; coming back puts it last.
        react(trio, ali, mid, "👍", "delete")
        assert [r["key"] for r in react(trio, ali, mid, "👍").json()["message"]["reactions"]] == [
            "🎉",
            "👍",
        ]
        custom = react(trio, berk, mid, ":parrot_2:")
        assert custom.status_code == 200
    assert [r["key"] for r in listed(trio, ali)[0]["reactions"]] == ["🎉", "👍", ":parrot_2:"]


def test_at_most_twenty_reaction_keys(trio, pair):
    ali, berk = pair
    with trio.ws(ali) as a:
        mid = send(a)["id"]
    keys = [chr(0x1F600 + i) for i in range(MAX_REACTION_KEYS)]
    for key in keys:
        assert react(trio, ali, mid, key).status_code == 200
    response = react(trio, ali, mid, "🐈")
    assert response.status_code == 409 and code(response) == "REACTION_LIMIT"
    # An existing key can still gain people.
    assert react(trio, berk, mid, keys[0]).status_code == 200


@pytest.mark.parametrize(
    "key",
    ["a", "1", "ab", " ", "👍 ", ":Parrot:", ":" + "a" * 33 + ":", "‍", "👍👍", "�"],
)
def test_a_reaction_key_must_be_one_emoji_or_a_name(trio, pair, key):
    ali, _ = pair
    with trio.ws(ali) as a:
        mid = send(a)["id"]
    response = react(trio, ali, mid, key)
    assert response.status_code == 422 and code(response) == "INVALID_REACTION"


def test_hostile_reaction_paths_never_500(trio, pair):
    ali, _ = pair
    with trio.ws(ali) as a:
        mid = send(a)["id"]
    for raw in ("%ED%A0%80", "%FF", "%00", "%F0%9F%91", "%E2%80%AE", "x" * 300, "%25"):
        response = trio.client.put(f"/api/messages/{mid}/reactions/{raw}", headers=ali["auth"])
        assert response.status_code in (404, 422), (raw, response.status_code)
    response = react(trio, ali, 999, "👍")
    assert response.status_code == 404 and code(response) == "NOT_FOUND"
    response = trio.client.put(f"/api/messages/{mid}/reactions/%F0%9F%91%8D")
    assert response.status_code == 401


# -- reply ----------------------------------------------------------------------------


def test_a_reply_carries_its_target_resolved_at_read_time(trio, pair):
    ali, berk = pair
    other = trio.client.post(
        "/api/channels", json={"name": "diğer", "kind": "text"}, headers=ali["auth"]
    ).json()["channel"]["id"]
    attachment = upload(trio, berk, PNG, "foto.png").json()["attachment"]
    with trio.ws(ali) as a, trio.ws(berk) as b:
        expect(a, "presence")
        long = send(a, "x" * 200)
        expect(b, "message.new")
        photo = send(b, "", attachment_ids=[attachment["id"]])
        expect(a, "message.new")
        reply = send(b, "evet", reply_to=long["id"])
        assert reply["reply_to"] == {
            "id": long["id"],
            "author": {"id": ali["id"], "name": "Ali"},
            "excerpt": "x" * 140,
        }
        assert expect(a, "message.new")["message"]["reply_to"] == reply["reply_to"]
        to_photo = send(a, "güzel", reply_to=photo["id"])
        expect(b, "message.new")
        assert to_photo["reply_to"]["excerpt"] == "📎 foto.png"
        for bad, error in ((999, "INVALID_REPLY"), ("1", "BAD_REQUEST"), (2**64, "BAD_REQUEST")):
            a.send_json(
                {"type": "message.send", "channel_id": TEXT, "content": "x", "reply_to": bad}
            )
            expect_error(a, error)
        # Another channel's message is not a valid target.
        a.send_json(
            {"type": "message.send", "channel_id": other, "content": "x", "reply_to": long["id"]}
        )
        expect_error(a, "INVALID_REPLY")
        a.send_json({"type": "message.send", "channel_id": TEXT, "content": "x", "reply_to": None})
        assert expect(a, "message.new")["message"]["reply_to"] is None
        expect(b, "message.new")
        # Edited target: the reply shows the new text on the next read.
        trio.client.patch(
            f"/api/messages/{long['id']}", json={"content": "kısa"}, headers=ali["auth"]
        )
    by_id = {m["id"]: m for m in listed(trio, ali)}
    assert by_id[reply["id"]]["reply_to"]["excerpt"] == "kısa"


# -- pins -----------------------------------------------------------------------------


def test_anyone_pins_and_unpins_newest_pin_first(trio, pair):
    ali, berk = pair
    with trio.ws(ali) as a, trio.ws(berk) as b:
        expect(a, "presence")
        one, two = send(a, "bir"), send(a, "iki")
        expect(b, "message.new")
        expect(b, "message.new")
        trio.clock.value += 60
        response = trio.client.put(f"/api/messages/{two['id']}/pin", headers=berk["auth"])
        pinned = response.json()["message"]
        assert pinned["pinned_by"] == berk["id"]
        assert pinned["pinned_at"] == "2027-01-15T08:01:00.000Z"
        for sock in (a, b):
            assert sock.receive_json() == {"type": "message.updated", "message": pinned}
        trio.client.put(f"/api/messages/{one['id']}/pin", headers=ali["auth"])
        # Pinning again keeps the first pinner, and says nothing.
        again = trio.client.put(f"/api/messages/{two['id']}/pin", headers=ali["auth"])
        assert again.json()["message"]["pinned_by"] == berk["id"]
        pins = trio.client.get(f"/api/channels/{TEXT}/pins", headers=ali["auth"]).json()
        assert [m["id"] for m in pins["messages"]] == [one["id"], two["id"]]
        unpinned = trio.client.delete(f"/api/messages/{two['id']}/pin", headers=ali["auth"])
        assert unpinned.json()["message"]["pinned_at"] is None
        assert unpinned.json()["message"]["pinned_by"] is None
    pins = trio.client.get(f"/api/channels/{TEXT}/pins", headers=ali["auth"]).json()
    assert [m["id"] for m in pins["messages"]] == [one["id"]]
    voice = trio.client.get("/api/channels/2/pins", headers=ali["auth"])
    assert voice.status_code == 404 and code(voice) == "NOT_FOUND"
    assert trio.client.get("/api/channels/99/pins", headers=ali["auth"]).status_code == 404


def test_at_most_fifty_pins_per_channel(trio, pair):
    ali, _ = pair
    trio.client.app.state.message_limits["edits"]._limit = 10_000
    with trio.ws(ali) as a:
        ids = [send(a, f"m{i}")["id"] for i in range(MAX_PINS + 1)]
    for mid in ids[:MAX_PINS]:
        assert trio.client.put(f"/api/messages/{mid}/pin", headers=ali["auth"]).status_code == 200
    response = trio.client.put(f"/api/messages/{ids[-1]}/pin", headers=ali["auth"])
    assert response.status_code == 409 and code(response) == "PIN_LIMIT"
    trio.client.delete(f"/api/messages/{ids[0]}/pin", headers=ali["auth"])
    assert trio.client.put(f"/api/messages/{ids[-1]}/pin", headers=ali["auth"]).status_code == 200


# -- rate limits ----------------------------------------------------------------------


def test_edits_deletes_and_pins_share_thirty_a_minute(trio, pair):
    ali, berk = pair
    with trio.ws(ali) as a:
        mid = send(a)["id"]
    for i in range(EDIT_LIMIT):
        response = trio.client.patch(
            f"/api/messages/{mid}", json={"content": f"v{i}"}, headers=ali["auth"]
        )
        assert response.status_code == 200
    for request in (
        lambda: trio.client.patch(
            f"/api/messages/{mid}", json={"content": "z"}, headers=ali["auth"]
        ),
        lambda: trio.client.delete(f"/api/messages/{mid}", headers=ali["auth"]),
        lambda: trio.client.put(f"/api/messages/{mid}/pin", headers=ali["auth"]),
    ):
        response = request()
        assert response.status_code == 429 and code(response) == "RATE_LIMITED"
    # Per user; reactions have their own budget.
    assert trio.client.put(f"/api/messages/{mid}/pin", headers=berk["auth"]).status_code == 200
    assert react(trio, ali, mid, "👍").status_code == 200
    trio.clock.value += 61
    assert trio.client.delete(f"/api/messages/{mid}", headers=ali["auth"]).status_code == 204


def test_reactions_have_one_hundred_and_twenty_a_minute(trio, pair):
    ali, _ = pair
    with trio.ws(ali) as a:
        mid = send(a)["id"]
    for i in range(REACTION_LIMIT):
        assert react(trio, ali, mid, "👍", "put" if i % 2 == 0 else "delete").status_code == 200
    response = react(trio, ali, mid, "👍")
    assert response.status_code == 429 and code(response) == "RATE_LIMITED"
    trio.clock.value += 61
    assert react(trio, ali, mid, "👍").status_code == 200
