"""CONTRACT-V10-GROUPS: a small group (up to 10-15 people), not three friends.

The voice room cap (``TRIO_VOICE_ROOM_MAX``, ``ROOM_FULL``), the new
defaults, the typing limit, and a load test with fifteen members and thirty
sockets that checks the hub does its fan-out once per frame.
"""

from __future__ import annotations

import time

import pytest

from trio_server import hub as hub_module
from trio_server.config import ConfigError, Settings
from trio_server.hub import RESTART_RESUME_SECONDS, TYPING_LIMIT

from .test_ws import VOICE

NAMES = [
    "Ayşe",
    "Mehmet",
    "Zeynep",
    "Ali",
    "Berk",
    "Cem",
    "Deniz",
    "Ece",
    "Fatih",
    "Gül",
    "Hakan",
    "Irmak",
    "Kerem",
    "Lale",
    "Mert",
]


# Frames another socket's actions cause, in whatever order the sockets'
# tasks ran; skipped while waiting for the frame a test is about.
NOISE = {
    "presence",
    "voice.joined",
    "voice.left",
    "voice.state",
    "voice.ring",
    "channel.new",
    "typing",
}


def skip_to(sock, frame_type: str) -> dict:
    while True:
        frame = sock.receive_json()
        if frame["type"] == frame_type:
            return frame
        assert frame["type"] in NOISE, frame


def join(sock, channel_id: int = VOICE, **flags) -> dict:
    sock.send_json({"type": "voice.join", "channel_id": channel_id, **flags})
    peers = skip_to(sock, "voice.peers")
    skip_to(sock, "voice.joined")
    return peers


def room_full(sock) -> dict:
    frame = skip_to(sock, "error")
    assert frame["code"] == "ROOM_FULL", frame
    return frame


def collect(sock, frame_type: str, count: int) -> list[dict]:
    """The next ``count`` frames of ``frame_type`` (others skipped)."""
    out = []
    while len(out) < count:
        frame = sock.receive_json()
        if frame["type"] == frame_type:
            out.append(frame)
    return out


# -- configuration -------------------------------------------------------------


def test_the_defaults_are_for_a_small_group():
    settings = Settings.from_env({"TRIO_INVITE_CODE": "x"})
    assert settings.max_users == 15
    assert settings.voice_room_max == 8


@pytest.mark.parametrize("value", ["2", "8", "16"])
def test_the_room_cap_is_read_from_the_environment(value):
    settings = Settings.from_env({"TRIO_INVITE_CODE": "x", "TRIO_VOICE_ROOM_MAX": value})
    assert settings.voice_room_max == int(value)


@pytest.mark.parametrize("value", ["1", "0", "17", "-3", "çok"])
def test_a_room_cap_out_of_bounds_refuses_to_start(value):
    with pytest.raises(ConfigError, match="TRIO_VOICE_ROOM_MAX"):
        Settings.from_env({"TRIO_INVITE_CODE": "x", "TRIO_VOICE_ROOM_MAX": value})


def test_the_cap_is_in_ready_and_in_get_server(make_trio):
    trio = make_trio(voice_room_max=5)
    ali = trio.user("Ali")
    with trio.ws(ali) as a:
        assert a.ready["voice_room_max"] == 5
    body = trio.client.get("/api/server", headers=ali["auth"]).json()
    assert body["voice_room_max"] == 5
    assert body["server"]["name"] == "Trio"


def test_fifteen_people_can_join_by_default(trio):
    for name in NAMES:
        trio.user(name)
    assert trio.join("Nur").status_code == 409


# -- the room cap ----------------------------------------------------------------


def test_a_full_room_refuses_the_next_join(make_trio):
    trio = make_trio(voice_room_max=2)
    trio.clock.value += RESTART_RESUME_SECONDS + 1
    ali, berk, cem = trio.user("Ali"), trio.user("Berk"), trio.user("Cem")
    with trio.ws(ali) as a, trio.ws(berk) as b, trio.ws(cem) as c:
        join(a)
        join(b)
        c.send_json({"type": "voice.join", "channel_id": VOICE})
        frame = room_full(c)
        assert frame == {
            "type": "error",
            "code": "ROOM_FULL",
            "message": frame["message"],
            "request": "voice.join",
            "channel_id": VOICE,
            "limit": 2,
        }
        # Nothing changed.
        assert set(trio.client.app.state.hub.voice[VOICE]) == {ali["id"], berk["id"]}
        # A resume from somebody who was never in the room counts too.
        c.send_json({"type": "voice.join", "channel_id": VOICE, "resume": True})
        room_full(c)
        # Another room is open; a place that frees up can be taken.
        b.send_json({"type": "voice.leave"})
        join(c)


def test_a_member_rejoining_from_another_tab_is_not_counted(make_trio):
    trio = make_trio(voice_room_max=2)
    trio.clock.value += RESTART_RESUME_SECONDS + 1
    ali, berk = trio.user("Ali"), trio.user("Berk")
    with trio.ws(ali) as a, trio.ws(berk) as b:
        join(a)
        join(b)
        with trio.ws(berk) as b2:
            b2.send_json({"type": "voice.join", "channel_id": VOICE})
            assert skip_to(b2, "voice.peers")["peers"] == [ali["id"]]


