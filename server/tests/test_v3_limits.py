"""CONTRACT-V3 §5: the join limits, the client address, bounded limiter memory."""

from __future__ import annotations

import time

import pytest
from starlette.requests import Request

from trio_server.ratelimit import JoinGuard, SlidingWindow, client_address

from .conftest import INVITE


class Clock:
    def __init__(self) -> None:
        self.value = 1000.0

    def __call__(self) -> float:
        return self.value


def code(response) -> str:
    return response.json()["error"]["code"]


def request(headers: list[tuple[str, str]], peer: str = "192.0.2.1") -> Request:
    raw = [(k.lower().encode(), v.encode()) for k, v in headers]
    return Request({"type": "http", "headers": raw, "client": (peer, 1234)})


# -- the client address ---------------------------------------------------------------


def test_hops_pick_the_nth_entry_from_the_right():
    headers = [("X-Forwarded-For", "6.6.6.6, 203.0.113.9, 10.0.0.2")]
    assert client_address(request(headers), 1) == "10.0.0.2"
    assert client_address(request(headers), 2) == "203.0.113.9"
    assert client_address(request(headers), 3) == "6.6.6.6"
    # Fewer entries than proxies: not through the chain we expect -> the peer.
    assert client_address(request(headers), 4) == "192.0.2.1"


def test_hops_zero_ignores_the_header():
    headers = [("X-Forwarded-For", "203.0.113.9")]
    assert client_address(request(headers), 0) == "192.0.2.1"
    assert client_address(request([]), 1) == "192.0.2.1"


def test_every_header_line_is_read():
    # A second line appended by the proxy is the trusted one, not the first.
    headers = [("X-Forwarded-For", "6.6.6.6"), ("X-Forwarded-For", "203.0.113.9")]
    assert client_address(request(headers), 1) == "203.0.113.9"
    assert client_address(request(headers), 2) == "6.6.6.6"


@pytest.mark.parametrize(
    ("entry", "key"),
    [
        ("203.0.113.9:4567", "203.0.113.9"),
        ("[2001:db8::1]:443", "2001:db8::/64"),
        ("2001:db8::1", "2001:db8::/64"),
        ("::ffff:203.0.113.9", "203.0.113.9"),
        ("not-an-ip", "192.0.2.1"),
        ("", "192.0.2.1"),
    ],
)
def test_address_forms(entry, key):
    assert client_address(request([("X-Forwarded-For", entry)]), 1) == key


def test_spoofed_left_entries_do_not_buy_fresh_budgets(trio):
    for i in range(10):
        headers = {"X-Forwarded-For": f"10.9.{i}.1, 203.0.113.70"}
        assert trio.join("x", code="wrong", headers=headers).status_code == 403
    headers = {"X-Forwarded-For": "1.1.1.1, 203.0.113.70"}
    assert code(trio.join("x", headers=headers)) == "RATE_LIMITED"


def test_hops_zero_in_the_app_uses_the_socket_peer(make_trio):
    trio = make_trio(trusted_proxy_hops=0)
    for i in range(10):
        response = trio.join("x", code="wrong", headers={"X-Forwarded-For": f"198.51.100.{i}"})
        assert response.status_code == 403
    # Every request came from the same peer ("testclient"), whatever the header said.
    assert code(trio.join("x", headers={"X-Forwarded-For": "198.51.100.99"})) == "RATE_LIMITED"


# -- the global failure ceiling ----------------------------------------------------------


def test_brute_force_with_a_fresh_address_per_guess_is_bounded(trio):
    """The reviewer's bypass: every guess from a new spoofed address."""
    checked = 0
    for i in range(1200):
        # Two guesses a second for ten minutes, never the same address twice.
        trio.clock.value += 0.5
        headers = {"X-Forwarded-For": f"10.{i // 250}.{i % 250}.1"}
        response = trio.join("x", code=f"guess-{i}", headers=headers)
        if response.status_code == 403:
            checked += 1
        else:
            assert code(response) == "RATE_LIMITED"
            assert 1 <= int(response.headers["retry-after"]) <= 600
    # 30 before the ceiling, then one per 10 s trickle slot over 600 s.
    assert checked <= 30 + 61
    assert checked >= 30


