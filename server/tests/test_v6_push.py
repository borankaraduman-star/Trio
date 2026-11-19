"""CONTRACT-V6-PUSH against the running app: keys, subscriptions, what is pushed, the queue."""

from __future__ import annotations

import asyncio
import json
import threading
import time
from typing import Any

import httpx
import pytest
from cryptography.hazmat.primitives.asymmetric import ec

from trio_server.db import Database
from trio_server.push_crypto import b64url, decrypt, public_point, verify_jwt

FCM = "https://fcm.googleapis.com/fcm/send/"
FCM_IP = "142.250.184.10"


async def public_dns(host: str, port: int) -> list[str]:
    return [FCM_IP]


class FakePushService:
    """A push service behind httpx.MockTransport; requests are kept for the test to read."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.cond = threading.Condition()
        self.status = 201
        self.statuses: list[int] = []  # consumed first, then ``status``
        self.headers: dict[str, str] = {}
        self.gate: threading.Event | None = None

    async def handler(self, request: httpx.Request) -> httpx.Response:
        if self.gate is not None:
            # A thread-safe gate: the test thread opens it.
            await asyncio.to_thread(self.gate.wait)
        await request.aread()
        with self.cond:
            self.requests.append(request)
            status = self.statuses.pop(0) if self.statuses else self.status
            self.cond.notify_all()
        return httpx.Response(status, headers=self.headers)

    def wait_for(self, count: int, timeout: float = 5.0) -> list[httpx.Request]:
        with self.cond:
            ok = self.cond.wait_for(lambda: len(self.requests) >= count, timeout)
        assert ok, f"expected {count} push requests, got {len(self.requests)}"
        return list(self.requests)

    @property
    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handler)


class Device:
    """A browser's push subscription: the keys the test decrypts with."""

    def __init__(self, name: str) -> None:
        self.private = ec.generate_private_key(ec.SECP256R1())
        self.auth = b"auth-" + name.encode()[:11].ljust(11, b"_")
        self.endpoint = FCM + name

    def body(self, **extra: Any) -> dict[str, Any]:
        return {
            "endpoint": self.endpoint,
            "keys": {
                "p256dh": b64url(public_point(self.private.public_key())),
                "auth": b64url(self.auth),
            },
            "ua_family": "chrome",
            "label": "Telefon",
            **extra,
        }

    def read(self, request: httpx.Request) -> dict[str, Any]:
        return json.loads(decrypt(request.content, self.private, self.auth))


@pytest.fixture
def service() -> FakePushService:
    return FakePushService()


@pytest.fixture
def app(make_trio, service):
    return make_trio(http_transport=service.transport, push_resolver=public_dns)


def subscribe(app, user, device) -> dict[str, Any]:
    response = app.client.put("/api/push/subscriptions", json=device.body(), headers=user["auth"])
    assert response.status_code == 200, response.text
    return response.json()["subscription"]


def wait_idle(app, timeout: float = 5.0) -> None:
    """Until the send queue is empty and every worker is done with its item."""
    sender = app.client.app.state.push_sender
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if sender.queue.empty() and sender.queue._unfinished_tasks == 0:  # noqa: SLF001
            return
        time.sleep(0.005)
    raise AssertionError("push queue did not drain")


def until(sock, kind: str) -> dict[str, Any]:
    """The next frame of ``kind`` (presence and the like in between are skipped)."""
    while True:
        frame = sock.receive_json()
        if frame["type"] == kind:
            return frame


def settle(sock) -> None:
    """Every frame sent before this has been handled by the server."""
    sock.send_json({"type": "ping"})
    until(sock, "pong")


def viewing(sock, value: bool, channel_id: int | None = None) -> None:
    sock.send_json({"type": "client.viewing", "viewing": value, "channel_id": channel_id})
    settle(sock)


def post(sock, channel_id: int, content: str) -> dict[str, Any]:
    sock.send_json(
        {
            "type": "message.send",
            "channel_id": channel_id,
            "content": content,
            "nonce": content[:60],
        }
    )
    return until(sock, "message.new")["message"]