def test_a_resume_inside_the_grace_takes_its_place_back_in_a_full_room(make_trio):
    trio = make_trio(voice_room_max=2)
    trio.clock.value += RESTART_RESUME_SECONDS + 1
    ali, berk, cem = trio.user("Ali"), trio.user("Berk"), trio.user("Cem")
    with trio.ws(ali) as a, trio.ws(cem) as c:
        join(a)
        with trio.ws(berk) as b:
            join(b, session="call-1")
        # Berk's socket dropped: still listed (reconnecting), the room is still full.
        assert skip_to(a, "voice.state")["reconnecting"] is True
        c.send_json({"type": "voice.join", "channel_id": VOICE})
        assert room_full(c)["limit"] == 2
        with trio.ws(berk) as b:
            b.send_json(
                {"type": "voice.join", "channel_id": VOICE, "resume": True, "session": "call-1"}
            )
            assert skip_to(b, "voice.peers")["resumed"] is True


def test_resumes_right_after_a_start_are_never_refused(make_trio):
    # A deploy: the server forgot the rooms, everybody comes back with resume.
    trio = make_trio(voice_room_max=2)
    people = [trio.user(name) for name in NAMES[:3]]
    with trio.ws(people[0]) as a, trio.ws(people[1]) as b, trio.ws(people[2]) as c:
        join(a, resume=True)
        join(b, resume=True)
        join(c, resume=True)
        assert len(trio.client.app.state.hub.voice[VOICE]) == 3
        # After the window an ordinary join into the (over-full) room is refused.
        trio.clock.value += RESTART_RESUME_SECONDS
        with trio.ws(trio.user("Deniz")) as d:
            d.send_json({"type": "voice.join", "channel_id": VOICE})
            room_full(d)


def test_the_cap_counts_one_room_not_the_server(make_trio):
    trio = make_trio(voice_room_max=2)
    trio.clock.value += RESTART_RESUME_SECONDS + 1
    ali, berk, cem = trio.user("Ali"), trio.user("Berk"), trio.user("Cem")
    other = trio.client.post(
        "/api/channels", json={"name": "oyun", "kind": "voice"}, headers=ali["auth"]
    ).json()["channel"]["id"]
    with trio.ws(ali) as a, trio.ws(berk) as b, trio.ws(cem) as c:
        join(a)
        join(b)
        join(c, channel_id=other)


# -- typing --------------------------------------------------------------------


def test_typing_is_limited_per_user_and_dropped_silently(trio):
    ali, berk = trio.user("Ali"), trio.user("Berk")
    with trio.ws(ali) as a, trio.ws(berk) as b:
        for _ in range(TYPING_LIMIT + 5):
            a.send_json({"type": "typing", "channel_id": 1})
        # No error frames for the dropped ones.
        assert [f for f in drain_until_pong(a) if f["type"] == "error"] == []
        seen = 0
        b.send_json({"type": "ping"})
        while (frame := b.receive_json())["type"] != "pong":
            assert frame["type"] == "typing"
            seen += 1
        assert seen == TYPING_LIMIT
        trio.clock.value += 11
        a.send_json({"type": "typing", "channel_id": 1})
        assert skip_to(b, "typing")["user_id"] == ali["id"]


# -- load: fifteen members, thirty sockets ---------------------------------------


class CountingJson:
    """``json`` for the hub module, counting how often a frame is serialised."""

    def __init__(self) -> None:
        import json

        self._json = json
        self.dumps_calls = 0

    def dumps(self, *args, **kwargs):
        self.dumps_calls += 1
        return self._json.dumps(*args, **kwargs)

    def __getattr__(self, name):
        return getattr(self._json, name)


def ali_not_echoed(frames: list[dict], own_id: int) -> bool:
    return all(f["user_id"] != own_id for f in frames)


def drain_until_pong(sock) -> list[dict]:
    sock.send_json({"type": "ping"})
    frames = []
    while (frame := sock.receive_json())["type"] != "pong":
        frames.append(frame)
    return frames


