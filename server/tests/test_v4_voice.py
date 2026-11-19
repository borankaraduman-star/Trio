"""CONTRACT-V4 A1 (voice survives a signalling drop) and A4 (voice.ring)."""

from __future__ import annotations

import pytest

from .conftest import quiet
from .test_ws import VOICE, expect, expect_error, new_voice_channel


@pytest.fixture
def three(trio):
    return trio.user("Ali"), trio.user("Berk"), trio.user("Cem")


def drain(sock, *types: str) -> None:
    for frame_type in types:
        expect(sock, frame_type)


def join(sock, channel_id: int = VOICE, **flags) -> dict:
    sock.send_json({"type": "voice.join", "channel_id": channel_id, **flags})
    peers = expect(sock, "voice.peers")
    expect(sock, "voice.joined")
    return peers


def expire(trio) -> list[int]:
    trio.clock.value += 10
    return trio.client.portal.call(trio.client.app.state.hub.expire_graces)


# -- the grace ----------------------------------------------------------------------


def test_a_resume_inside_the_grace_keeps_the_member_without_voice_left(trio, three):
    ali, berk, _ = three
    with trio.ws(ali) as a:
        join(a)
        with trio.ws(berk) as b:
            expect(a, "presence")
            join(b, muted=True)
            expect(a, "voice.joined")
        state = expect(a, "voice.state")
        assert state == {
            "type": "voice.state",
            "channel_id": VOICE,
            "user_id": berk["id"],
            "muted": True,
            "deafened": False,
            "screensharing": False,
            "camera": False,
            "afk": False,
            "reconnecting": True,
        }
        expect(a, "presence")  # Berk had no other socket
        trio.clock.value += 9
        with trio.ws(berk) as b:
            expect(a, "presence")
            # Still listed while reconnecting.
            assert b.ready["voice"][str(VOICE)][1]["reconnecting"] is True
            b.send_json(
                {
                    "type": "voice.join",
                    "channel_id": VOICE,
                    "muted": False,
                    "deafened": False,
                    "camera": True,
                    "screensharing": True,
                    "resume": True,
                }
            )
            assert b.receive_json() == {
                "type": "voice.peers",
                "channel_id": VOICE,
                "peers": [ali["id"]],
                "reconnecting": [],
                "resumed": True,
            }
            joined = {
                "type": "voice.joined",
                "channel_id": VOICE,
                "user_id": berk["id"],
                "muted": False,
                "deafened": False,
                "screensharing": True,
                "camera": True,
                "afk": False,
                "reconnecting": False,
                "resumed": True,
            }
            assert b.receive_json() == joined
            assert a.receive_json() == joined  # no voice.left before it
            # The grace is over for good: the clock passing it changes nothing.
            assert expire(trio) == []
            quiet(a)
            # Signalling works again both ways.
            a.send_json({"type": "signal", "to": berk["id"], "data": {"x": 1}})
            assert expect(b, "signal") == {"type": "signal", "from": ali["id"], "data": {"x": 1}}


def test_the_grace_running_out_is_voice_left(trio, three):
    ali, berk, _ = three
    with trio.ws(ali) as a:
        join(a)
        with trio.ws(berk) as b:
            expect(a, "presence")
            join(b)
            expect(a, "voice.joined")
        assert expect(a, "voice.state")["reconnecting"] is True
        expect(a, "presence")
        trio.clock.value += 9.5
        assert trio.client.portal.call(trio.client.app.state.hub.expire_graces) == []
        quiet(a)
        assert expire(trio) == [berk["id"]]
        assert a.receive_json() == {
            "type": "voice.left",
            "channel_id": VOICE,
            "user_id": berk["id"],
        }
        hub = trio.client.app.state.hub
        assert berk["id"] not in hub.voice_of
        # A resume after that is an ordinary join, flagged resumed.
        with trio.ws(berk) as b:
            expect(a, "presence")
            b.send_json({"type": "voice.join", "channel_id": VOICE, "resume": True})
            assert expect(b, "voice.peers")["resumed"] is True
            assert expect(a, "voice.joined")["resumed"] is True


