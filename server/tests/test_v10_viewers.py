"""CONTRACT-V10-GROUPS §4b: who is in which text channel right now."""

from __future__ import annotations

import time

import pytest

from .test_v7_reading import delete
from .test_ws import expect

GENERAL = 1


@pytest.fixture
def board(trio):
    """The trio, with a short coalescing window so tests run in real time."""
    trio.client.app.state.hub.viewers.window = 0.2
    return trio


def text_channel(trio, user, name: str) -> int:
    response = trio.client.post(
        "/api/channels", json={"name": name, "kind": "text"}, headers=user["auth"]
    )
    return response.json()["channel"]["id"]


def viewing(sock, channel_id: int | None, *, on: bool = True, **extra) -> None:
    sock.send_json({"type": "client.viewing", "viewing": on, "channel_id": channel_id, **extra})


def next_viewing(sock) -> dict:
    """The next presence.viewing (other frames skipped)."""
    while True:
        frame = sock.receive_json()
        if frame["type"] == "presence.viewing":
            return frame


def settle(sock, seconds: float = 0.35) -> list[dict]:
    """Every presence.viewing that reaches ``sock`` within ``seconds`` (then a ping)."""
    time.sleep(seconds)
    sock.send_json({"type": "ping"})
    out = []
    while (frame := sock.receive_json())["type"] != "pong":
        if frame["type"] == "presence.viewing":
            out.append(frame)
    return out


def test_a_viewer_is_listed_under_their_channel_and_leaves_when_hidden(board):
    trio = board
    ali, berk = trio.user("Ali"), trio.user("Berk")
    with trio.ws(ali) as a, trio.ws(berk) as b:
        assert a.ready["viewers"] == {}
        viewing(a, GENERAL)
        assert next_viewing(b) == {
            "type": "presence.viewing",
            "user_id": ali["id"],
            "channel_id": GENERAL,
        }
        # The viewer's own sockets hear it too ("who is where" includes me).
        assert next_viewing(a)["channel_id"] == GENERAL
        with trio.ws(trio.user("Cem")) as c:
            assert c.ready["viewers"] == {str(GENERAL): [ali["id"]]}
        time.sleep(0.25)
        viewing(a, GENERAL, on=False)  # the tab hidden, the app in the tray
        assert next_viewing(b) == {
            "type": "presence.viewing",
            "user_id": ali["id"],
            "channel_id": None,
        }


def test_closing_the_last_viewing_socket_clears_and_a_reconnect_reports_again(board):
    trio = board
    ali, berk = trio.user("Ali"), trio.user("Berk")
    with trio.ws(berk) as b:
        with trio.ws(ali) as a:
            viewing(a, GENERAL)
            assert next_viewing(b)["channel_id"] == GENERAL
        assert next_viewing(b)["channel_id"] is None
        with trio.ws(ali) as a:
            assert a.ready["viewers"] == {}
            viewing(a, GENERAL)
            assert next_viewing(b)["channel_id"] == GENERAL


def test_two_devices_the_latest_looked_at_wins(board):
    trio = board
    ali, berk = trio.user("Ali"), trio.user("Berk")
    other = text_channel(trio, ali, "oyun")
    with trio.ws(berk) as b, trio.ws(ali) as phone, trio.ws(ali) as desk:
        viewing(phone, GENERAL)
        assert next_viewing(b)["channel_id"] == GENERAL
        time.sleep(0.25)
        viewing(desk, other)
        assert next_viewing(b)["channel_id"] == other
        time.sleep(0.25)
        # The desktop goes to the tray: the phone is still looked at, in genel.
        viewing(desk, other, on=False)
        assert next_viewing(b)["channel_id"] == GENERAL
        with trio.ws(trio.user("Cem")) as c:
            assert c.ready["viewers"] == {str(GENERAL): [ali["id"]]}


def test_fast_hopping_is_coalesced_and_the_last_state_wins(board):
    trio = board
    ali, berk = trio.user("Ali"), trio.user("Berk")
    other = text_channel(trio, ali, "oyun")
    with trio.ws(berk) as b, trio.ws(ali) as a:
        settle(b, 0)
        for channel in (GENERAL, other, GENERAL, other, GENERAL, other):
            viewing(a, channel)
        frames = settle(b, 0.5)
        # The first at once, then one with the state at the end of the window.
        assert [f["channel_id"] for f in frames] == [GENERAL, other]
        assert len(settle(b, 0.3)) == 0


def test_hiding_my_channel_stops_presence_but_not_the_push_viewing_state(board):
    trio = board
    ali, berk = trio.user("Ali"), trio.user("Berk")
    hub = trio.client.app.state.hub
    with trio.ws(berk) as b, trio.ws(ali) as a:
        viewing(a, GENERAL)
        assert next_viewing(b)["channel_id"] == GENERAL
        time.sleep(0.25)
        viewing(a, GENERAL, show_channel=False)
        assert next_viewing(b)["channel_id"] is None
        # Pushes are still held back for somebody looking at the app.
        assert hub.notify.is_viewing(ali["id"]) is True
        with trio.ws(trio.user("Cem")) as c:
            assert c.ready["viewers"] == {}
        viewing(a, GENERAL, show_channel="no")
        while (frame := a.receive_json())["type"] != "error":
            pass
        assert frame["code"] == "BAD_REQUEST"


def test_an_old_client_that_never_reports_is_in_no_channel(board):
    trio = board
    ali, berk = trio.user("Ali"), trio.user("Berk")
    with trio.ws(ali), trio.ws(berk) as b:
        assert settle(b) == []
        with trio.ws(trio.user("Cem")) as c:
            assert c.ready["viewers"] == {}


def test_a_voice_or_unknown_channel_is_no_channel_and_a_bad_id_is_refused(board):
    trio = board
    ali, berk = trio.user("Ali"), trio.user("Berk")
    voice = trio.channel_id("voice")
    with trio.ws(berk) as b, trio.ws(ali) as a:
        viewing(a, voice)
        viewing(a, 9999)
        assert settle(b) == []
        viewing(a, "genel")
        assert expect(a, "error")["code"] == "BAD_REQUEST"


def test_a_deleted_channel_empties(board):
    trio = board
    ali, berk = trio.user("Ali"), trio.user("Berk")
    other = text_channel(trio, ali, "oyun")
    with trio.ws(berk) as b, trio.ws(ali) as a:
        viewing(a, other)
        assert next_viewing(b)["channel_id"] == other
        time.sleep(0.25)
        assert delete(trio, ali, other, "oyun").status_code == 204
        assert next_viewing(b) == {
            "type": "presence.viewing",
            "user_id": ali["id"],
            "channel_id": None,
        }


def test_fifteen_people_in_channels(board):
    trio = board
    users = [trio.user(f"Kişi {i}") for i in range(15)]
    contexts = [trio.ws(u) for u in users]
    socks = [ctx.__enter__() for ctx in contexts]
    try:
        for sock in socks[:6]:
            viewing(sock, GENERAL)
        for sock in socks[:6]:
            settle(sock, 0)  # each one's frame has been handled
        with trio.ws(users[0]) as extra:
            snapshot = trio.client.app.state.hub.viewers.snapshot()
            assert snapshot == {str(GENERAL): sorted(u["id"] for u in users[:6])}
            assert extra.ready["viewers"][str(GENERAL)] == snapshot[str(GENERAL)]
    finally:
        for ctx in contexts:
            ctx.__exit__(None, None, None)
