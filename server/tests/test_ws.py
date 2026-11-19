from __future__ import annotations

import json

import pytest
from starlette.websockets import WebSocketDisconnect

from .conftest import quiet

TEXT = 1  # the seeded "genel"
VOICE = 2  # the seeded "Sohbet"


def expect(sock, frame_type: str) -> dict:
    frame = sock.receive_json()
    assert frame["type"] == frame_type, frame
    return frame


def expect_error(sock, code: str) -> dict:
    frame = expect(sock, "error")
    # `to` (a refused signal, V3 §6) and `request` (a refused ring, V4 A4) are
    # the only extras an error frame carries.
    assert set(frame) - {"to", "request"} == {"type", "code", "message"}
    assert frame["code"] == code
    return frame


@pytest.fixture
def three(trio):
    return trio.user("Ali"), trio.user("Berk"), trio.user("Cem")


def new_voice_channel(trio, user, name: str = "oyun") -> int:
    response = trio.client.post(
        "/api/channels", json={"name": name, "kind": "voice"}, headers=user["auth"]
    )
    return response.json()["channel"]["id"]


# -- connecting ---------------------------------------------------------------


@pytest.mark.parametrize("query", ["?token=nope", "?token=", ""])
def test_a_bad_token_is_closed_with_4401(trio, query):
    trio.user("Ali")
    with trio.client.websocket_connect(f"/ws{query}") as sock:
        with pytest.raises(WebSocketDisconnect) as closed:
            sock.receive_json()
    assert closed.value.code == 4401
    assert trio.client.app.state.hub.conns == {}


def test_ready_is_the_first_frame(trio, three):
    ali, berk, cem = three
    with trio.ws(ali) as a:
        ready = a.ready
        assert set(ready) == {
            "type",
            "server_version",
            "server",
            "user",
            "users",
            "channels",
            "voice",
            "activity",
            "persistent",  # CONTRACT-V6-OPS §7
            "read_state",  # CONTRACT-V7-READING
        }
        # Ali is the first user, so the owner (CONTRACT-V6-OPS §1).
        assert ready["user"] == {
            "id": ali["id"],
            "name": "Ali",
            "avatar_url": None,
            "is_owner": True,
        }
        assert ready["users"] == [
            {"id": ali["id"], "name": "Ali", "avatar_url": None, "online": True},
            {"id": berk["id"], "name": "Berk", "avatar_url": None, "online": False},
            {"id": cem["id"], "name": "Cem", "avatar_url": None, "online": False},
        ]
        assert ready["channels"] == [
            {"id": TEXT, "name": "genel", "kind": "text"},
            {"id": VOICE, "name": "Sohbet", "kind": "voice"},
        ]
        assert ready["voice"] == {str(VOICE): []}


def test_ready_carries_who_is_in_voice(trio, three):
    ali, berk, _ = three
    with trio.ws(ali) as a:
        a.send_json({"type": "voice.join", "channel_id": VOICE, "muted": True})
        expect(a, "voice.peers")
        expect(a, "voice.joined")
        with trio.ws(berk) as b:
            assert b.ready["voice"] == {
                str(VOICE): [
                    {
                        "user_id": ali["id"],
                        "muted": True,
                        "deafened": False,
                        "screensharing": False,
                        "camera": False,
                        "afk": False,
                        "reconnecting": False,
                        "music": False,
                        "music_title": None,
                    }
                ]
            }


def test_ping_pong(trio, three):
    with trio.ws(three[0]) as a:
        a.send_json({"type": "ping"})
        assert a.receive_json() == {"type": "pong"}


# -- presence and accounts ----------------------------------------------------


def test_presence(trio, three):
    ali, berk, _ = three
    with trio.ws(ali) as a:
        with trio.ws(berk) as b:
            assert a.receive_json() == {"type": "presence", "user_id": berk["id"], "online": True}
            online = {u["id"]: u["online"] for u in b.ready["users"]}
            assert online[ali["id"]] is True and online[berk["id"]] is True
            # A second tab of somebody already online changes nothing.
            with trio.ws(berk):
                quiet(a)
                quiet(b)
            quiet(a)
        # Offline only when the LAST connection goes.
        assert a.receive_json() == {"type": "presence", "user_id": berk["id"], "online": False}
        quiet(a)


