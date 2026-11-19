from __future__ import annotations

import base64
import hashlib
import hmac
import mimetypes
import sqlite3

import pytest

from trio_server import Settings
from trio_server.config import ConfigError

from .conftest import INVITE


def error_code(response) -> str:
    body = response.json()
    assert set(body) == {"error"}
    assert set(body["error"]) == {"code", "message"}
    return body["error"]["code"]


# -- config -------------------------------------------------------------------


def test_the_server_refuses_to_start_without_an_invite_code():
    with pytest.raises(ConfigError):
        Settings.from_env({})
    with pytest.raises(ConfigError):
        Settings.from_env({"TRIO_INVITE_CODE": ""})


def test_settings_defaults_and_parsing():
    settings = Settings.from_env({"TRIO_INVITE_CODE": "x"})
    assert settings.db_path == "./trio.db"
    assert settings.max_users == 5  # v3: lowered from 10 (CONTRACT-V3 §1)
    assert settings.static_dir is None
    assert settings.stun_urls == ("stun:stun.l.google.com:19302",)
    settings = Settings.from_env(
        {"TRIO_INVITE_CODE": "x", "TRIO_STUN_URLS": "stun:a:1, stun:b:2", "TRIO_MAX_USERS": "3"}
    )
    assert settings.stun_urls == ("stun:a:1", "stun:b:2")
    assert settings.max_users == 3
    assert "hunter2" not in repr(Settings(invite_code="hunter2", turn_secret="hunter2"))


# -- health and join ----------------------------------------------------------


def test_health(trio):
    response = trio.client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"ok": True}


def test_join_ok(trio):
    response = trio.join("  Ayşe  ")
    assert response.status_code == 201
    body = response.json()
    assert set(body) == {"token", "user"}
    assert body["user"] == {"id": 1, "name": "Ayşe"}
    assert len(body["token"]) >= 43


def test_join_with_a_bad_code(trio):
    for code in ("wrong", "", INVITE + "x", INVITE.upper()):
        response = trio.join("Ali", code=code)
        assert response.status_code == 403
        assert error_code(response) == "INVALID_INVITE"
    response = trio.client.post("/api/join", json={"name": "Ali"})
    assert response.status_code == 403
    assert error_code(response) == "INVALID_INVITE"
    assert trio.client.app.state.hub.users == {}


def test_join_name_taken_case_insensitively(trio):
    assert trio.join("Işıl").status_code == 201
    assert trio.join("Élan").status_code == 201
    for name in ("Işıl", "IŞIL", " ışıl ", "élan", "ÉLAN"):
        response = trio.join(name)
        assert response.status_code == 409, name
        assert error_code(response) == "NAME_TAKEN"


@pytest.mark.parametrize("name", ["", "   ", "x" * 33, "a\nb", "a‮b", 5, None])
def test_join_invalid_name(trio, name):
    response = trio.join(name)
    assert response.status_code == 422
    assert error_code(response) == "INVALID_NAME"


def test_join_name_of_32_characters_is_allowed(trio):
    assert trio.join("x" * 32).status_code == 201


def test_join_server_full(make_trio):
    trio = make_trio(max_users=2)
    assert trio.join("a").status_code == 201
    assert trio.join("b").status_code == 201
    response = trio.join("c")
    assert response.status_code == 409
    assert error_code(response) == "SERVER_FULL"


def test_join_rate_limit_per_client_address(trio):
    here = {"X-Forwarded-For": "203.0.113.7"}
    for _ in range(10):
        assert trio.join("x", code="wrong", headers=here).status_code == 403
    # Even the right code is refused now.
    response = trio.join("x", headers=here)
    assert response.status_code == 429
    assert error_code(response) == "RATE_LIMITED"
    assert int(response.headers["retry-after"]) > 0
    # Somebody else is not affected ...
    assert trio.join("y", headers={"X-Forwarded-For": "203.0.113.8"}).status_code == 201
    # ... and the window passes.
    trio.clock.value += 601
    assert trio.join("x", headers=here).status_code == 201


def test_the_rate_limit_reads_the_rightmost_forwarded_entry(trio):
    for i in range(10):
        headers = {"X-Forwarded-For": f"10.0.0.{i}, 203.0.113.9"}
        assert trio.join("x", code="wrong", headers=headers).status_code == 403
    response = trio.join("x", headers={"X-Forwarded-For": "1.2.3.4, 203.0.113.9"})
    assert response.status_code == 429


