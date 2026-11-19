"""CONTRACT-V7-READING: read state per user and channel, channel rename and delete."""

from __future__ import annotations

import sqlite3

from starlette.testclient import TestClient

from trio_server import Settings, create_app

from .conftest import INVITE, quiet
from .test_uploads import PNG, stored_files, upload
from .test_v4_upgrade import build_v3


def send(sock, channel_id: int, content: str, nonce: str) -> int:
    sock.send_json(
        {"type": "message.send", "channel_id": channel_id, "content": content, "nonce": nonce}
    )
    while True:
        frame = sock.receive_json()
        if frame["type"] == "message.new" and frame.get("nonce") == nonce:
            return frame["message"]["id"]


def next_of(sock, kind: str) -> dict:
    while True:
        frame = sock.receive_json()
        if frame["type"] == kind:
            return frame


def drain_message(sock) -> dict:
    while True:
        frame = sock.receive_json()
        if frame["type"] == "message.new":
            return frame["message"]


# -- read state ------------------------------------------------------------------


def test_a_new_account_starts_with_everything_read(trio):
    text = trio.channel_id("text")
    ali = trio.user("Ali")
    with trio.ws(ali) as a:
        assert a.ready["read_state"] == {str(text): {"last_read": 0, "latest": 0, "unread": 0}}
        first = send(a, text, "merhaba", "n1")
        second = send(a, text, "orada mısın", "n2")
    berk = trio.user("Berk")
    with trio.ws(berk) as b:
        # Berk arrived after both messages: history, not unread.
        assert b.ready["read_state"][str(text)] == {
            "last_read": second,
            "latest": second,
            "unread": 0,
        }
    with trio.ws(ali) as a:
        # Ali never sent channel.read, but his own messages are never unread.
        assert a.ready["read_state"][str(text)] == {"last_read": 0, "latest": second, "unread": 0}
        assert first < second


def test_unread_counts_others_and_channel_read_moves_forward_only(trio):
    text = trio.channel_id("text")
    ali, berk, cem = trio.user("Ali"), trio.user("Berk"), trio.user("Cem")
    with trio.ws(ali) as a:
        ids = [send(a, text, f"m{i}", f"n{i}") for i in range(3)]
    with trio.ws(berk) as phone, trio.ws(berk) as desk, trio.ws(cem) as c:
        assert phone.ready["read_state"][str(text)] == {
            "last_read": 0,
            "latest": ids[2],
            "unread": 3,
        }
        phone.send_json({"type": "channel.read", "channel_id": text, "message_id": ids[0]})
        # The OTHER device of the same user is told; the sender is not.
        assert next_of(desk, "channel.read") == {
            "type": "channel.read",
            "channel_id": text,
            "message_id": ids[0],
            "unread": 2,
        }
        next_of(phone, "presence")  # Cem came online
        quiet(phone)
        quiet(c)  # nobody else learns anything (no read receipts)
        # Backwards or the same: nothing changes, nothing is sent.
        phone.send_json({"type": "channel.read", "channel_id": text, "message_id": ids[0]})
        desk.send_json({"type": "channel.read", "channel_id": text, "message_id": 1})
        quiet(desk)
        quiet(phone)
        # Past the newest message: lowered to it.
        desk.send_json({"type": "channel.read", "channel_id": text, "message_id": ids[2] + 999})
        assert phone.receive_json() == {
            "type": "channel.read",
            "channel_id": text,
            "message_id": ids[2],
            "unread": 0,
        }
        quiet(desk)
    with trio.ws(berk) as again:
        assert again.ready["read_state"][str(text)] == {
            "last_read": ids[2],
            "latest": ids[2],
            "unread": 0,
        }


def test_unread_is_capped(trio):
    text = trio.channel_id("text")
    berk = trio.user("Berk")
    ali = trio.user("Ali")
    with trio.ws(ali) as a:
        for i in range(105):
            send(a, text, f"m{i}", f"n{i}")
    db = sqlite3.connect(trio.client.app.state.settings.db_path)
    db.execute("DELETE FROM read_state WHERE user_id = ?", (berk["id"],))
    db.commit()
    db.close()
    with trio.ws(berk) as b:
        assert b.ready["read_state"][str(text)]["unread"] == 100