def test_user_joined_and_channel_new_are_broadcast(trio, three):
    ali, berk, _ = three
    with trio.ws(ali) as a, trio.ws(berk) as b:
        expect(a, "presence")
        dana = trio.user("Dana")
        for sock in (a, b):
            assert sock.receive_json() == {
                "type": "user.joined",
                "user": {"id": dana["id"], "name": "Dana", "avatar_url": None},
            }
        channel_id = new_voice_channel(trio, ali)
        for sock in (a, b):
            assert sock.receive_json() == {
                "type": "channel.new",
                "channel": {"id": channel_id, "name": "oyun", "kind": "voice"},
            }
        with trio.ws(dana) as d:
            assert d.ready["channels"][-1]["id"] == channel_id
            assert str(channel_id) in d.ready["voice"]


# -- messages and typing ------------------------------------------------------


def test_message_send_reaches_everyone_and_the_nonce_only_the_sender(trio, three):
    ali, berk, cem = three
    with trio.ws(ali) as a, trio.ws(ali) as a2, trio.ws(berk) as b, trio.ws(cem) as c:
        for sock, count in ((a, 2), (a2, 2), (b, 1)):
            for _ in range(count):
                expect(sock, "presence")
        a.send_json(
            {"type": "message.send", "channel_id": TEXT, "content": "  merhaba  ", "nonce": "n-1"}
        )
        own = a.receive_json()
        message = own["message"]
        assert own == {"type": "message.new", "message": message, "nonce": "n-1"}
        assert set(message) == {
            "id",
            "channel_id",
            "author",
            "content",
            "created_at",
            "attachments",
            "edited_at",
            "reply_to",
            "reactions",
            "pinned_at",
            "pinned_by",
            "rev",
        }
        assert message["attachments"] == []
        assert message["channel_id"] == TEXT
        assert message["author"] == {"id": ali["id"], "name": "Ali", "avatar_url": None}
        assert message["content"] == "merhaba"
        assert message["created_at"].endswith("Z")
        # The sender's other tab gets the nonce too; other users never do.
        assert a2.receive_json() == own
        for sock in (b, c):
            assert sock.receive_json() == {"type": "message.new", "message": message}
        # Persisted.
        listed = trio.client.get(f"/api/channels/{TEXT}/messages", headers=berk["auth"]).json()
        assert listed == {"messages": [message], "has_more": False}


def test_message_ids_increase_and_a_nonce_is_optional(trio, three):
    ali, berk, _ = three
    with trio.ws(ali) as a, trio.ws(berk) as b:
        expect(a, "presence")
        a.send_json({"type": "message.send", "channel_id": TEXT, "content": "bir"})
        b.send_json({"type": "message.send", "channel_id": TEXT, "content": "iki", "nonce": "x"})
        first, second = a.receive_json(), a.receive_json()
        assert "nonce" not in first and "nonce" not in second
        assert first["message"]["id"] < second["message"]["id"]
        assert [first["message"]["content"], second["message"]["content"]] == ["bir", "iki"]
        assert "nonce" not in b.receive_json()
        assert b.receive_json()["nonce"] == "x"