def test_the_grace_timer_ends_it_by_itself(trio, three):
    ali, berk, _ = three
    trio.client.app.state.hub.grace_seconds = 0
    with trio.ws(ali) as a:
        with trio.ws(berk) as b:
            expect(a, "presence")
            join(b)
            expect(a, "voice.joined")
        assert expect(a, "voice.state")["reconnecting"] is True
        expect(a, "presence")
        assert a.receive_json() == {
            "type": "voice.left",
            "channel_id": VOICE,
            "user_id": berk["id"],
        }


def test_nothing_is_signalled_to_a_member_in_the_grace(trio, three):
    ali, berk, cem = three
    with trio.ws(ali) as a, trio.ws(cem) as c:
        expect(a, "presence")
        join(a)
        expect(c, "voice.joined")
        with trio.ws(berk) as b:
            drain(a, "presence")
            drain(c, "presence")
            join(b)
            drain(a, "voice.joined")
            drain(c, "voice.joined")
        drain(a, "voice.state", "presence")
        drain(c, "voice.state", "presence")
        a.send_json({"type": "signal", "to": berk["id"], "data": {}})
        expect_error(a, "NOT_IN_VOICE")
        # A newcomer is told who is reconnecting, apart from whom to connect to.
        c.send_json({"type": "voice.join", "channel_id": VOICE})
        assert c.receive_json() == {
            "type": "voice.peers",
            "channel_id": VOICE,
            "peers": [ali["id"]],
            "reconnecting": [berk["id"]],
            "resumed": False,
        }


def test_an_ordinary_join_or_a_leave_during_the_grace_ends_it_at_once(trio, three):
    ali, berk, _ = three
    other = new_voice_channel(trio, ali)
    with trio.ws(ali) as a, trio.ws(berk) as b_stays:
        expect(a, "presence")
        with trio.ws(berk) as b:
            join(b)
            expect(a, "voice.joined")
            expect(b_stays, "voice.joined")
        drain(a, "voice.state")
        drain(b_stays, "voice.state")
        # Not a resume: leave first, then join.
        b_stays.send_json({"type": "voice.join", "channel_id": VOICE})
        assert expect(a, "voice.left")["user_id"] == berk["id"]
        joined = expect(a, "voice.joined")
        assert joined["resumed"] is False and joined["reconnecting"] is False
        drain(b_stays, "voice.left", "voice.peers", "voice.joined")
        # Now the voice tab drops again, and a plain leave ends the grace.
        hub = trio.client.app.state.hub
        with trio.ws(berk) as b2:
            b2.send_json({"type": "voice.join", "channel_id": other})
            drain(b2, "voice.left", "voice.peers", "voice.joined")
            drain(a, "voice.left", "voice.joined")
            drain(b_stays, "voice.left", "voice.joined")
        drain(a, "voice.state")
        drain(b_stays, "voice.state")
        b_stays.send_json({"type": "voice.leave"})
        assert expect(a, "voice.left") == {
            "type": "voice.left",
            "channel_id": other,
            "user_id": berk["id"],
        }
        assert berk["id"] not in hub.voice_of
        assert expire(trio) == []


def test_a_resume_into_another_channel_is_an_ordinary_move(trio, three):
    ali, berk, _ = three
    other = new_voice_channel(trio, ali)
    with trio.ws(ali) as a:
        join(a)
        with trio.ws(berk) as b:
            drain(a, "presence")
            join(b)
            drain(a, "voice.joined")
        drain(a, "voice.state", "presence")
        with trio.ws(berk) as b:
            drain(a, "presence")
            b.send_json({"type": "voice.join", "channel_id": other, "resume": True})
            assert expect(a, "voice.left")["channel_id"] == VOICE
            joined = expect(a, "voice.joined")
            assert joined["channel_id"] == other and joined["resumed"] is True


def test_a_kicked_socket_gets_no_grace(trio, three):
    ali, berk, _ = three
    with trio.ws(ali) as a, trio.ws(berk) as b:
        expect(a, "presence")
        join(b)
        expect(a, "voice.joined")
        assert trio.client.delete("/api/session", headers=berk["auth"]).status_code == 204
        assert a.receive_json() == {
            "type": "voice.left",
            "channel_id": VOICE,
            "user_id": berk["id"],
        }