def test_the_rate_limit_falls_back_to_the_socket_peer(trio):
    for _ in range(10):
        assert trio.join("x", code="wrong", headers={}).status_code == 403
    assert trio.join("x", code="wrong", headers={}).status_code == 429


def test_join_body_must_be_a_json_object(trio):
    for content in (b"not json", b"[1]", b'"x"'):
        response = trio.client.post(
            "/api/join", content=content, headers={"Content-Type": "application/json"}
        )
        assert response.status_code == 422
        assert error_code(response) == "INVALID_REQUEST"
    response = trio.client.post("/api/join", content=b"x" * 20_000)
    assert response.status_code == 413
    assert error_code(response) == "PAYLOAD_TOO_LARGE"


def test_the_token_is_stored_only_as_its_hash(trio):
    user = trio.user("Ali")
    db = sqlite3.connect(trio.client.app.state.settings.db_path)
    rows = db.execute("SELECT token_hash FROM tokens").fetchall()
    dump = "\n".join(db.iterdump())
    db.close()
    assert rows == [(hashlib.sha256(user["token"].encode()).hexdigest(),)]
    assert user["token"] not in dump
    assert INVITE not in dump


def test_the_database_is_in_wal_mode_with_seed_channels(trio):
    db = sqlite3.connect(trio.client.app.state.settings.db_path)
    assert db.execute("PRAGMA journal_mode").fetchone() == ("wal",)
    assert db.execute("SELECT name, kind FROM channels ORDER BY id").fetchall() == [
        ("genel", "text"),
        ("Sohbet", "voice"),
    ]
    db.close()


# -- auth ---------------------------------------------------------------------


def test_me(trio):
    user = trio.user("Ali")
    response = trio.client.get("/api/me", headers=user["auth"])
    assert response.status_code == 200
    assert response.json() == {"user": {"id": user["id"], "name": "Ali"}}


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", "/api/me"),
        ("GET", "/api/channels"),
        ("POST", "/api/channels"),
        ("GET", "/api/channels/1/messages"),
        ("GET", "/api/ice"),
    ],
)
def test_everything_but_join_and_health_needs_a_token(trio, method, path):
    trio.user("Ali")
    for headers in (
        {},
        {"Authorization": "Bearer nope"},
        {"Authorization": "Basic abc"},
        {"Authorization": "Bearer"},
    ):
        response = trio.client.request(method, path, headers=headers)
        assert response.status_code == 401
        assert error_code(response) == "UNAUTHORIZED"


def test_unknown_api_paths_are_json_404(trio):
    for method in ("GET", "POST", "DELETE"):
        response = trio.client.request(method, "/api/nope/at/all")
        assert response.status_code == 404
        assert error_code(response) == "NOT_FOUND"
    assert error_code(trio.client.get("/elsewhere")) == "NOT_FOUND"
    # A known path with a method it does not have is "no such endpoint" too.
    response = trio.client.delete("/api/me")
    assert response.status_code == 404
    assert error_code(response) == "NOT_FOUND"


# -- channels -----------------------------------------------------------------


def test_channels_are_seeded_and_listed(trio):
    user = trio.user("Ali")
    response = trio.client.get("/api/channels", headers=user["auth"])
    assert response.status_code == 200
    assert response.json() == {
        "channels": [
            {"id": 1, "name": "genel", "kind": "text"},
            {"id": 2, "name": "Sohbet", "kind": "voice"},
        ]
    }


def test_create_channel(trio):
    user = trio.user("Ali")
    response = trio.client.post(
        "/api/channels", json={"name": " oyun ", "kind": "voice"}, headers=user["auth"]
    )
    assert response.status_code == 201
    assert response.json() == {"channel": {"id": 3, "name": "oyun", "kind": "voice"}}
    listed = trio.client.get("/api/channels", headers=user["auth"]).json()["channels"]
    assert listed[-1] == {"id": 3, "name": "oyun", "kind": "voice"}


@pytest.mark.parametrize(
    "body",
    [
        {"name": "", "kind": "text"},
        {"name": "x" * 33, "kind": "text"},
        {"name": "ok", "kind": "video"},
        {"name": "ok"},
        {"kind": "text"},
        {"name": 3, "kind": "text"},
    ],
)
def test_create_channel_invalid(trio, body):
    user = trio.user("Ali")
    response = trio.client.post("/api/channels", json=body, headers=user["auth"])
    assert response.status_code == 422
    assert error_code(response) == "INVALID_CHANNEL"