# -- keys ---------------------------------------------------------------------------


def test_the_vapid_key_is_made_once_and_survives_a_restart(make_trio, tmp_path):
    path = str(tmp_path / "keep.db")
    first = make_trio(db_path=path)
    user = first.user("Ayşe")
    key = first.client.get("/api/push/key", headers=user["auth"]).json()["public_key"]
    assert len(key) == 87
    second = make_trio(db_path=path)
    assert second.client.get("/api/push/key", headers=user["auth"]).json()["public_key"] == key
    assert first.client.get("/api/push/key").status_code == 401


def test_a_database_from_before_gains_the_push_tables(make_trio, tmp_path):
    path = str(tmp_path / "old.db")

    async def old_shape() -> None:
        db = Database(path)
        await db.open()  # the v5 schema only
        rows = await db._all("SELECT name FROM sqlite_master WHERE name LIKE 'push_%'")
        assert rows == []
        await db.close()

    asyncio.run(old_shape())
    app = make_trio(db_path=path)
    user = app.user("Ayşe")
    assert app.client.get("/api/push/prefs", headers=user["auth"]).status_code == 200
    assert app.client.get("/api/push/subscriptions", headers=user["auth"]).json() == {
        "subscriptions": []
    }


# -- subscriptions ------------------------------------------------------------------


def test_subscription_crud_cap_and_ownership(app):
    ayse, mehmet = app.user("Ayşe"), app.user("Mehmet")
    phone = Device("phone")
    sub = subscribe(app, ayse, phone)
    assert sub["label"] == "Telefon" and sub["ua_family"] == "chrome"
    assert "endpoint" not in sub
    # The same endpoint again is the same subscription.
    assert subscribe(app, ayse, phone)["id"] == sub["id"]
    listed = app.client.get("/api/push/subscriptions", headers=ayse["auth"]).json()["subscriptions"]
    assert [s["id"] for s in listed] == [sub["id"]]
    assert app.client.get("/api/push/subscriptions", headers=mehmet["auth"]).json() == {
        "subscriptions": []
    }
    # Somebody else's id is not found (not "forbidden": ids are not disclosed).
    gone = app.client.delete(f"/api/push/subscriptions/{sub['id']}", headers=mehmet["auth"])
    assert gone.status_code == 404
    for n in range(9):
        subscribe(app, ayse, Device(f"d{n}"))
    over = app.client.put(
        "/api/push/subscriptions", json=Device("eleventh").body(), headers=ayse["auth"]
    )
    assert over.status_code == 409 and over.json()["error"]["code"] == "TOO_MANY_SUBSCRIPTIONS"
    assert (
        app.client.delete(f"/api/push/subscriptions/{sub['id']}", headers=ayse["auth"]).status_code
        == 204
    )
    assert (
        app.client.delete(f"/api/push/subscriptions/{sub['id']}", headers=ayse["auth"]).status_code
        == 404
    )
    subscribe(app, ayse, Device("eleventh"))
    assert app.client.put("/api/push/subscriptions", json=phone.body()).status_code == 401


def test_a_browser_that_signs_in_as_somebody_else_moves_its_subscription(app):
    ayse, mehmet = app.user("Ayşe"), app.user("Mehmet")
    shared = Device("shared")
    subscribe(app, ayse, shared)
    subscribe(app, mehmet, shared)
    assert app.client.get("/api/push/subscriptions", headers=ayse["auth"]).json() == {
        "subscriptions": []
    }


