"""CONTRACT-V5: activity.set / activity.clear / activity broadcasts (game status)."""

from __future__ import annotations

import pytest

from trio_server.activity import ACTIVITY_GRACE_SECONDS, ACTIVITY_TTL_SECONDS, iso

from .conftest import quiet
from .test_ws import expect, expect_error

NOW = 1_800_000_000

DETAIL = {
    "character": "Kahve Kokusu",
    "realm": "",
    "level": 37,
    "class": "ROGUE",
    "zone": "Orgrimmar",
    "subzone": "Gölge Vadisi",
    "source": "log",
}


def activity(**overrides):
    frame = {"type": "activity.set", "game": "WoW Forever", "since": NOW - 4800, "detail": DETAIL}
    frame.update(overrides)
    return frame


@pytest.fixture
def three(trio):
    return trio.user("Ali"), trio.user("Berk"), trio.user("Cem")


def sweep(trio) -> list[int]:
    return trio.client.portal.call(trio.client.app.state.hub.activity.expire)


def test_set_is_broadcast_to_everyone_and_listed_in_ready(trio, three):
    ali, berk, cem = three
    with trio.ws(ali) as a, trio.ws(berk) as b:
        expect(a, "presence")
        assert a.ready["activity"] == {}
        a.send_json(activity())
        want = {
            "type": "activity",
            "user_id": ali["id"],
            "activity": {"game": "WoW Forever", "since": NOW - 4800, "detail": DETAIL},
            "updated_at": iso(NOW),
        }
        assert a.receive_json() == want  # the sender's own sockets too
        assert b.receive_json() == want
        with trio.ws(cem) as c:
            assert c.ready["activity"] == {
                str(ali["id"]): {"activity": want["activity"], "updated_at": iso(NOW)}
            }


def test_a_process_only_activity_has_null_detail(trio, three):
    ali, *_ = three
    with trio.ws(ali) as a:
        frame = {"type": "activity.set", "game": "Counter-Strike 2", "since": NOW - 60}
        a.send_json(frame)
        got = expect(a, "activity")
        assert got["activity"] == {"game": "Counter-Strike 2", "since": NOW - 60, "detail": None}


def test_clear_broadcasts_null_once(trio, three):
    ali, berk, _ = three
    with trio.ws(ali) as a, trio.ws(berk) as b:
        expect(a, "presence")
        a.send_json(activity())
        expect(a, "activity")
        expect(b, "activity")
        trio.clock.value += 5
        a.send_json({"type": "activity.clear"})
        cleared = expect(b, "activity")
        assert cleared == {
            "type": "activity",
            "user_id": ali["id"],
            "activity": None,
            "updated_at": iso(NOW + 5),
        }
        expect(a, "activity")
        # Clearing nothing broadcasts nothing.
        a.send_json({"type": "activity.clear"})
        quiet(a)
        quiet(b)


@pytest.mark.parametrize(
    "overrides",
    [
        {"game": ""},
        {"game": "x" * 65},
        {"game": 5},
        {"game": "WoW\nForever"},
        {"since": None},
        {"since": "1"},
        {"since": True},
        {"since": NOW + 3600},
        {"since": 5},
        {"detail": "37"},
        {"detail": {**DETAIL, "level": 0}},
        {"detail": {**DETAIL, "level": 1000}},
        {"detail": {**DETAIL, "level": True}},
        {"detail": {**DETAIL, "level": "37"}},
        {"detail": {**DETAIL, "character": "  "}},
        {"detail": {**DETAIL, "character": "x" * 49}},
        {"detail": {**DETAIL, "zone": "a‮b"}},
        {"detail": {**DETAIL, "zone": "z" * 97}},
        {"detail": {**DETAIL, "class": "rogue"}},
        {"detail": {**DETAIL, "source": "memory"}},
        {"detail": {**DETAIL, "extra": 1}},
        {"user_id": 3},
    ],
)
def test_invalid_frames_are_refused_and_change_nothing(trio, three, overrides):
    ali, *_ = three
    with trio.ws(ali) as a:
        a.send_json(activity(**overrides))
        expect_error(a, "INVALID_ACTIVITY")
        quiet(a)
        assert trio.client.app.state.hub.activity.entries == {}


