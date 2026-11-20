"""CONTRACT-V12-MULTISHARE §5: the cap on simultaneous screen shares per room.

``TRIO_SCREEN_SHARES_MAX`` (default 4, 1-16): a ``voice.state`` that starts
a share in a room that already has that many is refused with
``SCREEN_SHARES_FULL`` (who is sharing, the limit) and changes nothing.
"""

from __future__ import annotations

import pytest

from trio_server.config import ConfigError, Settings
from trio_server.hub import RESTART_RESUME_SECONDS

from .test_v10_groups import NAMES, join, skip_to
from .test_ws import VOICE


def state(sock, **flags) -> None:
    sock.send_json(
        {"type": "voice.state", "muted": False, "deafened": False, "screensharing": False, **flags}
    )


def own_state(sock, user_id: int) -> dict:
    while True:
        frame = skip_to(sock, "voice.state")
        if frame["user_id"] == user_id:
            return frame


def test_the_default_is_four_and_it_is_read_from_the_environment():
    assert Settings.from_env({"TRIO_INVITE_CODE": "x"}).screen_shares_max == 4
    settings = Settings.from_env({"TRIO_INVITE_CODE": "x", "TRIO_SCREEN_SHARES_MAX": "2"})
    assert settings.screen_shares_max == 2


@pytest.mark.parametrize("value", ["0", "17", "-1", "iki"])
def test_a_cap_out_of_bounds_refuses_to_start(value):
    with pytest.raises(ConfigError, match="TRIO_SCREEN_SHARES_MAX"):
        Settings.from_env({"TRIO_INVITE_CODE": "x", "TRIO_SCREEN_SHARES_MAX": value})


def test_the_cap_is_in_ready_and_in_get_server(make_trio):
    trio = make_trio(screen_shares_max=3)
    ali = trio.user("Ali")
    with trio.ws(ali) as a:
        assert a.ready["screen_shares_max"] == 3
    assert trio.client.get("/api/server", headers=ali["auth"]).json()["screen_shares_max"] == 3


def test_a_share_past_the_cap_is_refused_and_changes_nothing(make_trio):
    trio = make_trio(screen_shares_max=2)
    trio.clock.value += RESTART_RESUME_SECONDS + 1
    people = [trio.user(name) for name in NAMES[:4]]
    a_id, b_id, c_id, _ = (p["id"] for p in people)
    with trio.ws(people[0]) as a, trio.ws(people[1]) as b, trio.ws(people[2]) as c:
        for sock in (a, b, c):
            join(sock)
        state(a, screensharing=True)
        assert own_state(a, a_id)["screensharing"] is True
        state(b, screensharing=True)
        assert own_state(b, b_id)["screensharing"] is True
        state(c, screensharing=True, muted=True)
        frame = skip_to(c, "error")
        assert frame == {
            "type": "error",
            "code": "SCREEN_SHARES_FULL",
            "message": frame["message"],
            "request": "voice.state",
            "channel_id": VOICE,
            "limit": 2,
            "sharers": sorted([a_id, b_id]),
        }
        hub = trio.client.app.state.hub
        member = hub.voice[VOICE][c_id]
        assert member.screensharing is False and member.muted is False
        # A sharer repeating its state is not refused (mute while sharing).
        state(a, screensharing=True, muted=True)
        assert own_state(a, a_id)["muted"] is True
        # One stops: the next one may start.
        state(b, screensharing=False)
        assert own_state(c, b_id)["screensharing"] is False
        state(c, screensharing=True)
        assert own_state(c, c_id)["screensharing"] is True


def test_the_cap_counts_one_room(make_trio):
    trio = make_trio(screen_shares_max=1)
    trio.clock.value += RESTART_RESUME_SECONDS + 1
    ali, berk = trio.user("Ali"), trio.user("Berk")
    other = trio.client.post(
        "/api/channels", json={"name": "oyun", "kind": "voice"}, headers=ali["auth"]
    ).json()["channel"]["id"]
    with trio.ws(ali) as a, trio.ws(berk) as b:
        join(a)
        join(b, channel_id=other)
        state(a, screensharing=True)
        assert own_state(a, ali["id"])["screensharing"] is True
        state(b, screensharing=True)
        assert own_state(b, berk["id"])["screensharing"] is True


def test_a_resume_right_after_a_start_shares_again_past_the_cap(make_trio):
    # A deploy with the cap lowered meanwhile: nobody who was sharing is cut off.
    trio = make_trio(screen_shares_max=1)
    people = [trio.user(name) for name in NAMES[:3]]
    with trio.ws(people[0]) as a, trio.ws(people[1]) as b, trio.ws(people[2]) as c:
        join(a, resume=True)
        join(b, resume=True)
        join(c)
        state(a, screensharing=True)
        assert own_state(a, people[0]["id"])["screensharing"] is True
        state(b, screensharing=True)
        assert own_state(b, people[1]["id"])["screensharing"] is True
        # An ordinary join is held to the cap even inside the window.
        state(c, screensharing=True)
        assert skip_to(c, "error")["code"] == "SCREEN_SHARES_FULL"


def test_a_join_carrying_a_share_past_the_cap_joins_without_it(make_trio):
    trio = make_trio(screen_shares_max=1)
    trio.clock.value += RESTART_RESUME_SECONDS + 1
    ali, berk = trio.user("Ali"), trio.user("Berk")
    with trio.ws(ali) as a, trio.ws(berk) as b:
        join(a)
        state(a, screensharing=True)
        own_state(a, ali["id"])
        join(b, screensharing=True)
        assert trio.client.app.state.hub.voice[VOICE][berk["id"]].screensharing is False