@pytest.mark.parametrize(
    "patch,code",
    [
        ({"endpoint": "https://evil.example/push"}, "PUSH_ENDPOINT_NOT_ALLOWED"),
        ({"endpoint": "http://fcm.googleapis.com/fcm/send/x"}, "PUSH_ENDPOINT_NOT_ALLOWED"),
        ({"endpoint": "https://169.254.169.254/latest/meta-data"}, "PUSH_ENDPOINT_NOT_ALLOWED"),
        ({"keys": {"p256dh": "AAAA", "auth": "AAAA"}}, "INVALID_SUBSCRIPTION"),
        ({"keys": None}, "INVALID_SUBSCRIPTION"),
    ],
)
def test_bad_subscriptions_are_refused(app, patch, code):
    user = app.user("Ayşe")
    response = app.client.put(
        "/api/push/subscriptions", json=Device("x").body(**patch), headers=user["auth"]
    )
    assert response.status_code == 422 and response.json()["error"]["code"] == code


def test_signing_out_ends_that_devices_pushes(app, service):
    ayse, mehmet = app.user("Ayşe"), app.user("Mehmet")
    subscribe(app, ayse, Device("phone"))
    assert app.client.delete("/api/session", headers=ayse["auth"]).status_code == 204
    text = app.channel_id("text")
    with app.ws(mehmet) as m:
        post(m, text, "kimse yok mu")
    wait_idle(app)
    assert service.requests == []


def test_a_revoked_token_gets_nothing_even_before_cleanup(app, service):
    ayse, mehmet = app.user("Ayşe"), app.user("Mehmet")
    subscribe(app, ayse, Device("phone"))
    db = app.client.app.state.db

    async def revoke() -> None:
        await db.conn.execute("DELETE FROM tokens WHERE user_id = ?", (ayse["id"],))
        await db.conn.commit()

    app.client.portal.call(revoke)
    with app.ws(mehmet) as m:
        post(m, app.channel_id("text"), "selam")
    wait_idle(app)
    assert service.requests == []


# -- what is pushed --------------------------------------------------------------------


def test_a_message_reaches_a_device_that_is_not_viewing_and_decrypts(app, service):
    ayse, mehmet = app.user("Ayşe"), app.user("Mehmet")
    phone = Device("phone")
    subscribe(app, ayse, phone)
    text = app.channel_id("text")
    with app.ws(ayse) as a, app.ws(mehmet) as m:
        viewing(a, True, text)
        post(m, text, "görüyor musun")
        until(a, "message.new")
        wait_idle(app)
        assert service.requests == []
        viewing(a, False)
        message = post(m, text, "şimdi bakmıyorsun")
        request = service.wait_for(1)[0]
    assert request.url.host == FCM_IP
    assert request.headers["host"] == "fcm.googleapis.com"
    assert request.extensions["sni_hostname"] == "fcm.googleapis.com"
    assert request.url.path == "/fcm/send/phone"
    assert request.headers["content-encoding"] == "aes128gcm"
    assert request.headers["ttl"] == str(6 * 3600)
    assert request.headers["urgency"] == "high"
    assert len(request.content) <= 4096
    assert phone.read(request) == {
        "v": 1,
        "kind": "message",
        "title": "Mehmet · #genel",
        "author": "Mehmet",
        "channel": "genel",
        "body": "şimdi bakmıyorsun",
        "tag": f"ch-{text}",
        "channel_id": text,
        "message_id": message["id"],
    }
    scheme, _, params = request.headers["authorization"].partition(" ")
    assert scheme == "vapid"
    fields = dict(part.strip().split("=", 1) for part in params.split(","))
    key = app.client.get("/api/push/key", headers=ayse["auth"]).json()["public_key"]
    assert fields["k"] == key
    claims = verify_jwt(fields["t"], key)
    assert claims["aud"] == "https://fcm.googleapis.com"
    assert claims["exp"] - app.clock.value <= 24 * 3600
    assert str(claims["sub"]).startswith(("mailto:", "https://"))