@pytest.mark.parametrize("bad", [{"resume": "yes"}, {"screensharing": 1}])
def test_resume_and_screensharing_must_be_booleans(trio, three, bad):
    with trio.ws(three[0]) as a:
        a.send_json({"type": "voice.join", "channel_id": VOICE, **bad})
        expect_error(a, "BAD_REQUEST")


def test_screensharing_on_join_is_kept(trio, three):
    ali, berk, _ = three
    with trio.ws(ali) as a:
        a.send_json({"type": "voice.join", "channel_id": VOICE, "screensharing": True})
        expect(a, "voice.peers")
        assert expect(a, "voice.joined")["screensharing"] is True
        with trio.ws(berk) as b:
            assert b.ready["voice"][str(VOICE)][0]["screensharing"] is True


# -- voice.ring -----------------------------------------------------------------------


def test_a_ring_reaches_everyone_online_who_is_not_in_the_room(trio, three):
    ali, berk, cem = three
    dana = trio.user("Dana")
    with trio.ws(ali) as a, trio.ws(berk) as b, trio.ws(berk) as b2, trio.ws(cem) as c:
        drain(a, "presence", "presence")
        drain(b, "presence")
        drain(b2, "presence")
        join(a)
        for sock in (b, b2, c):
            expect(sock, "voice.joined")
        join(c)
        for sock in (a, b, b2):
            expect(sock, "voice.joined")
        a.send_json({"type": "voice.ring", "channel_id": VOICE})
        ring = {"type": "voice.ring", "channel_id": VOICE, "from": ali["id"]}
        assert b.receive_json() == ring
        assert b2.receive_json() == ring
        quiet(a)  # not to the ringer
        quiet(c)  # not to somebody already in the room
    # Dana was offline: nothing is kept for her.
    with trio.ws(dana) as d:
        quiet(d)


def test_a_ring_skips_a_member_in_the_grace(trio, three):
    ali, berk, cem = three
    with trio.ws(ali) as a, trio.ws(cem) as c:
        expect(a, "presence")
        join(a)
        expect(c, "voice.joined")
        with trio.ws(berk) as b, trio.ws(berk) as b_other:
            drain(a, "presence")
            drain(c, "presence")
            join(b)
            expect(b_other, "voice.joined")
            drain(a, "voice.joined")
            drain(c, "voice.joined")
            b.close()
            drain(b_other, "voice.state")
            drain(a, "voice.state")
            drain(c, "voice.state")
            a.send_json({"type": "voice.ring", "channel_id": VOICE})
            assert expect(c, "voice.ring")["from"] == ali["id"]
            quiet(b_other)  # Berk is still in the room, reconnecting
            # ... and cannot ring from there.
            b_other.send_json({"type": "voice.ring", "channel_id": VOICE})
            expect_error(b_other, "NOT_IN_VOICE")


def test_ring_rules_and_the_limit(trio, three):
    ali, berk, _ = three
    other = new_voice_channel(trio, ali)
    with trio.ws(ali) as a, trio.ws(ali) as a_tab, trio.ws(berk) as b:
        expect(a, "presence")
        expect(a_tab, "presence")
        a.send_json({"type": "voice.ring", "channel_id": VOICE})
        expect_error(a, "NOT_IN_VOICE")
        for bad in (1, other + 100, "2", 2**70, None):
            a.send_json({"type": "voice.ring", "channel_id": bad})
            expect_error(a, "INVALID_CHANNEL")
        join(a)
        drain(a_tab, "voice.joined")
        drain(b, "voice.joined")
        a.send_json({"type": "voice.ring", "channel_id": other})
        expect_error(a, "NOT_IN_VOICE")
        # Any tab of somebody in the room may ring; once per 30 s per user.
        a_tab.send_json({"type": "voice.ring", "channel_id": VOICE})
        assert expect(b, "voice.ring")["from"] == ali["id"]
        a.send_json({"type": "voice.ring", "channel_id": VOICE})
        expect_error(a, "RATE_LIMITED")
        trio.clock.value += 29
        a.send_json({"type": "voice.ring", "channel_id": VOICE})
        expect_error(a, "RATE_LIMITED")
        trio.clock.value += 1
        a.send_json({"type": "voice.ring", "channel_id": VOICE})
        assert expect(b, "voice.ring")["from"] == ali["id"]
        quiet(b)