def test_channels_survive_a_restart_and_are_not_seeded_twice(make_trio, tmp_path):
    path = str(tmp_path / "persist.db")
    first = make_trio(db_path=path)
    user = first.user("Ali")
    first.client.post("/api/channels", json={"name": "x", "kind": "text"}, headers=user["auth"])
    second = make_trio(db_path=path)
    names = [
        c["name"]
        for c in second.client.get("/api/channels", headers=user["auth"]).json()["channels"]
    ]
    assert names == ["genel", "Sohbet", "x"]
    assert second.client.get("/api/me", headers=user["auth"]).status_code == 200


# -- messages -----------------------------------------------------------------


def send_messages(trio, user, count: int, channel_id: int = 1) -> None:
    with trio.ws(user) as sock:
        for i in range(1, count + 1):
            sock.send_json(
                {
                    "type": "message.send",
                    "channel_id": channel_id,
                    "content": f"m{i}",
                    "nonce": str(i),
                }
            )
            assert sock.receive_json()["type"] == "message.new"


def test_message_pagination(trio):
    user = trio.user("Ali")
    send_messages(trio, user, 7)

    def page(query: str = ""):
        response = trio.client.get(f"/api/channels/1/messages{query}", headers=user["auth"])
        assert response.status_code == 200
        body = response.json()
        assert set(body) == {"messages", "has_more"}
        return [m["id"] for m in body["messages"]], body["has_more"]

    assert page() == ([1, 2, 3, 4, 5, 6, 7], False)
    assert page("?limit=3") == ([5, 6, 7], True)
    assert page("?limit=3&before=5") == ([2, 3, 4], True)
    assert page("?limit=3&before=2") == ([1], False)
    assert page("?limit=7") == ([1, 2, 3, 4, 5, 6, 7], False)
    assert page("?limit=6") == ([2, 3, 4, 5, 6, 7], True)
    assert page("?before=1") == ([], False)


def test_message_shape(trio):
    user = trio.user("Ali")
    send_messages(trio, user, 1)
    body = trio.client.get("/api/channels/1/messages", headers=user["auth"]).json()
    (message,) = body["messages"]
    assert set(message) == {"id", "channel_id", "author", "content", "created_at", "attachments"}
    assert message["attachments"] == []
    assert message["author"] == {"id": user["id"], "name": "Ali"}
    assert message["channel_id"] == 1
    assert message["content"] == "m1"
    assert message["created_at"].endswith("Z") and "T" in message["created_at"]


def test_messages_default_limit_is_50_and_pages_are_per_channel(trio):
    user = trio.user("Ali")
    other = trio.client.post(
        "/api/channels", json={"name": "b", "kind": "text"}, headers=user["auth"]
    ).json()["channel"]["id"]
    send_messages(trio, user, 55)
    send_messages(trio, user, 2, channel_id=other)
    body = trio.client.get("/api/channels/1/messages", headers=user["auth"]).json()
    assert [m["id"] for m in body["messages"]] == list(range(6, 56))
    assert body["has_more"] is True
    body = trio.client.get(f"/api/channels/{other}/messages", headers=user["auth"]).json()
    assert [m["id"] for m in body["messages"]] == [56, 57]
    assert body["has_more"] is False


def test_messages_of_a_missing_or_voice_channel_are_404(trio):
    user = trio.user("Ali")
    for channel_id in (2, 999):
        response = trio.client.get(f"/api/channels/{channel_id}/messages", headers=user["auth"])
        assert response.status_code == 404
        assert error_code(response) == "NOT_FOUND"


@pytest.mark.parametrize("query", ["limit=0", "limit=101", "limit=x", "before=abc", "before=0"])
def test_message_query_validation_uses_the_error_envelope(trio, query):
    user = trio.user("Ali")
    response = trio.client.get(f"/api/channels/1/messages?{query}", headers=user["auth"])
    assert response.status_code == 422
    assert error_code(response) == "INVALID_REQUEST"
    assert "detail" not in response.json()


# -- ice ----------------------------------------------------------------------