def test_no_push_for_my_own_message_or_while_any_device_views(app, service):
    ayse, mehmet = app.user("Ayşe"), app.user("Mehmet")
    subscribe(app, ayse, Device("phone"))
    subscribe(app, mehmet, Device("mehmet"))
    text = app.channel_id("text")
    with app.ws(ayse) as desk, app.ws(ayse) as phone_tab, app.ws(mehmet) as m:
        viewing(desk, False)
        viewing(phone_tab, True, 99)  # looking at the app, another channel
        viewing(m, False)
        post(m, text, "bir")
        until(desk, "message.new")
        until(phone_tab, "message.new")
        wait_idle(app)
        assert service.requests == []  # Ayşe views somewhere; Mehmet wrote it
        viewing(phone_tab, False)
        post(m, text, "iki")
        assert len(service.wait_for(1)) == 1
        wait_idle(app)
        assert len(service.requests) == 1


def test_a_connection_that_never_reports_counts_as_viewing_for_30_seconds(app, service):
    ayse, mehmet = app.user("Ayşe"), app.user("Mehmet")
    subscribe(app, ayse, Device("phone"))
    text = app.channel_id("text")
    with app.ws(ayse) as a, app.ws(mehmet) as m:
        post(m, text, "eski istemci")
        until(a, "message.new")
        wait_idle(app)
        assert service.requests == []
        app.clock.value += 31
        post(m, text, "artık bakmıyor sayılır")
        service.wait_for(1)


def test_offline_users_are_pushed(app, service):
    ayse, mehmet = app.user("Ayşe"), app.user("Mehmet")
    phone = Device("phone")
    subscribe(app, ayse, phone)
    with app.ws(mehmet) as m:
        post(m, app.channel_id("text"), "çevrimdışısın")
        assert phone.read(service.wait_for(1)[0])["body"] == "çevrimdışısın"


def test_levels_and_mentions(app, service):
    ayse, mehmet = app.user("Ayşe"), app.user("Mehmet")
    phone = Device("phone")
    subscribe(app, ayse, phone)
    text = app.channel_id("text")
    response = app.client.put(
        "/api/push/prefs", json={"channels": {str(text): "mentions"}}, headers=ayse["auth"]
    )
    assert response.status_code == 200
    with app.ws(mehmet) as m:
        post(m, text, "sıradan")
        wait_idle(app)
        assert service.requests == []
        post(m, text, "@AYŞE bakar mısın")
        got = phone.read(service.wait_for(1)[0])
        assert got["kind"] == "mention" and got["renotify"] is True
        app.client.put(
            "/api/push/prefs", json={"channels": {str(text): "none"}}, headers=ayse["auth"]
        )
        post(m, text, "@herkes kapalıyken bile")
        wait_idle(app)
        assert len(service.requests) == 1


def test_quiet_hours_hold_messages_but_not_mentions(app, service):
    ayse, mehmet = app.user("Ayşe"), app.user("Mehmet")
    phone = Device("phone")
    subscribe(app, ayse, phone)
    # The test clock is 2027-01-15 08:00 UTC = 11:00 in Istanbul.
    app.client.put(
        "/api/push/prefs",
        json={
            "quiet": {"enabled": True, "start": "10:00", "end": "12:00", "tz": "Europe/Istanbul"}
        },
        headers=ayse["auth"],
    )
    text = app.channel_id("text")
    with app.ws(mehmet) as m:
        post(m, text, "sessiz saat")
        wait_idle(app)
        assert service.requests == []
        post(m, text, "@herkes acil")
        assert phone.read(service.wait_for(1)[0])["kind"] == "mention"