# -- the call's session (half-open sockets, another tab) ---------------------------


def test_the_own_entry_in_ready_carries_the_session_and_nobody_elses_does(trio, three):
    ali, berk, _ = three
    with trio.ws(ali) as a:
        join(a, session="s-ali")
        with trio.ws(berk) as b:
            expect(a, "presence")
            join(b, session="s-berk")
            expect(a, "voice.joined")
            with trio.ws(ali) as a2:
                entries = {e["user_id"]: e for e in a2.ready["voice"][str(VOICE)]}
                assert entries[ali["id"]]["session"] == "s-ali"
                assert "session" not in entries[berk["id"]]


def test_a_resume_with_the_same_session_takes_over_a_connection_still_open(trio, three):
    """The client saw its socket die; the server has not noticed yet."""
    ali, berk, _ = three
    with trio.ws(berk) as b:
        old = trio.ws(ali)
        a = old.__enter__()
        expect(b, "presence")
        join(a, session="call-1")
        expect(b, "voice.joined")
        join(b)
        expect(a, "voice.joined")
        with trio.ws(ali) as a2:
            a2.send_json(
                {"type": "voice.join", "channel_id": VOICE, "resume": True, "session": "call-1"}
            )
            assert expect(a2, "voice.peers")["peers"] == [berk["id"]]
            joined = expect(b, "voice.joined")  # no voice.left before it
            assert joined["user_id"] == ali["id"] and joined["resumed"] is True
            assert joined["reconnecting"] is False
            expect(a2, "voice.joined")
            # The old socket finally closes: the membership is a2's, no grace starts.
            old.__exit__(None, None, None)
            quiet(b)
            a2.send_json({"type": "signal", "to": berk["id"], "data": {"x": 1}})
            assert expect(b, "signal")["from"] == ali["id"]


def test_a_resume_with_another_session_is_an_ordinary_join(trio, three):
    """Another tab took the place: a resume from the first one must not take it back quietly."""
    ali, berk, _ = three
    with trio.ws(ali) as a, trio.ws(berk) as b:
        drain(a, "presence")
        join(a, session="tab-2")
        expect(b, "voice.joined")
        join(b)
        expect(a, "voice.joined")
        with trio.ws(ali) as a2:
            a2.send_json(
                {"type": "voice.join", "channel_id": VOICE, "resume": True, "session": "tab-1"}
            )
            assert expect(b, "voice.left")["user_id"] == ali["id"]
            assert expect(b, "voice.joined")["resumed"] is True


@pytest.mark.parametrize("bad", [5, "", "x" * 65, ["s"]])
def test_session_must_be_a_short_string(trio, three, bad):
    ali, _, _ = three
    with trio.ws(ali) as a:
        a.send_json({"type": "voice.join", "channel_id": VOICE, "session": bad})
        expect_error(a, "BAD_REQUEST")


def test_a_refused_ring_says_it_answers_voice_ring(trio, three):
    """A NOT_IN_VOICE can also answer a signal; `request` tells the client which."""
    ali, berk, _ = three
    with trio.ws(ali) as a:
        a.send_json({"type": "voice.ring", "channel_id": VOICE})
        assert expect_error(a, "NOT_IN_VOICE")["request"] == "voice.ring"
        a.send_json({"type": "voice.ring", "channel_id": 999})
        assert expect_error(a, "INVALID_CHANNEL")["request"] == "voice.ring"
        join(a)
        a.send_json({"type": "voice.ring", "channel_id": VOICE})
        a.send_json({"type": "voice.ring", "channel_id": VOICE})
        assert expect_error(a, "RATE_LIMITED")["request"] == "voice.ring"
        a.send_json({"type": "signal", "to": berk["id"], "data": {}})
        assert "request" not in expect_error(a, "NOT_IN_VOICE")