def test_ice_without_turn(trio):
    user = trio.user("Ali")
    response = trio.client.get("/api/ice", headers=user["auth"])
    assert response.status_code == 200
    assert response.json() == {"iceServers": [{"urls": ["stun:stun.l.google.com:19302"]}]}


def test_ice_needs_both_turn_settings(make_trio):
    trio = make_trio(turn_host="chat.example.com")
    user = trio.user("Ali")
    assert len(trio.client.get("/api/ice", headers=user["auth"]).json()["iceServers"]) == 1


def test_ice_with_turn(make_trio):
    secret = "coturn-shared-secret"
    trio = make_trio(
        turn_host="chat.example.com", turn_secret=secret, stun_urls=("stun:a:1", "stun:b:2")
    )
    trio.user("first")
    user = trio.user("Ali")
    response = trio.client.get("/api/ice", headers=user["auth"])
    assert response.status_code == 200
    stun, turn = response.json()["iceServers"]
    assert stun == {"urls": ["stun:a:1", "stun:b:2"]}
    assert turn["urls"] == [
        "turn:chat.example.com:3478?transport=udp",
        "turn:chat.example.com:3478?transport=tcp",
        "turns:chat.example.com:5349?transport=tcp",
    ]
    expiry = int(trio.clock.value) + 12 * 3600
    assert turn["username"] == f"{expiry}:{user['id']}"
    expected = base64.b64encode(
        hmac.new(secret.encode(), turn["username"].encode(), hashlib.sha1).digest()
    ).decode()
    assert turn["credential"] == expected
    assert secret not in response.text


# -- static files -------------------------------------------------------------


@pytest.fixture
def static_trio(make_trio, tmp_path):
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html><title>Trio</title>")
    (dist / "assets" / "app-abc123.js").write_text("console.log(1)")
    (tmp_path / "secret.txt").write_text("outside")
    return make_trio(static_dir=str(dist))


def test_static_files_and_spa_fallback(static_trio):
    client = static_trio.client
    for path in ("/", "/index.html", "/some/client/route", "/channels/3"):
        response = client.get(path)
        assert response.status_code == 200
        assert "<title>Trio</title>" in response.text
        assert response.headers["content-type"].startswith("text/html")
    response = client.get("/assets/app-abc123.js")
    assert response.status_code == 200
    assert response.text == "console.log(1)"
    assert "javascript" in response.headers["content-type"]
    assert "immutable" in response.headers["cache-control"]
    assert client.get("/assets/missing.js").status_code == 404
    assert client.get("/favicon.ico").status_code == 404


def test_static_webp_is_served_as_image_webp(make_trio, tmp_path, monkeypatch):
    # The production image (python:3.12-slim) knows no type for .webp: start
    # from a table without it, as that image does.
    db = mimetypes.MimeTypes(filenames=())
    db.types_map[True].pop(".webp", None)
    monkeypatch.setattr(mimetypes, "_db", db)
    assert mimetypes.guess_type("join.webp")[0] is None
    dist = tmp_path / "dist"
    (dist / "art").mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html><title>Trio</title>")
    (dist / "art" / "join.webp").write_bytes(b"RIFF\x00\x00\x00\x00WEBPVP8 ")
    client = make_trio(static_dir=str(dist)).client
    response = client.get("/art/join.webp")
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/webp"
    assert response.headers["x-content-type-options"] == "nosniff"


def test_static_serving_does_not_shadow_the_api_or_the_websocket(static_trio):
    client = static_trio.client
    assert client.get("/api/health").json() == {"ok": True}
    for path in ("/api/nope", "/api", "/api/", "/ws", "/ws/x"):
        response = client.get(path)
        assert response.status_code == 404, path
        assert error_code(response) == "NOT_FOUND"
    response = client.post("/api/nope")
    assert response.status_code == 404
    assert error_code(response) == "NOT_FOUND"
    user = static_trio.user("Ali")
    assert client.get("/api/me", headers=user["auth"]).status_code == 200
    with static_trio.ws(user) as sock:
        assert sock.ready["user"]["name"] == "Ali"


def test_static_serving_cannot_leave_its_directory(static_trio):
    for path in (
        "/../secret.txt",
        "/%2e%2e/secret.txt",
        "/assets/../../secret.txt",
        "/..%2fsecret.txt",
    ):
        response = static_trio.client.get(path)
        assert "outside" not in response.text, path