@pytest.mark.parametrize(
    ("frame", "code"),
    [
        ({"channel_id": TEXT, "content": "   "}, "INVALID_MESSAGE"),
        ({"channel_id": TEXT, "content": "x" * 4001}, "INVALID_MESSAGE"),
        ({"channel_id": TEXT}, "INVALID_MESSAGE"),
        ({"channel_id": TEXT, "content": 5}, "INVALID_MESSAGE"),
        ({"channel_id": VOICE, "content": "hi"}, "INVALID_CHANNEL"),
        ({"channel_id": 999, "content": "hi"}, "INVALID_CHANNEL"),
        ({"channel_id": "1", "content": "hi"}, "INVALID_CHANNEL"),
        ({"content": "hi"}, "INVALID_CHANNEL"),
        ({"channel_id": TEXT, "content": "hi", "nonce": 5}, "BAD_REQUEST"),
    ],
)
def test_message_send_refusals(trio, three, frame, code):
    ali = three[0]
    with trio.ws(ali) as a:
        a.send_json({"type": "message.send", **frame})
        expect_error(a, code)
        quiet(a)
    listed = trio.client.get(f"/api/channels/{TEXT}/messages", headers=ali["auth"]).json()
    assert listed["messages"] == []


def test_a_message_of_exactly_4000_characters_is_accepted(trio, three):
    with trio.ws(three[0]) as a:
        a.send_json({"type": "message.send", "channel_id": TEXT, "content": "ş" * 4000})
        assert len(expect(a, "message.new")["message"]["content"]) == 4000


def test_typing_is_not_echoed_to_the_sender(trio, three):
    ali, berk, cem = three
    with trio.ws(ali) as a, trio.ws(ali) as a2, trio.ws(berk) as b, trio.ws(cem) as c:
        for sock, count in ((a, 2), (a2, 2), (b, 1)):
            for _ in range(count):
                expect(sock, "presence")
        a.send_json({"type": "typing", "channel_id": TEXT})
        for sock in (b, c):
            assert sock.receive_json() == {
                "type": "typing",
                "channel_id": TEXT,
                "user_id": ali["id"],
            }
        quiet(a)
        quiet(a2)
        a.send_json({"type": "typing", "channel_id": VOICE})
        expect_error(a, "INVALID_CHANNEL")
        quiet(b)


# -- malformed frames ---------------------------------------------------------


def test_malformed_and_unknown_frames_get_an_error_and_the_socket_stays_open(trio, three):
    with trio.ws(three[0]) as a:
        for text in (
            "not json",
            "[1, 2]",
            '"text"',
            "5",
            "null",
            "{}",
            '{"type": 5}',
            '{"type": null}',
            '{"no": "type"}',
        ):
            a.send_text(text)
            expect_error(a, "BAD_REQUEST")
        for frame_type in ("nope", "ready", "message.new", ""):
            a.send_json({"type": frame_type})
            expect_error(a, "UNKNOWN_TYPE")
        a.send_bytes(b"\x00\x01")
        expect_error(a, "BAD_REQUEST")
        a.send_text("x" * 70_000)
        expect_error(a, "TOO_LARGE")
        # Still alive, still working.
        a.send_json({"type": "message.send", "channel_id": TEXT, "content": "hala buradayım"})
        assert expect(a, "message.new")["message"]["content"] == "hala buradayım"


# -- voice --------------------------------------------------------------------


