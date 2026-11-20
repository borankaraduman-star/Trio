"""CONTRACT-V11-ACTIVITY: the ``listening`` part of an activity."""

from __future__ import annotations

import pytest

from trio_server.activity import ACTIVITY_GRACE_SECONDS, ACTIVITY_TTL_SECONDS, iso

from .test_ws import expect, expect_error

NOW = 1_800_000_000
SONG = {"title": "Bir Derdim Var", "artist": "mor ve ötesi", "app": "Spotify"}


@pytest.fixture
def three(trio):
    return trio.user("Ali"), trio.user("Berk"), trio.user("Cem")


def listening(**overrides):
    frame = {"type": "activity.set", "listening": dict(SONG)}
    frame.update(overrides)
    return frame


def test_ready_announces_the_parts(trio, three):
    ali, _, _ = three
    with trio.ws(ali) as a:
        assert a.ready["activity_parts"] == ["game", "listening"]


def test_listening_alone_is_broadcast_with_a_null_game(trio, three):
    ali, berk, cem = three
    with trio.ws(ali) as a, trio.ws(berk) as b:
        expect(a, "presence")
        a.send_json(listening())
        want = {
            "type": "activity",
            "user_id": ali["id"],
            "activity": {"game": None, "since": None, "detail": None, "listening": SONG},
            "updated_at": iso(NOW),
        }
        assert a.receive_json() == want
        assert b.receive_json() == want
        with trio.ws(cem) as c:
            assert c.ready["activity"][str(ali["id"])]["activity"]["listening"] == SONG


def test_game_and_listening_together(trio, three):
    ali, berk, _ = three
    with trio.ws(ali) as a, trio.ws(berk) as b:
        expect(a, "presence")
        a.send_json(listening(game="Counter-Strike 2", since=NOW - 60))
        got = expect(b, "activity")["activity"]
        assert got == {
            "game": "Counter-Strike 2",
            "since": NOW - 60,
            "detail": None,
            "listening": SONG,
        }


def test_a_v5_frame_is_unchanged_on_the_wire(trio, three):
    """No ``listening`` key at all when there is none: old clients see V5 exactly."""
    ali, berk, _ = three
    with trio.ws(ali) as a, trio.ws(berk) as b:
        expect(a, "presence")
        a.send_json({"type": "activity.set", "game": "Dota 2", "since": NOW})
        assert expect(b, "activity")["activity"] == {"game": "Dota 2", "since": NOW, "detail": None}


def test_listening_is_cleaned_and_capped(trio, three):
    ali, berk, _ = three
    with trio.ws(ali) as a, trio.ws(berk) as b:
        expect(a, "presence")
        a.send_json(
            listening(
                listening={
                    "title": "  Şarkı\n‮ters​  " + "x" * 200,
                    "artist": None,
                    "app": "S" * 80,
                }
            )
        )
        got = expect(b, "activity")["activity"]["listening"]
        assert got["title"].startswith("Şarkı ters ")
        assert len(got["title"]) == 120
        assert "‮" not in got["title"] and "\n" not in got["title"]
        assert got["artist"] == ""
        assert got["app"] == "S" * 40


@pytest.mark.parametrize(
    "overrides",
    [
        {"listening": "Şarkı"},
        {"listening": {"title": ""}},
        {"listening": {"title": "​\n "}},
        {"listening": {"title": 5}},
        {"listening": {"title": "a", "artist": 3}},
        {"listening": {"title": "a", "url": "https://x"}},
        {"listening": None},  # neither part
        {"listening": SONG, "since": NOW},  # since without a game
        {"listening": SONG, "detail": {"character": "a"}},
    ],
)
def test_invalid_listening_frames_are_refused(trio, three, overrides):
    ali, _, _ = three
    with trio.ws(ali) as a:
        a.send_json(listening(**overrides))
        expect_error(a, "INVALID_ACTIVITY")
        assert trio.client.app.state.hub.activity.entries == {}


def test_a_track_change_sooner_than_four_seconds_is_rate_limited(trio, three):
    ali, berk, _ = three
    with trio.ws(ali) as a, trio.ws(berk) as b:
        expect(a, "presence")
        a.send_json(listening())
        expect(b, "activity")
        expect(a, "activity")
        trio.clock.value += 2
        a.send_json(listening(listening={"title": "Başka"}))
        expect_error(a, "RATE_LIMITED")
        # The same song again (a refresh, or a game change) is fine.
        a.send_json(listening(game="Dota 2", since=NOW))
        assert expect(b, "activity")["activity"]["listening"] == SONG
        expect(a, "activity")
        trio.clock.value += 2  # 4 s since the listening part changed
        a.send_json(listening(listening={"title": "Başka"}))
        assert expect(b, "activity")["activity"]["listening"]["title"] == "Başka"


def test_stopping_listening_is_not_rate_limited_as_a_change_to_nothing(trio, three):
    """Dropping the listening part (the private direction) is never rate limited."""
    ali, berk, _ = three
    with trio.ws(ali) as a, trio.ws(berk) as b:
        expect(a, "presence")
        a.send_json(listening(game="Dota 2", since=NOW))
        expect(b, "activity")
        expect(a, "activity")
        trio.clock.value += 1  # well inside the 4 s: stopping is never held back
        a.send_json({"type": "activity.set", "game": "Dota 2", "since": NOW})
        assert "listening" not in expect(b, "activity")["activity"]
        # activity.clear is never held back.
        a.send_json({"type": "activity.clear"})
        assert expect(b, "activity")["activity"] is None


def test_listening_expires_like_a_game(trio, three):
    ali, berk, _ = three
    with trio.ws(berk) as b:
        with trio.ws(ali) as a:
            expect(b, "presence")
            a.send_json(listening())
            expect(b, "activity")
        expect(b, "presence")
        trio.clock.value += ACTIVITY_GRACE_SECONDS
        trio.client.portal.call(trio.client.app.state.hub.activity.expire)
        assert expect(b, "activity")["activity"] is None
    with trio.ws(ali) as a:
        a.send_json(listening())
        expect(a, "activity")
        trio.clock.value += ACTIVITY_TTL_SECONDS
        assert trio.client.portal.call(trio.client.app.state.hub.activity.expire) == [ali["id"]]


def test_an_old_client_sees_a_listening_only_entry_as_no_game(trio, three):
    """What a V5 client reads: ``game`` is null, which it takes for "nothing"."""
    ali, berk, _ = three
    with trio.ws(ali) as a, trio.ws(berk) as b:
        expect(a, "presence")
        a.send_json(listening())
        got = expect(b, "activity")["activity"]
        assert got["game"] is None