def test_channel_read_refusals(trio):
    text, voice = trio.channel_id("text"), trio.channel_id("voice")
    ali = trio.user("Ali")
    with trio.ws(ali) as a:
        for frame, code in (
            ({"channel_id": voice, "message_id": 1}, "INVALID_CHANNEL"),
            ({"channel_id": 999, "message_id": 1}, "INVALID_CHANNEL"),
            ({"channel_id": text, "message_id": "1"}, "BAD_REQUEST"),
            ({"channel_id": text, "message_id": 0}, "BAD_REQUEST"),
            ({"channel_id": text, "message_id": True}, "BAD_REQUEST"),
        ):
            a.send_json({"type": "channel.read", **frame})
            reply = a.receive_json()
            assert reply["type"] == "error" and reply["code"] == code, frame


def test_channel_read_is_rate_limited(trio):
    text = trio.channel_id("text")
    ali = trio.user("Ali")
    with trio.ws(ali) as a:
        for _ in range(120):
            a.send_json({"type": "channel.read", "channel_id": text, "message_id": 1})
        quiet(a)
        a.send_json({"type": "channel.read", "channel_id": text, "message_id": 1})
        reply = a.receive_json()
        assert reply["code"] == "RATE_LIMITED" and reply["request"] == "channel.read"


def test_read_state_survives_a_restart(make_trio, tmp_path):
    first = make_trio(db_path=str(tmp_path / "keep.db"))
    text = first.channel_id("text")
    berk = first.user("Berk")
    ali = first.user("Ali")
    with first.ws(ali) as a:
        ids = [send(a, text, f"m{i}", f"n{i}") for i in range(2)]
    with first.ws(berk) as b:
        b.send_json({"type": "channel.read", "channel_id": text, "message_id": ids[0]})
        quiet(b)
    second = make_trio(db_path=str(tmp_path / "keep.db"))
    with second.ws(berk) as b:
        assert b.ready["read_state"][str(text)] == {
            "last_read": ids[0],
            "latest": ids[1],
            "unread": 1,
        }


def test_an_older_database_gains_read_state_on_boot(tmp_path):
    """Starts from the shape before V7 (no read_state table at all)."""
    path, uploads = build_v3(tmp_path)
    con = sqlite3.connect(path)
    assert not con.execute("SELECT name FROM sqlite_master WHERE name = 'read_state'").fetchall()
    con.close()
    settings = Settings(invite_code=INVITE, db_path=str(path), upload_dir=str(uploads))
    with TestClient(create_app(settings)) as client:
        with client.websocket_connect("/ws?token=tok-berk") as sock:
            ready = sock.receive_json()
            # Nothing stored yet: the client's own memory decides (§3); Ali wrote both.
            assert ready["read_state"]["1"] == {"last_read": 0, "latest": 2, "unread": 2}
            sock.send_json({"type": "channel.read", "channel_id": 1, "message_id": 1})
            quiet(sock)
        with client.websocket_connect("/ws?token=tok-berk") as sock:
            assert sock.receive_json()["read_state"]["1"] == {
                "last_read": 1,
                "latest": 2,
                "unread": 1,
            }


# -- rename ------------------------------------------------------------------------


def test_any_member_renames_a_channel_and_everyone_sees_it(trio):
    text = trio.channel_id("text")
    ali, berk = trio.user("Ali"), trio.user("Berk")
    with trio.ws(ali) as a:
        response = trio.client.patch(
            f"/api/channels/{text}", json={"name": "  sohbet-odasi "}, headers=berk["auth"]
        )
        assert response.status_code == 200
        assert response.json() == {"channel": {"id": text, "name": "sohbet-odasi", "kind": "text"}}
        assert a.receive_json() == {
            "type": "channel.updated",
            "channel": response.json()["channel"],
        }
        # The same name again: no broadcast.
        trio.client.patch(
            f"/api/channels/{text}", json={"name": "sohbet-odasi"}, headers=berk["auth"]
        )
        quiet(a)
    assert trio.client.get("/api/channels", headers=ali["auth"]).json()["channels"][0]["name"] == (
        "sohbet-odasi"
    )
    assert (
        trio.client.patch(f"/api/channels/{text}", json={"name": ""}, headers=ali["auth"]).json()[
            "error"
        ]["code"]
        == "INVALID_CHANNEL"
    )
    missing = trio.client.patch("/api/channels/999", json={"name": "x"}, headers=ali["auth"])
    assert missing.status_code == 404
    assert trio.client.patch(f"/api/channels/{text}", json={"name": "x"}).status_code == 401