def test_optional_detail_fields_and_unicode_are_kept(trio, three):
    ali, *_ = three
    with trio.ws(ali) as a:
        detail = {"character": " Işıl Çağ ", "level": 1, "source": "saved"}
        a.send_json(activity(detail=detail))
        got = expect(a, "activity")["activity"]["detail"]
        assert got == {
            "character": "Işıl Çağ",
            "realm": "",
            "level": 1,
            "class": "",
            "zone": "",
            "subzone": "",
            "source": "saved",
        }


def test_thirty_changes_a_minute_then_rate_limited(trio, three):
    ali, *_ = three
    with trio.ws(ali) as a:
        for _ in range(30):
            a.send_json(activity())
            expect(a, "activity")
        a.send_json(activity())
        expect_error(a, "RATE_LIMITED")
        a.send_json({"type": "activity.clear"})
        expect_error(a, "RATE_LIMITED")
        trio.clock.value += 61
        a.send_json(activity())
        expect(a, "activity")


def test_an_entry_not_refreshed_for_ten_minutes_is_cleared(trio, three):
    ali, berk, _ = three
    with trio.ws(ali) as a, trio.ws(berk) as b:
        expect(a, "presence")
        a.send_json(activity())
        expect(a, "activity")
        expect(b, "activity")
        trio.clock.value += ACTIVITY_TTL_SECONDS - 1
        assert sweep(trio) == []
        a.send_json(activity())  # a heartbeat refreshes it
        expect(a, "activity")
        expect(b, "activity")
        trio.clock.value += ACTIVITY_TTL_SECONDS - 1
        assert sweep(trio) == []
        trio.clock.value += 1
        assert sweep(trio) == [ali["id"]]
        assert expect(b, "activity")["activity"] is None
        expect(a, "activity")


def test_ready_never_lists_a_stale_entry(trio, three):
    ali, berk, _ = three
    with trio.ws(ali) as a:
        a.send_json(activity())
        expect(a, "activity")
        trio.clock.value += ACTIVITY_TTL_SECONDS
        with trio.ws(berk) as b:
            assert b.ready["activity"] == {}


def test_a_reconnect_inside_the_grace_keeps_the_activity(trio, three):
    ali, berk, _ = three
    with trio.ws(berk) as b:
        with trio.ws(ali) as a:
            expect(b, "presence")
            a.send_json(activity())
            expect(a, "activity")
            expect(b, "activity")
        expect(b, "presence")
        trio.clock.value += ACTIVITY_GRACE_SECONDS - 1
        assert sweep(trio) == []
        with trio.ws(ali) as a:
            expect(b, "presence")
            assert str(ali["id"]) in a.ready["activity"]
            trio.clock.value += ACTIVITY_GRACE_SECONDS
            assert sweep(trio) == []
            quiet(b)


def test_the_last_socket_closing_clears_after_the_grace(trio, three):
    ali, berk, _ = three
    with trio.ws(berk) as b:
        with trio.ws(ali) as a:
            expect(b, "presence")
            a.send_json(activity())
            expect(a, "activity")
            expect(b, "activity")
        expect(b, "presence")
        trio.clock.value += ACTIVITY_GRACE_SECONDS
        assert sweep(trio) == [ali["id"]]
        assert expect(b, "activity") == {
            "type": "activity",
            "user_id": ali["id"],
            "activity": None,
            "updated_at": iso(NOW + ACTIVITY_GRACE_SECONDS),
        }


def test_a_second_tab_closing_is_not_going_offline(trio, three):
    ali, berk, _ = three
    with trio.ws(berk) as b, trio.ws(ali) as a1:
        expect(b, "presence")
        a1.send_json(activity())
        expect(a1, "activity")
        expect(b, "activity")
        with trio.ws(ali):
            pass
        trio.clock.value += ACTIVITY_GRACE_SECONDS + 1
        assert sweep(trio) == []
        quiet(b)


def test_a_removed_user_loses_the_activity(trio, three):
    ali, berk, cem = three
    with trio.ws(ali) as a, trio.ws(berk) as b:
        expect(a, "presence")
        b.send_json(activity())
        expect(a, "activity")
        expect(b, "activity")
        hub = trio.client.app.state.hub
        users = [u for u in hub.users.values() if u["id"] != berk["id"]]
        trio.client.portal.call(hub.sync_users, users)
        assert expect(a, "activity")["activity"] is None
        expect(a, "user.removed")
        assert hub.activity.entries == {}