def test_fifteen_members_thirty_sockets(trio, monkeypatch):
    users = [trio.user(name) for name in NAMES]
    hub = trio.client.app.state.hub
    contexts = []
    socks = []
    started = time.perf_counter()
    for user in users:
        for _ in range(2):
            ctx = trio.ws(user)
            socks.append(ctx.__enter__())
            contexts.append(ctx)
    try:
        assert sum(hub.connection_count(u["id"]) for u in users) == 30
        # Everybody's last ready lists everybody online.
        assert all(u["online"] for u in socks[-1].ready["users"])
        for sock in socks:
            drain_until_pong(sock)

        counting = CountingJson()
        monkeypatch.setattr(hub_module, "json", counting)
        per_user = 4
        for round_ in range(per_user):
            for i, user in enumerate(users):
                socks[2 * i].send_json(
                    {
                        "type": "message.send",
                        "channel_id": 1,
                        "content": f"{user['name']} {round_}",
                        "nonce": f"n-{user['id']}-{round_}",
                    }
                )
        sent = per_user * len(users)
        for sock in socks:
            messages = collect(sock, "message.new", sent)
            ids = [m["message"]["id"] for m in messages]
            assert ids == sorted(ids), "every socket sees the messages in id order"
        # One serialisation per broadcast and one for the sender's own copy
        # (it carries the nonce): never one per receiving socket.
        assert counting.dumps_calls <= 2 * sent, counting.dumps_calls

        # Typing from everybody at once: one frame per typer to each other socket.
        counting.dumps_calls = 0
        for i in range(len(users)):
            socks[2 * i].send_json({"type": "typing", "channel_id": 1})
        for i, sock in enumerate(socks):
            typing = collect(sock, "typing", len(users) - 1)
            assert ali_not_echoed(typing, users[i // 2]["id"])
        assert counting.dumps_calls == len(users)
        for sock in socks:
            assert [f for f in drain_until_pong(sock) if f["type"] == "typing"] == []

        # Presence churn: one member's two tabs closing and coming back, five times.
        churner = users[0]
        for _ in range(5):
            for ctx in contexts[:2]:
                ctx.__exit__(None, None, None)
            contexts[0] = trio.ws(churner)
            contexts[1] = trio.ws(churner)
            socks[0] = contexts[0].__enter__()
            socks[1] = contexts[1].__enter__()
        for sock in socks[2:]:
            presence = collect(sock, "presence", 10)
            # Only the first socket coming up and the last going away are news.
            assert [f["online"] for f in presence] == [False, True] * 5
            assert [f for f in drain_until_pong(sock) if f["type"] == "presence"] == []
        assert hub.connection_count(churner["id"]) == 2
    finally:
        for ctx in contexts:
            ctx.__exit__(None, None, None)
    elapsed = time.perf_counter() - started
    # Generous: the point is that it is seconds, not minutes, on one process.
    assert elapsed < 60, elapsed
    assert not hub.conns


def test_a_voice_room_of_eight_relays_signals_only_inside_it(make_trio):
    trio = make_trio()
    trio.clock.value += RESTART_RESUME_SECONDS + 1
    users = [trio.user(name) for name in NAMES[:9]]
    contexts = [trio.ws(user) for user in users]
    socks = [ctx.__enter__() for ctx in contexts]
    try:
        for sock in socks:
            drain_until_pong(sock)
        for i, sock in enumerate(socks[:8]):
            peers = join(sock)
            assert len(peers["peers"]) == i
        # The ninth is refused; nothing reaches the eight.
        socks[8].send_json({"type": "voice.join", "channel_id": VOICE})
        assert room_full(socks[8])["limit"] == 8
        # Everybody signals everybody: n·(n-1) relayed frames, each to one socket.
        for i, sock in enumerate(socks[:8]):
            for j, target in enumerate(users[:8]):
                if i != j:
                    sock.send_json({"type": "signal", "to": target["id"], "data": {"n": i}})
        for j, sock in enumerate(socks[:8]):
            signals = collect(sock, "signal", 7)
            assert sorted(f["data"]["n"] for f in signals) == [i for i in range(8) if i != j]
        assert [f for f in drain_until_pong(socks[8]) if f["type"] == "signal"] == []
    finally:
        for ctx in contexts:
            ctx.__exit__(None, None, None)


def test_ready_for_fifteen_is_small():
    hub = hub_module.Hub(now=lambda: 0.0)
    hub.load(
        [{"id": i, "name": n, "avatar_url": None} for i, n in enumerate(NAMES, 1)],
        [{"id": 1, "name": "genel", "kind": "text"}, {"id": 2, "name": "Sohbet", "kind": "voice"}],
    )
    import json

    frame = hub.ready_frame(1)
    assert len(frame["users"]) == 15
    # A ready frame for the whole group stays a few kilobytes.
    assert len(json.dumps(frame)) < 4096


def test_a_full_room_cannot_ring(make_trio):
    trio = make_trio(voice_room_max=2)
    ali, berk, cem = trio.user("Ali"), trio.user("Berk"), trio.user("Cem")
    with trio.ws(ali) as a, trio.ws(berk) as b, trio.ws(cem) as c:
        join(a)
        a.send_json({"type": "voice.ring", "channel_id": VOICE})
        assert skip_to(c, "voice.ring")["from"] == ali["id"]
        join(b)
        a.send_json({"type": "voice.ring", "channel_id": VOICE})
        frame = room_full(a)
        assert frame["request"] == "voice.ring"
        assert frame["limit"] == 2
        assert [f for f in drain_until_pong(c) if f["type"] == "voice.ring"] == []


def test_fifteen_joins_from_one_address_are_not_refused(trio):
    """A group setting up on one network: successes give their attempt back."""
    here = {"X-Forwarded-For": "203.0.113.50"}
    for name in NAMES:
        assert trio.join(name, headers=here).status_code == 201
    # Wrong codes from the same address are still limited at ten.
    for _ in range(10):
        assert trio.join("x", code="wrong", headers=here).status_code == 403
    assert trio.join("x", code="wrong", headers=here).status_code == 429