# -- delete ------------------------------------------------------------------------


def delete(trio, user, channel_id: int, confirm: str | None):
    body = {} if confirm is None else {"confirm_name": confirm}
    return trio.client.request(
        "DELETE", f"/api/channels/{channel_id}", json=body, headers=user["auth"]
    )


def test_deleting_a_text_channel_takes_everything_that_hangs_off_it(trio):
    general = trio.channel_id("text")
    ali, berk = trio.user("Ali"), trio.user("Berk")  # Ali: lowest id, the owner
    extra = trio.client.post(
        "/api/channels", json={"name": "fotolar", "kind": "text"}, headers=ali["auth"]
    ).json()["channel"]["id"]
    attachment = upload(trio, berk, PNG, "kedi.png").json()["attachment"]["id"]
    trio.client.put(
        "/api/push/prefs", json={"channels": {str(extra): "none"}}, headers=berk["auth"]
    )
    with trio.ws(berk) as b:
        b.send_json(
            {
                "type": "message.send",
                "channel_id": extra,
                "content": "bak",
                "nonce": "p1",
                "attachment_ids": [attachment],
            }
        )
        message = drain_message(b)
        b.send_json({"type": "channel.read", "channel_id": extra, "message_id": message["id"]})
        quiet(b)
        assert attachment in stored_files(trio)

        assert delete(trio, berk, extra, "fotolar").status_code == 403  # not the owner
        assert delete(trio, ali, extra, "FOTOLAR").json()["error"]["code"] == "CONFIRM_MISMATCH"
        assert delete(trio, ali, extra, None).json()["error"]["code"] == "CONFIRM_MISMATCH"
        assert delete(trio, ali, extra, "fotolar").status_code == 204
        assert b.receive_json() == {"type": "channel.deleted", "channel_id": extra}

    assert attachment not in stored_files(trio)
    assert (
        trio.client.get(f"/api/channels/{extra}/messages", headers=ali["auth"]).status_code == 404
    )
    assert (
        trio.client.get("/api/push/prefs", headers=berk["auth"]).json()["prefs"]["channels"] == {}
    )
    db = sqlite3.connect(trio.client.app.state.settings.db_path)
    for table, column in (
        ("messages", "channel_id"),
        ("read_state", "channel_id"),
        ("links", "channel_id"),
        ("pins", "channel_id"),
    ):
        count = db.execute(f"SELECT count(*) FROM {table} WHERE {column} = ?", (extra,)).fetchone()  # noqa: S608
        assert count == (0,), table
    assert db.execute("SELECT count(*) FROM attachments").fetchone() == (0,)
    assert db.execute("SELECT data FROM push_prefs").fetchone()[0].startswith('{"channels":{}')
    db.close()
    # The last text channel stays.
    last = delete(trio, ali, general, "genel")
    assert last.status_code == 409 and last.json()["error"]["code"] == "LAST_TEXT_CHANNEL"
    assert delete(trio, ali, 999, "x").status_code == 404


def test_a_voice_channel_in_use_cannot_be_deleted(trio):
    voice = trio.channel_id("voice")
    ali, berk = trio.user("Ali"), trio.user("Berk")
    with trio.ws(berk) as b:
        b.send_json({"type": "voice.join", "channel_id": voice})
        assert b.receive_json()["type"] == "voice.peers"
        busy = delete(trio, ali, voice, "Sohbet")
        assert busy.status_code == 409 and busy.json()["error"]["code"] == "CHANNEL_IN_USE"
        b.send_json({"type": "voice.leave"})
        next_of(b, "voice.left")
    assert delete(trio, ali, voice, "Sohbet").status_code == 204
    assert all(c["kind"] == "text" for c in trio.client.app.state.hub.channels.values())