def test_a_room_opening_is_announced_with_a_cooldown(app, service):
    ayse, mehmet, can = app.user("Ayşe"), app.user("Mehmet"), app.user("Can")
    phone, can_phone = Device("phone"), Device("can")
    subscribe(app, ayse, phone)
    subscribe(app, can, can_phone)
    voice = app.channel_id("voice")
    with app.ws(mehmet) as m, app.ws(can) as c:
        viewing(c, False)
        c.send_json({"type": "voice.join", "channel_id": voice})  # Can is already in voice
        while c.receive_json()["type"] != "voice.joined":
            pass
        c.send_json({"type": "voice.leave"})
        c.receive_json()
        wait_idle(app)
        service.requests.clear()
        app.clock.value += 601  # Can's own opening started a cool-down
        m.send_json({"type": "voice.join", "channel_id": voice})
        requests = service.wait_for(2)
        got = phone.read(next(r for r in requests if r.url.path == "/fcm/send/phone"))
        assert got == {
            "v": 1,
            "kind": "voice",
            "title": "Mehmet ses odasına girdi",
            "body": "🔊 Sohbet",
            "tag": f"voice-{voice}",
            "channel_id": voice,
        }
        assert {r.url.path for r in service.requests} == {"/fcm/send/phone", "/fcm/send/can"}
        m.send_json({"type": "voice.leave"})
        app.clock.value += 300
        m.send_json({"type": "voice.join", "channel_id": voice})
        wait_idle(app)
        assert len(service.requests) == 2  # within 10 minutes: not again
        m.send_json({"type": "voice.leave"})
        app.clock.value += 301
        m.send_json({"type": "voice.join", "channel_id": voice})
        service.wait_for(4)


def test_nobody_in_voice_is_told_a_room_opened(app, service):
    ayse, mehmet = app.user("Ayşe"), app.user("Mehmet")
    subscribe(app, ayse, Device("phone"))
    voice = app.channel_id("voice")
    second = app.client.post(
        "/api/channels", json={"name": "Oyun", "kind": "voice"}, headers=ayse["auth"]
    ).json()["channel"]["id"]
    with app.ws(ayse) as a, app.ws(mehmet) as m:
        viewing(a, False)
        a.send_json({"type": "voice.join", "channel_id": second})
        while a.receive_json()["type"] != "voice.joined":
            pass
        wait_idle(app)
        service.requests.clear()
        m.send_json({"type": "voice.join", "channel_id": voice})
        while m.receive_json()["type"] != "voice.joined":
            pass
        wait_idle(app)
        assert service.requests == []


def test_a_ring_is_pushed_and_quiet_hours_win_unless_allowed(app, service):
    ayse, mehmet = app.user("Ayşe"), app.user("Mehmet")
    phone = Device("phone")
    subscribe(app, ayse, phone)
    voice = app.channel_id("voice")
    app.client.put("/api/push/prefs", json={"voice_rooms": False}, headers=ayse["auth"])
    with app.ws(mehmet) as m:
        m.send_json({"type": "voice.join", "channel_id": voice})
        while m.receive_json()["type"] != "voice.joined":
            pass
        m.send_json({"type": "voice.ring", "channel_id": voice})
        request = service.wait_for(1)[0]
        assert phone.read(request)["kind"] == "ring"
        assert request.headers["ttl"] == "60"
        app.client.put(
            "/api/push/prefs",
            json={"quiet": {"enabled": True, "start": "10:00", "end": "12:00"}},
            headers=ayse["auth"],
        )
        app.clock.value += 31
        m.send_json({"type": "voice.ring", "channel_id": voice})
        settle(m)
        wait_idle(app)
        assert len(service.requests) == 1
        app.client.put("/api/push/prefs", json={"calls_break_quiet": True}, headers=ayse["auth"])
        app.clock.value += 31
        m.send_json({"type": "voice.ring", "channel_id": voice})
        service.wait_for(2)
        app.client.put("/api/push/prefs", json={"calls": False}, headers=ayse["auth"])
        app.clock.value += 31
        m.send_json({"type": "voice.ring", "channel_id": voice})
        settle(m)
        wait_idle(app)
        assert len(service.requests) == 2


def test_client_viewing_is_checked(app):
    user = app.user("Ayşe")
    with app.ws(user) as sock:
        for frame in ({"viewing": "yes"}, {}, {"viewing": True, "channel_id": "x"}):
            sock.send_json({"type": "client.viewing", **frame})
            assert sock.receive_json()["code"] == "BAD_REQUEST"
        sock.send_json({"type": "client.viewing", "viewing": True})
        settle(sock)