def test_link_code_guesses_count_towards_the_same_ceiling(trio):
    for i in range(30):
        response = trio.client.post(
            "/api/join",
            json={"link_code": "ZZZZZZZZZZ"},
            headers={"X-Forwarded-For": f"10.1.{i}.1"},
        )
        assert code(response) == "INVALID_LINK_CODE"
    assert trio.client.app.state.join_guard.overflowing
    trio.join("x", code="wrong", headers={"X-Forwarded-For": "10.2.0.1"})  # takes the slot
    response = trio.join("x", code="wrong", headers={"X-Forwarded-For": "10.2.0.2"})
    assert code(response) == "RATE_LIMITED"


def test_a_flood_of_failures_does_not_lock_the_right_code_out(trio):
    """During a flood a friend with the right code still gets in within a trickle slot."""
    attackers = [f"10.3.{i}.1" for i in range(40)]
    for address in attackers:
        trio.join("x", code="wrong", headers={"X-Forwarded-For": address})
    assert trio.client.app.state.join_guard.overflowing
    trio.clock.value += 10
    # The flood keeps coming from addresses that already failed: none of it
    # is checked, so none of it takes the slot.
    for _ in range(5):
        for address in attackers[:9]:
            response = trio.join("x", code="wrong", headers={"X-Forwarded-For": address})
            assert code(response) == "RATE_LIMITED"
    friend = trio.join("Zeynep", headers={"X-Forwarded-For": "203.0.113.200"})
    assert friend.status_code == 201
    # Right after, the next clean caller waits for the next slot (at most 10 s) ...
    late = trio.join("Ece", headers={"X-Forwarded-For": "203.0.113.201"})
    assert code(late) == "RATE_LIMITED"
    assert int(late.headers["retry-after"]) <= 10
    trio.clock.value += 10
    assert trio.join("Ece", headers={"X-Forwarded-For": "203.0.113.201"}).status_code == 201
    # ... and the ceiling lifts by itself once the failures are ten minutes old.
    trio.clock.value += 600
    assert not trio.client.app.state.join_guard.overflowing


def test_successes_never_move_towards_the_ceiling(trio):
    for i in range(5):
        trio.user(f"u{i}")
    guard = trio.client.app.state.join_guard
    assert not guard.overflowing
    assert len(guard._failures) == 0


def test_invalid_name_with_the_right_code_is_not_a_failure(trio):
    for i in range(40):
        response = trio.join("", headers={"X-Forwarded-For": f"10.4.{i}.1"})
        assert code(response) == "INVALID_NAME"
    assert not trio.client.app.state.join_guard.overflowing


def test_guard_unit_bounds():
    clock = Clock()
    guard = JoinGuard(clock, global_failures=3, trickle_seconds=10, window_seconds=100)
    for i in range(3):
        assert guard.admit(f"a{i}") is None
        guard.failed(f"a{i}")
    assert guard.admit("a0") is not None  # failed before: never during overflow
    assert guard.admit("clean") is None  # the trickle slot
    assert guard.admit("clean2") == 10
    clock.value += 10
    assert guard.admit("clean2") is None
    clock.value += 101
    assert not guard.overflowing
    assert guard.admit("a0") is None


# -- limiter memory and cost ------------------------------------------------------------


def test_the_limiter_forgets_expired_keys_without_rebuilding():
    clock = Clock()
    window = SlidingWindow(10, 600, clock)
    for i in range(5000):
        window.allow(f"k{i}")
    clock.value += 601
    window.allow("fresh")
    assert len(window) == 1


def test_the_limiter_holds_at_most_max_keys():
    clock = Clock()
    window = SlidingWindow(10, 600, clock, max_keys=100)
    for i in range(1000):
        clock.value += 0.001
        window.allow(f"k{i}")
    assert len(window) == 100
    # The most recent keys are the ones kept.
    assert window.count("k999") == 1
    assert window.count("k0") == 0


def test_the_limiter_stays_fast_with_many_live_keys():
    """The reviewer measured 6 ms per join at 60 000 keys; this is O(1) amortised."""
    clock = Clock()
    window = SlidingWindow(10, 600, clock)
    for i in range(60_000):
        window.allow(f"k{i}")
    start = time.perf_counter()
    for i in range(2000):
        window.allow(f"x{i}")
    per_call = (time.perf_counter() - start) / 2000
    assert per_call < 0.0005  # 0.5 ms; in practice a few microseconds
    assert len(window) == 10_000


def test_a_join_with_the_correct_code_is_never_counted_as_a_failure(trio):
    response = trio.client.post("/api/join", json={"invite_code": INVITE, "name": "Ali"})
    assert response.status_code == 201
    assert not trio.client.app.state.join_guard._failures