def test_voice_join_peers_joined_state_and_left(trio, three):
    ali, berk, cem = three
    with trio.ws(ali) as a, trio.ws(berk) as b, trio.ws(cem) as c:
        for sock, count in ((a, 2), (b, 1)):
            for _ in range(count):
                expect(sock, "presence")

        a.send_json({"type": "voice.join", "channel_id": VOICE})
        assert a.receive_json() == {
            "type": "voice.peers",
            "channel_id": VOICE,
            "peers": [],
            "reconnecting": [],
            "resumed": False,
        }
        joined = {
            "type": "voice.joined",
            "channel_id": VOICE,
            "user_id": ali["id"],
            "muted": False,
            "deafened": False,
            "screensharing": False,
            "camera": False,
            "afk": False,
            "reconnecting": False,
            "music": False,
            "music_title": None,
            "resumed": False,
        }
        for sock in (a, b, c):  # everyone, the joiner included
            assert sock.receive_json() == joined

        b.send_json({"type": "voice.join", "channel_id": VOICE, "muted": True, "deafened": True})
        assert b.receive_json() == {
            "type": "voice.peers",
            "channel_id": VOICE,
            "peers": [ali["id"]],
            "reconnecting": [],
            "resumed": False,
        }
        joined = {
            "type": "voice.joined",
            "channel_id": VOICE,
            "user_id": berk["id"],
            "muted": True,
            "deafened": True,
            "screensharing": False,
            "camera": False,
            "afk": False,
            "reconnecting": False,
            "music": False,
            "music_title": None,
            "resumed": False,
        }
        for sock in (a, b, c):
            assert sock.receive_json() == joined

        c.send_json({"type": "voice.join", "channel_id": VOICE})
        assert sorted(expect(c, "voice.peers")["peers"]) == [ali["id"], berk["id"]]
        for sock in (a, b, c):
            assert expect(sock, "voice.joined")["user_id"] == cem["id"]

        b.send_json(
            {"type": "voice.state", "muted": False, "deafened": False, "screensharing": True}
        )
        state = {
            "type": "voice.state",
            "channel_id": VOICE,
            "user_id": berk["id"],
            "muted": False,
            "deafened": False,
            "screensharing": True,
            "camera": False,
            "afk": False,
            "reconnecting": False,
            "music": False,
            "music_title": None,
        }
        for sock in (a, b, c):
            assert sock.receive_json() == state

        b.send_json({"type": "voice.leave"})
        for sock in (a, b, c):
            assert sock.receive_json() == {
                "type": "voice.left",
                "channel_id": VOICE,
                "user_id": berk["id"],
            }
        # Leaving twice is a no-op.
        b.send_json({"type": "voice.leave"})
        quiet(b)
        quiet(a)

        with trio.ws(berk) as late:
            members = late.ready["voice"][str(VOICE)]
            assert [m["user_id"] for m in members] == [ali["id"], cem["id"]]


@pytest.mark.parametrize("channel_id", [TEXT, 999, "2", None, True])
def test_voice_join_on_a_text_or_missing_channel(trio, three, channel_id):
    with trio.ws(three[0]) as a:
        a.send_json({"type": "voice.join", "channel_id": channel_id})
        expect_error(a, "INVALID_CHANNEL")
        quiet(a)
    assert trio.client.app.state.hub.voice == {}


def test_voice_frames_with_bad_fields(trio, three):
    with trio.ws(three[0]) as a:
        a.send_json({"type": "voice.join", "channel_id": VOICE, "muted": "yes"})
        expect_error(a, "BAD_REQUEST")
        a.send_json(
            {"type": "voice.state", "muted": True, "deafened": False, "screensharing": False}
        )
        expect_error(a, "NOT_IN_VOICE")
        a.send_json({"type": "voice.join", "channel_id": VOICE})
        expect(a, "voice.peers")
        expect(a, "voice.joined")
        a.send_json({"type": "voice.state", "muted": True})
        expect_error(a, "BAD_REQUEST")
        quiet(a)


def test_joining_again_from_another_channel_leaves_the_old_one_first(trio, three):
    ali, berk, _ = three
    other = new_voice_channel(trio, ali)
    with trio.ws(ali) as a, trio.ws(berk) as b:
        expect(a, "presence")
        a.send_json({"type": "voice.join", "channel_id": VOICE})
        expect(a, "voice.peers")
        expect(a, "voice.joined")
        expect(b, "voice.joined")

        a.send_json({"type": "voice.join", "channel_id": other, "muted": True})
        left = {"type": "voice.left", "channel_id": VOICE, "user_id": ali["id"]}
        joined = {
            "type": "voice.joined",
            "channel_id": other,
            "user_id": ali["id"],
            "muted": True,
            "deafened": False,
            "screensharing": False,
            "camera": False,
            "afk": False,
            "reconnecting": False,
            "music": False,
            "music_title": None,
            "resumed": False,
        }
        assert a.receive_json() == left
        assert a.receive_json() == {
            "type": "voice.peers",
            "channel_id": other,
            "peers": [],
            "reconnecting": [],
            "resumed": False,
        }
        assert a.receive_json() == joined
        assert b.receive_json() == left
        assert b.receive_json() == joined

        hub = trio.client.app.state.hub
        assert list(hub.voice) == [other]
        assert hub.voice_of == {ali["id"]: other}