# -- prefs --------------------------------------------------------------------------


def test_prefs_round_trip_and_survive_a_restart(make_trio, tmp_path):
    path = str(tmp_path / "prefs.db")
    first = make_trio(db_path=path)
    user = first.user("Ayşe")
    assert first.client.get("/api/push/prefs", headers=user["auth"]).json()["prefs"] == {
        "channels": {},
        "quiet": {"enabled": False, "start": "23:00", "end": "08:00", "tz": "Europe/Istanbul"},
        "voice_rooms": True,
        "calls": True,
        "calls_break_quiet": False,
    }
    bad = first.client.put(
        "/api/push/prefs", json={"quiet": {"tz": "Nope/Zone"}}, headers=user["auth"]
    )
    assert bad.status_code == 422 and bad.json()["error"]["code"] == "INVALID_PREFS"
    saved = first.client.put(
        "/api/push/prefs", json={"calls": False, "channels": {"1": "none"}}, headers=user["auth"]
    ).json()["prefs"]
    second = make_trio(db_path=path)
    assert second.client.get("/api/push/prefs", headers=user["auth"]).json()["prefs"] == saved


# -- the queue and the push service's answers ---------------------------------------


def test_a_gone_subscription_is_removed(app, service):
    ayse, mehmet = app.user("Ayşe"), app.user("Mehmet")
    subscribe(app, ayse, Device("phone"))
    service.statuses = [410]
    with app.ws(mehmet) as m:
        post(m, app.channel_id("text"), "yok artık")
        service.wait_for(1)
    wait_idle(app)
    assert app.client.get("/api/push/subscriptions", headers=ayse["auth"]).json() == {
        "subscriptions": []
    }


def test_5xx_and_429_are_retried_then_given_up(app, service):
    ayse, mehmet = app.user("Ayşe"), app.user("Mehmet")
    subscribe(app, ayse, Device("phone"))
    app.client.app.state.push_sender.retry_delays = (0.01, 0.01, 0.01)
    service.statuses = [503, 429, 201]
    with app.ws(mehmet) as m:
        post(m, app.channel_id("text"), "dene")
        service.wait_for(3)
        service.status = 500
        post(m, app.channel_id("text"), "hep hata")
        service.wait_for(7)  # 4 attempts, then nothing more
    wait_idle(app)
    subs = app.client.get("/api/push/subscriptions", headers=ayse["auth"]).json()["subscriptions"]
    assert subs[0]["last_error"] == "HTTP 500" and subs[0]["last_ok_at"] is not None
    assert len(service.requests) == 7


def test_a_redirect_is_not_followed(app, service):
    ayse, mehmet = app.user("Ayşe"), app.user("Mehmet")
    subscribe(app, ayse, Device("phone"))
    service.status = 307
    service.headers = {"location": "http://169.254.169.254/"}
    with app.ws(mehmet) as m:
        post(m, app.channel_id("text"), "yönlendirme")
        service.wait_for(1)
    wait_idle(app)
    assert all(r.url.host == FCM_IP for r in service.requests)
    assert len(service.requests) == 1


def test_a_rebinding_endpoint_is_never_requested(make_trio, service):
    answers = [["10.0.0.7"]]

    async def rebinding(host: str, port: int) -> list[str]:
        return answers[0]

    app = make_trio(http_transport=service.transport, push_resolver=rebinding)
    ayse, mehmet = app.user("Ayşe"), app.user("Mehmet")
    sub = subscribe(app, ayse, Device("phone"))  # the name alone is checked here
    with app.ws(mehmet) as m:
        post(m, app.channel_id("text"), "iç ağ")
    wait_idle(app)
    assert service.requests == []
    listed = app.client.get("/api/push/subscriptions", headers=ayse["auth"]).json()["subscriptions"]
    assert listed[0]["id"] == sub["id"]
    assert listed[0]["last_error"] == "endpoint resolves to a non-public address"