def test_joining_from_another_tab_moves_the_voice_binding(trio, three):
    ali, berk, _ = three
    with trio.ws(berk) as b, trio.ws(ali) as a1:
        expect(b, "presence")
        a1.send_json({"type": "voice.join", "channel_id": VOICE})
        expect(a1, "voice.peers")
        expect(a1, "voice.joined")
        expect(b, "voice.joined")
        with trio.ws(ali) as a2:
            a2.send_json({"type": "voice.join", "channel_id": VOICE})
            assert expect(a2, "voice.left")["user_id"] == ali["id"]
            assert expect(a2, "voice.peers")["peers"] == []
            expect(a2, "voice.joined")
            for sock in (a1, b):
                expect(sock, "voice.left")
                expect(sock, "voice.joined")
            # The old tab no longer owns the voice session ...
            a1.send_json(
                {"type": "voice.state", "muted": True, "deafened": False, "screensharing": False}
            )
            expect_error(a1, "NOT_IN_VOICE")
        # ... so it is the NEW tab closing that ends it (after the grace).
        for sock in (a1, b):
            assert expect(sock, "voice.state")["reconnecting"] is True
        trio.clock.value += 10
        trio.client.portal.call(trio.client.app.state.hub.expire_graces)
        left = {"type": "voice.left", "channel_id": VOICE, "user_id": ali["id"]}
        assert a1.receive_json() == left
        assert b.receive_json() == left
        quiet(b)  # Ali still has a1 open: no presence change


def test_closing_a_tab_that_is_not_the_voice_one_leaves_voice_alone(trio, three):
    ali, berk, _ = three
    with trio.ws(berk) as b, trio.ws(ali) as a1:
        expect(b, "presence")
        a1.send_json({"type": "voice.join", "channel_id": VOICE})
        expect(a1, "voice.peers")
        expect(a1, "voice.joined")
        expect(b, "voice.joined")
        with trio.ws(ali):
            pass
        quiet(b)
        quiet(a1)
        assert trio.client.app.state.hub.voice_of == {ali["id"]: VOICE}


def test_disconnecting_means_voice_left(trio, three):
    ali, berk, _ = three
    with trio.ws(ali) as a:
        with trio.ws(berk) as b:
            expect(a, "presence")
            b.send_json({"type": "voice.join", "channel_id": VOICE})
            expect(b, "voice.peers")
            expect(b, "voice.joined")
            expect(a, "voice.joined")
        # CONTRACT-V4 A1: first the reconnect grace, voice.left when it runs out.
        state = expect(a, "voice.state")
        assert state["user_id"] == berk["id"] and state["reconnecting"] is True
        assert a.receive_json() == {"type": "presence", "user_id": berk["id"], "online": False}
        hub = trio.client.app.state.hub
        trio.clock.value += 10
        trio.client.portal.call(hub.expire_graces)
        assert a.receive_json() == {
            "type": "voice.left",
            "channel_id": VOICE,
            "user_id": berk["id"],
        }
        assert hub.voice == {} and hub.voice_of == {}


# -- signalling ---------------------------------------------------------------


def join_voice(socks, sock, channel_id: int = VOICE) -> None:
    sock.send_json({"type": "voice.join", "channel_id": channel_id})
    expect(sock, "voice.peers")
    for each in socks:
        expect(each, "voice.joined")