def test_a_slow_push_service_never_holds_chat_up(app, service):
    ayse, mehmet = app.user("Ayşe"), app.user("Mehmet")
    for n in range(5):
        subscribe(app, ayse, Device(f"d{n}"))
    service.gate = threading.Event()
    text = app.channel_id("text")
    try:
        with app.ws(ayse) as a, app.ws(mehmet) as m:
            viewing(a, False)
            for n in range(10):
                started = time.monotonic()
                post(m, text, f"mesaj {n}")
                assert until(a, "message.new")["message"]["content"] == f"mesaj {n}"
                assert time.monotonic() - started < 1.0
            assert service.requests == []
    finally:
        service.gate.set()
    service.wait_for(50)


def test_a_full_queue_drops_instead_of_blocking(app):
    sender = app.client.app.state.push_sender

    async def fill() -> int:
        for task in sender._tasks:  # noqa: SLF001 - stop the workers to fill the queue
            task.cancel()
        await asyncio.sleep(0)
        for _ in range(501):
            sender.enqueue([1], {"v": 1}, {"ttl": 1, "urgency": "normal"})
        return sender.dropped

    assert app.client.portal.call(fill) == 1


# -- the test button ---------------------------------------------------------------


def test_the_test_notification_reports_what_the_service_said(app, service):
    ayse, mehmet = app.user("Ayşe"), app.user("Mehmet")
    phone = Device("phone")
    sub = subscribe(app, ayse, phone)
    response = app.client.post(
        "/api/push/test", json={"subscription_id": sub["id"]}, headers=ayse["auth"]
    )
    assert response.json() == {"ok": True, "status": 201, "error": None, "removed": False}
    assert phone.read(service.requests[0])["kind"] == "test"
    other = app.client.post(
        "/api/push/test", json={"subscription_id": sub["id"]}, headers=mehmet["auth"]
    )
    assert other.status_code == 404
    service.statuses = [410]
    gone = app.client.post(
        "/api/push/test", json={"subscription_id": sub["id"]}, headers=ayse["auth"]
    )
    assert gone.json() == {"ok": False, "status": 410, "error": "HTTP 410", "removed": True}
    assert app.client.get("/api/push/subscriptions", headers=ayse["auth"]).json() == {
        "subscriptions": []
    }


def test_the_test_notification_is_rate_limited(app, service):
    ayse = app.user("Ayşe")
    sub = subscribe(app, ayse, Device("phone"))
    codes = [
        app.client.post(
            "/api/push/test", json={"subscription_id": sub["id"]}, headers=ayse["auth"]
        ).status_code
        for _ in range(6)
    ]
    assert codes == [200] * 5 + [429]


# -- serving the worker --------------------------------------------------------------


def test_the_service_worker_and_manifest_are_served_to_update_promptly(make_trio, tmp_path):
    static = tmp_path / "static"
    static.mkdir()
    (static / "index.html").write_text('<script type="module" src="/assets/i.js"></script>')
    (static / "sw.js").write_text("self.addEventListener('push', () => {})")
    (static / "manifest.webmanifest").write_text("{}")
    app = make_trio(static_dir=str(static))
    sw = app.client.get("/sw.js")
    assert sw.status_code == 200
    assert sw.headers["content-type"].startswith("text/javascript")
    assert sw.headers["cache-control"] == "no-cache"
    assert "default-src 'self'" in sw.headers["content-security-policy"]
    manifest = app.client.get("/manifest.webmanifest")
    assert manifest.headers["content-type"] == "application/manifest+json"
    assert manifest.headers["cache-control"] == "no-cache"
    shell = app.client.get("/")
    assert "worker-src 'self' blob:" in shell.headers["content-security-policy"]
    # A route of the app is the shell, never the worker; a missing .js is a 404.
    assert app.client.get("/kanal/3").text.startswith("<script")
    assert app.client.get("/sw2.js").status_code == 404