def test_signal_is_relayed_verbatim_to_the_target_only(trio, three):
    ali, berk, cem = three
    with trio.ws(ali) as a, trio.ws(berk) as b, trio.ws(berk) as b_other, trio.ws(cem) as c:
        expect(a, "presence")
        expect(a, "presence")
        expect(b, "presence")
        expect(b_other, "presence")
        socks = (a, b, b_other, c)
        join_voice(socks, a)
        join_voice(socks, b)
        join_voice(socks, c)

        data = {
            "description": {"type": "offer", "sdp": "v=0\r\no=- 1 2 IN IP4 0.0.0.0\r\n"},
            "extra": [1, None, {"ğ": "ü"}],
        }
        a.send_json({"type": "signal", "to": berk["id"], "data": data})
        assert b.receive_json() == {"type": "signal", "from": ali["id"], "data": data}
        b.send_json({"type": "signal", "to": ali["id"], "data": {"candidate": None}})
        assert a.receive_json() == {
            "type": "signal",
            "from": berk["id"],
            "data": {"candidate": None},
        }
        # Not Cem, not Berk's other tab, not the sender.
        for sock in (a, b, b_other, c):
            quiet(sock)


def test_signal_is_refused_outside_a_shared_voice_channel(trio, three):
    ali, berk, cem = three
    other = new_voice_channel(trio, ali)
    with trio.ws(ali) as a, trio.ws(berk) as b, trio.ws(cem) as c:
        for sock, count in ((a, 2), (b, 1)):
            for _ in range(count):
                expect(sock, "presence")
        signal = {"type": "signal", "to": berk["id"], "data": {"candidate": None}}

        # Neither is in voice.
        a.send_json(signal)
        expect_error(a, "NOT_IN_VOICE")

        # Only the target is.
        join_voice((a, b, c), b)
        a.send_json(signal)
        expect_error(a, "NOT_IN_VOICE")

        # Both are, in different channels.
        join_voice((a, b, c), a, other)
        a.send_json(signal)
        expect_error(a, "NOT_IN_VOICE")

        # Only the sender is; an unknown user; themselves.
        b.send_json({"type": "voice.leave"})
        for sock in (a, b, c):
            expect(sock, "voice.left")
        for target in (berk["id"], 999, ali["id"]):
            a.send_json({**signal, "to": target})
            expect_error(a, "NOT_IN_VOICE")

        quiet(b)
        quiet(c)

        # Same channel at last: relayed.
        join_voice((a, b, c), b, other)
        a.send_json(signal)
        assert expect(b, "signal")["from"] == ali["id"]


def test_signal_from_a_tab_that_is_not_the_voice_one_is_refused(trio, three):
    ali, berk, _ = three
    with trio.ws(ali) as a, trio.ws(ali) as a_other, trio.ws(berk) as b:
        expect(a, "presence")
        expect(a_other, "presence")
        join_voice((a, a_other, b), a)
        join_voice((a, a_other, b), b)
        a_other.send_json({"type": "signal", "to": berk["id"], "data": {}})
        expect_error(a_other, "NOT_IN_VOICE")
        quiet(b)


def test_signal_shape_and_size_limits(trio, three):
    ali, berk, _ = three
    with trio.ws(ali) as a, trio.ws(berk) as b:
        expect(a, "presence")
        join_voice((a, b), a)
        join_voice((a, b), b)
        for frame in (
            {"to": berk["id"]},
            {"data": {}},
            {"to": "2", "data": {}},
            {"to": True, "data": {}},
        ):
            a.send_json({"type": "signal", **frame})
            expect_error(a, "BAD_REQUEST")
        # 64 KiB of data is relayed; a byte more is not.
        blob = "x" * (64 * 1024 - len(json.dumps({"sdp": ""}, separators=(",", ":"))))
        a.send_json({"type": "signal", "to": berk["id"], "data": {"sdp": blob}})
        assert expect(b, "signal")["data"] == {"sdp": blob}
        a.send_json({"type": "signal", "to": berk["id"], "data": {"sdp": blob + "x"}})
        # The refusal names the peer, so the sender knows which negotiation was lost.
        refused = expect(a, "error")
        assert refused == {**refused, "code": "TOO_LARGE", "to": berk["id"]}
        quiet(b)
