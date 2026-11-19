"""CONTRACT-V6-OPS: the owner, storage and attachment delete, client errors."""

from __future__ import annotations

import io
import logging
import sqlite3
import time
from pathlib import Path

import pytest
from starlette.websockets import WebSocketDisconnect

from trio_server import admin
from trio_server.client_errors import MAX_ROWS, REPORT_LIMIT, error_hash, scrub
from trio_server.logsafe import TokenRedactingFilter
from trio_server.owner import owner_id_of

from .conftest import INVITE, quiet
from .test_ws import expect

TEXT = 1


def code(response) -> str:
    return response.json()["error"]["code"]


def upload(trio, user, data: bytes = b"hello", name: str = "a.txt"):
    response = trio.client.post("/api/uploads", files={"file": (name, data)}, headers=user["auth"])
    assert response.status_code == 201, response.text
    return response.json()["attachment"]


def send(sock, content: str, attachment_ids=()) -> dict:
    sock.send_json(
        {
            "type": "message.send",
            "channel_id": TEXT,
            "content": content,
            "nonce": f"n-{time.monotonic_ns()}",
            "attachment_ids": list(attachment_ids),
        }
    )
    return expect(sock, "message.new")["message"]


def owner_post(trio, user, path: str, body: dict | None = None, address="203.0.113.9"):
    return trio.client.post(
        path,
        json={} if body is None else body,
        headers={**user["auth"], "X-Forwarded-For": address},
    )


# -- the owner rule -------------------------------------------------------------------


def test_owner_rule_is_lowest_active_id_or_the_configured_name():
    users = [(3, "Cem"), (1, "Ali"), (2, "IŞIL")]
    assert owner_id_of(users, None) == 1
    assert owner_id_of(users, "ışıl") == 2  # matched like a join: Turkish I/ı, any case
    assert owner_id_of(users, "  cem ") == 3
    # A name nobody has: nobody is the owner (never a silent fallback).
    assert owner_id_of(users, "Deniz") is None
    assert owner_id_of([], None) is None


def test_only_the_owner_carries_is_owner(trio):
    ali, berk = trio.user("Ali"), trio.user("Berk")
    assert trio.client.get("/api/me", headers=ali["auth"]).json()["user"]["is_owner"] is True
    assert "is_owner" not in trio.client.get("/api/me", headers=berk["auth"]).json()["user"]
    with trio.ws(ali) as a, trio.ws(berk) as b:
        assert a.ready["user"]["is_owner"] is True
        assert "is_owner" not in b.ready["user"]
        # The member list never says who the owner is.
        assert all("is_owner" not in u for u in a.ready["users"])


def test_trio_owner_names_the_owner(make_trio):
    trio = make_trio(owner="berk")
    ali, berk = trio.user("Ali"), trio.user("Berk")
    assert "is_owner" not in trio.client.get("/api/me", headers=ali["auth"]).json()["user"]
    assert trio.client.get("/api/me", headers=berk["auth"]).json()["user"]["is_owner"] is True
    assert trio.client.get("/api/owner/overview", headers=ali["auth"]).status_code == 403
    assert trio.client.get("/api/owner/overview", headers=berk["auth"]).status_code == 200


def test_removing_the_owner_with_the_tool_passes_the_role_on(trio):
    _ali, berk = trio.user("Ali"), trio.user("Berk")
    trio.clock.value = time.time()
    assert (
        admin.main(
            ["--db", trio.client.app.state.settings.db_path, "remove-user", "Ali"],
            out=io.StringIO(),
        )
        == 0
    )
    assert trio.client.get("/api/owner/overview", headers=berk["auth"]).status_code == 200


# -- authorisation matrix ---------------------------------------------------------------

OWNER_ROUTES = [
    ("GET", "/api/owner/overview"),
    ("GET", "/api/owner/errors"),
    ("DELETE", "/api/owner/errors"),
    ("POST", "/api/owner/backup-tickets"),
    ("GET", "/api/owner/backup"),
    ("POST", "/api/owner/users/2/revoke-tokens"),
    ("POST", "/api/owner/users/2/remove"),
    ("POST", "/api/owner/users/2/link-code"),
]


@pytest.mark.parametrize(("method", "path"), OWNER_ROUTES)
def test_owner_routes_refuse_everybody_else(trio, method, path):
    ali, berk, cem = trio.user("Ali"), trio.user("Berk"), trio.user("Cem")
    trio.clock.value = time.time()
    admin.main(
        ["--db", trio.client.app.state.settings.db_path, "remove-user", "Cem"], out=io.StringIO()
    )
    body = {"confirm_code": INVITE} if method == "POST" else None
    for headers, status, error in (
        ({}, 401, "UNAUTHORIZED"),
        ({"Authorization": "Bearer nonsense"}, 401, "UNAUTHORIZED"),
        (cem["auth"], 401, "UNAUTHORIZED"),  # removed: the token is gone
        (berk["auth"], 403, "FORBIDDEN"),
    ):
        response = trio.client.request(method, path, json=body, headers=headers)
        assert response.status_code == status, (headers, response.text)
        assert code(response) == error
    # Nothing happened to Berk.
    assert trio.client.get("/api/me", headers=berk["auth"]).status_code == 200
    assert trio.client.get("/api/owner/overview", headers=ali["auth"]).status_code == 200


# -- overview -----------------------------------------------------------------------------


def test_overview_reports_users_storage_server_turn(make_trio):
    trio = make_trio(cf_turn_key_id="KEYID-secret", cf_turn_api_token="TOKEN-secret")
    ali, berk = trio.user("Ali"), trio.user("Berk")
    upload(trio, berk, b"x" * 1000, "b.bin")
    with trio.ws(berk):
        body = trio.client.get("/api/owner/overview", headers=ali["auth"]).json()
    users = {u["name"]: u for u in body["users"]}
    assert users["Ali"]["is_owner"] is True and users["Berk"]["is_owner"] is False
    assert users["Berk"]["online"] is True and users["Berk"]["connections"] == 1
    assert users["Berk"]["stored_bytes"] == 1000 and users["Berk"]["file_count"] == 1
    assert users["Ali"]["online"] is False and users["Ali"]["last_seen_at"] is None
    assert users["Berk"]["removed"] is False
    storage = body["storage"]
    assert storage["uploads_bytes"] >= 1000 and storage["db_bytes"] > 0
    assert storage["disk_total_bytes"] >= storage["disk_free_bytes"] > 0
    assert storage["user_quota_bytes"] == 1024 * 1024 * 1024
    assert body["server"]["version"] and body["server"]["python"].count(".") == 2
    assert body["turn"] == {
        "provider": "cloudflare",
        "stun": ["stun:stun.l.google.com:19302"],
        "last_call": None,
    }
    assert body["limits"]["max_users"] == 5
    assert body["backup"] == {"last": None, "in_progress": None}
    assert body["counts"] == {"messages": 0, "channels": 2, "attachments": 1}
    assert "secret" not in str(body)
    # Berk's socket closed: last seen is now known.
    after = trio.client.get("/api/owner/overview", headers=ali["auth"]).json()
    assert next(u for u in after["users"] if u["name"] == "Berk")["last_seen_at"] is not None


def test_overview_reports_the_last_cloudflare_call(make_trio):
    import httpx

    def failing(request):
        return httpx.Response(401, json={})

    trio = make_trio(
        cf_turn_key_id="k", cf_turn_api_token="t", http_transport=httpx.MockTransport(failing)
    )
    ali = trio.user("Ali")
    trio.client.get("/api/ice", headers=ali["auth"])
    trio.clock.value += 30
    turn = trio.client.get("/api/owner/overview", headers=ali["auth"]).json()["turn"]
    assert turn["last_call"]["ok"] is False
    assert turn["last_call"]["detail"] == "HTTPStatusError status=401"
    assert turn["last_call"]["age_seconds"] == 30


def test_overview_turn_coturn_and_none(make_trio):
    trio = make_trio(turn_host="turn.example", turn_secret="s3cret")
    ali = trio.user("Ali")
    turn = trio.client.get("/api/owner/overview", headers=ali["auth"]).json()["turn"]
    assert turn["provider"] == "coturn" and "s3cret" not in str(turn)
    other = make_trio()
    berk = other.user("Berk")
    assert (
        other.client.get("/api/owner/overview", headers=berk["auth"]).json()["turn"]["provider"]
        == "none"
    )


# -- user actions and the confirm code --------------------------------------------------


def test_revoke_tokens_needs_the_code_and_closes_sockets_at_once(trio):
    ali, berk = trio.user("Ali"), trio.user("Berk")
    path = f"/api/owner/users/{berk['id']}/revoke-tokens"
    with trio.ws(ali) as a, trio.ws(berk) as b:
        expect(a, "presence")
        for body in ({}, {"confirm_code": "wrong"}, {"confirm_code": 5}):
            response = owner_post(trio, ali, path, body)
            assert response.status_code == 403
            assert code(response) == "INVALID_CONFIRM_CODE"
        quiet(b)  # still connected
        response = owner_post(trio, ali, path, {"confirm_code": INVITE})
        assert response.status_code == 200
        assert response.json() == {"user": {"id": berk["id"], "name": "Berk"}, "sessions_ended": 1}
        with pytest.raises(WebSocketDisconnect) as closed:
            while True:
                b.receive_json()
        assert closed.value.code == 4401
    assert trio.client.get("/api/me", headers=berk["auth"]).status_code == 401
    # The account stays: a link code still brings Berk back.
    response = owner_post(
        trio, ali, f"/api/owner/users/{berk['id']}/link-code", {"confirm_code": INVITE}
    )
    assert response.status_code == 201
    linked = trio.client.post("/api/join", json={"link_code": response.json()["code"]})
    assert linked.status_code == 200 and linked.json()["user"]["id"] == berk["id"]


def test_wrong_confirm_codes_spend_the_join_failure_budget(trio):
    ali, berk = trio.user("Ali"), trio.user("Berk")
    path = f"/api/owner/users/{berk['id']}/revoke-tokens"
    guard = trio.client.app.state.join_guard
    owner_post(trio, ali, path, {"confirm_code": "nope"}, address="203.0.113.50")
    assert guard.address_failures.count("203.0.113.50") == 1
    # Ten attempts per address per window, right or wrong, like a join.
    for _ in range(9):
        owner_post(trio, ali, path, {"confirm_code": "nope"}, address="203.0.113.50")
    refused = owner_post(trio, ali, path, {"confirm_code": INVITE}, address="203.0.113.50")
    assert refused.status_code == 429
    assert code(refused) == "RATE_LIMITED"
    assert int(refused.headers["Retry-After"]) > 0
    assert trio.client.get("/api/me", headers=berk["auth"]).status_code == 200


def test_remove_user(trio):
    ali, berk, cem = trio.user("Ali"), trio.user("Berk"), trio.user("Cem")
    with trio.ws(cem) as c:
        refused = owner_post(
            trio, ali, f"/api/owner/users/{ali['id']}/remove", {"confirm_code": INVITE}
        )
        assert refused.status_code == 409 and code(refused) == "CANNOT_REMOVE_OWNER"
        bad = owner_post(trio, ali, f"/api/owner/users/{berk['id']}/remove", {})
        assert bad.status_code == 403
        response = owner_post(
            trio, ali, f"/api/owner/users/{berk['id']}/remove", {"confirm_code": INVITE}
        )
        assert response.status_code == 200
        assert expect(c, "user.removed") == {"type": "user.removed", "user_id": berk["id"]}
    assert trio.client.get("/api/me", headers=berk["auth"]).status_code == 401
    users = trio.client.get("/api/owner/overview", headers=ali["auth"]).json()["users"]
    assert next(u for u in users if u["id"] == berk["id"])["removed"] is True
    # Twice: no such active user.
    again = owner_post(trio, ali, f"/api/owner/users/{berk['id']}/remove", {"confirm_code": INVITE})
    assert again.status_code == 404


def test_link_code_limits_and_unknown_user(trio):
    ali, berk = trio.user("Ali"), trio.user("Berk")
    path = f"/api/owner/users/{berk['id']}/link-code"
    trio.client.app.state.join_guard.attempts._limit = 100  # this test is about the code limit
    for _ in range(5):
        assert owner_post(trio, ali, path, {"confirm_code": INVITE}).status_code == 201
    over = owner_post(trio, ali, path, {"confirm_code": INVITE})
    assert over.status_code == 429 and code(over) == "TOO_MANY_LINK_CODES"
    missing = owner_post(trio, ali, "/api/owner/users/999/link-code", {"confirm_code": INVITE})
    assert missing.status_code == 404
    assert owner_post(trio, ali, "/api/owner/users/0/link-code", {}).status_code == 422


# -- storage and attachment delete ------------------------------------------------------


def test_my_storage_lists_largest_first_with_messages(trio):
    ali, berk = trio.user("Ali"), trio.user("Berk")
    small = upload(trio, ali, b"s" * 10, "small.txt")
    big = upload(trio, ali, b"b" * 300, "big.txt")
    loose = upload(trio, ali, b"l" * 100, "loose.txt")
    upload(trio, berk, b"x" * 999, "berk.txt")
    with trio.ws(ali) as a:
        message = send(a, "dosyalar " * 20, [big["id"], small["id"]])
    body = trio.client.get("/api/me/storage", headers=ali["auth"]).json()
    assert body["used_bytes"] == 410 and body["file_count"] == 3
    assert body["quota_bytes"] == 1024 * 1024 * 1024
    assert [a["id"] for a in body["attachments"]] == [big["id"], loose["id"], small["id"]]
    first = body["attachments"][0]
    assert first["message"] == {
        "id": message["id"],
        "channel_id": TEXT,
        "excerpt": message["content"][:80],
    }
    assert first["url"] == big["url"] and first["content_type"] == "text/plain"
    assert body["attachments"][1]["message"] is None
    page = trio.client.get("/api/me/storage?limit=2&offset=1", headers=ali["auth"]).json()
    assert [a["id"] for a in page["attachments"]] == [loose["id"], small["id"]]
    assert page["has_more"] is False
    assert trio.client.get("/api/me/storage?limit=1", headers=ali["auth"]).json()["has_more"]
    assert trio.client.get("/api/me/storage").status_code == 401


def test_deleting_an_attachment_tombstones_it_everywhere(trio):
    ali, berk = trio.user("Ali"), trio.user("Berk")
    keep = upload(trio, ali, b"k" * 50, "keep.txt")
    gone = upload(trio, ali, b"g" * 500, "gone.txt")
    upload_dir = Path(trio.client.app.state.settings.upload_dir)
    with trio.ws(ali) as a, trio.ws(berk) as b:
        expect(a, "presence")
        message = send(a, "iki dosya", [keep["id"], gone["id"]])
        expect(b, "message.new")
        # Somebody else's file: refused, nothing changes.
        refused = trio.client.delete(f"/api/attachments/{gone['id']}", headers=berk["auth"])
        assert refused.status_code == 403 and code(refused) == "FORBIDDEN"
        response = trio.client.delete(f"/api/attachments/{gone['id']}", headers=ali["auth"])
        assert response.status_code == 200
        body = response.json()
        assert body["storage"]["used_bytes"] == 50 and body["storage"]["file_count"] == 1
        tombstone = {"id": gone["id"], "filename": "gone.txt", "deleted": True}
        assert body["message"]["attachments"] == [keep, tombstone]
        assert body["message"]["rev"] == message["rev"] + 1
        for sock in (a, b):
            frame = expect(sock, "message.updated")
            assert frame["message"] == body["message"]
    assert not (upload_dir / gone["id"]).exists()
    assert trio.client.get(gone["url"]).status_code == 404
    listed = trio.client.get(f"/api/channels/{TEXT}/messages", headers=berk["auth"]).json()
    assert listed["messages"][0]["attachments"] == [keep, tombstone]
    again = trio.client.delete(f"/api/attachments/{gone['id']}", headers=ali["auth"])
    assert again.status_code == 404
    assert trio.client.delete("/api/attachments/not-an-id", headers=ali["auth"]).status_code == 404
    # The bytes are back: the quota counts only what is stored.
    assert trio.client.get("/api/me/storage", headers=ali["auth"]).json()["used_bytes"] == 50


def test_a_message_left_with_only_tombstones_stays(trio):
    ali = trio.user("Ali")
    only = upload(trio, ali, b"o" * 5, "only.txt")
    with trio.ws(ali) as a:
        message = send(a, "", [only["id"]])
        trio.client.delete(f"/api/attachments/{only['id']}", headers=ali["auth"])
        expect(a, "message.updated")
    listed = trio.client.get(f"/api/channels/{TEXT}/messages", headers=ali["auth"]).json()
    assert listed["messages"][0]["id"] == message["id"]
    assert listed["messages"][0]["attachments"] == [
        {"id": only["id"], "filename": "only.txt", "deleted": True}
    ]
    # An edit to empty content is refused: a tombstone is not a file.
    edit = trio.client.patch(
        f"/api/messages/{message['id']}", json={"content": ""}, headers=ali["auth"]
    )
    assert edit.status_code == 422 and code(edit) == "INVALID_MESSAGE"
    # A reply quoting it has no file to name.
    with trio.ws(ali) as a:
        a.send_json(
            {"type": "message.send", "channel_id": TEXT, "content": "re", "reply_to": message["id"]}
        )
        reply = expect(a, "message.new")["message"]
    assert reply["reply_to"]["excerpt"] == ""


def test_deleting_an_unattached_upload_removes_it(trio):
    ali = trio.user("Ali")
    loose = upload(trio, ali, b"l" * 70, "l.txt")
    response = trio.client.delete(f"/api/attachments/{loose['id']}", headers=ali["auth"])
    assert response.status_code == 200 and response.json()["message"] is None
    assert response.json()["storage"]["used_bytes"] == 0
    db = sqlite3.connect(trio.client.app.state.settings.db_path)
    assert db.execute("SELECT count(*) FROM attachments").fetchone()[0] == 0


def test_attachments_gain_deleted_at_on_an_old_database(make_trio, tmp_path):
    """A database from before v6 (no attachments.deleted_at) upgrades on boot."""
    db_path = tmp_path / "old.db"
    conn = sqlite3.connect(db_path)
    conn.executescript(
        "CREATE TABLE attachments (id TEXT PRIMARY KEY, uploader_id INTEGER NOT NULL, "
        "message_id INTEGER, position INTEGER, filename TEXT NOT NULL, "
        "content_type TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL, "
        "created_ts REAL NOT NULL);"
    )
    conn.close()
    trio = make_trio(db_path=str(db_path))
    ali = trio.user("Ali")
    attachment = upload(trio, ali)
    assert (
        trio.client.delete(f"/api/attachments/{attachment['id']}", headers=ali["auth"]).status_code
        == 200
    )
    columns = {r[1] for r in sqlite3.connect(db_path).execute("PRAGMA table_info(attachments)")}
    assert "deleted_at" in columns


def test_quota_frees_after_delete(make_trio):
    trio = make_trio(user_quota_mb=1)
    ali = trio.user("Ali")
    first = upload(trio, ali, b"a" * (700 * 1024), "a.bin")
    response = trio.client.post(
        "/api/uploads", files={"file": ("b.bin", b"b" * (700 * 1024))}, headers=ali["auth"]
    )
    assert code(response) == "QUOTA_EXCEEDED"
    trio.client.delete(f"/api/attachments/{first['id']}", headers=ali["auth"])
    upload(trio, ali, b"b" * (700 * 1024), "b.bin")


# -- client errors ------------------------------------------------------------------------


def report(trio, user, **fields):
    body = {"message": "TypeError: x is undefined", "stack": "at f (/assets/a.js:1:2)", **fields}
    return trio.client.post("/api/client-errors", json=body, headers=user["auth"])


def test_client_errors_are_deduplicated_and_shown_to_the_owner(trio):
    ali, berk = trio.user("Ali"), trio.user("Berk")
    assert report(trio, berk, version="0.4.0", build="abc").status_code == 204
    assert report(trio, berk, version="0.4.1", build="def").status_code == 204
    assert report(trio, ali, message="Other", stack="").status_code == 204
    assert trio.client.get("/api/owner/errors", headers=berk["auth"]).status_code == 403
    body = trio.client.get("/api/owner/errors", headers=ali["auth"]).json()
    assert body["distinct"] == 2 and body["total"] == 3
    first = next(e for e in body["errors"] if e["message"].startswith("TypeError"))
    assert first["count"] == 2
    assert first["versions"] == ["0.4.0 (abc)", "0.4.1 (def)"]
    assert first["user"] == {"id": berk["id"], "name": "Berk"}
    assert body["errors"][0]["message"] == "Other"  # the most recent first
    assert trio.client.delete("/api/owner/errors", headers=ali["auth"]).status_code == 204
    assert trio.client.get("/api/owner/errors", headers=ali["auth"]).json()["errors"] == []


def test_client_errors_are_limited_and_capped(trio):
    ali, berk = trio.user("Ali"), trio.user("Berk")
    for i in range(REPORT_LIMIT):
        assert report(trio, berk, message=f"e{i}").status_code == 204
    limited = report(trio, berk, message="one more")
    assert limited.status_code == 429 and code(limited) == "RATE_LIMITED"
    trio.clock.value += 3601
    assert report(trio, berk, message="later").status_code == 204
    too_big = trio.client.post(
        "/api/client-errors", json={"message": "x" * 5000}, headers=berk["auth"]
    )
    assert too_big.status_code == 413
    assert (
        trio.client.post(
            "/api/client-errors", json={"message": 5}, headers=berk["auth"]
        ).status_code
        == 422
    )
    assert trio.client.post("/api/client-errors", json={"message": "x"}).status_code == 401
    trio.client.app.state.client_error_limit._limit = 10_000
    for i in range(MAX_ROWS + 20):
        trio.clock.value += 1
        report(trio, ali, message=f"cap {i}")
    db = sqlite3.connect(trio.client.app.state.settings.db_path)
    assert db.execute("SELECT count(*) FROM client_errors").fetchone()[0] == MAX_ROWS
    listed = trio.client.get("/api/owner/errors", headers=ali["auth"]).json()["errors"]
    assert len(listed) == 50 and listed[0]["message"] == f"cap {MAX_ROWS + 19}"


def test_client_error_text_is_scrubbed():
    text = "at https://trio.example/app?token=abc#frag and token=xyz blob:https://x/1#y"
    assert scrub(text, 500) == "at https://trio.example/app and token=[redacted] blob:https://x/1"
    assert scrub("a\x00b\nc", 10) == "ab\nc"
    assert len(scrub("x" * 3000, 2048)) == 2048
    # Same message and top frame: same row, whatever comes below.
    assert error_hash("E", "Error: E\n    at f (a.js:1)\n    at g") == error_hash(
        "E", "Error: E\n    at f (a.js:1)\n    at h"
    )
    assert error_hash("E", "at f (a.js:1)") != error_hash("E", "at f (a.js:2)")


def test_ticket_values_are_redacted_in_logs():
    record = logging.LogRecord(
        "uvicorn.access",
        logging.INFO,
        "",
        0,
        '%s "%s"',
        ("1.2.3.4", "GET /api/owner/backup?ticket=SECRET123 HTTP/1.1"),
        None,
    )
    TokenRedactingFilter().filter(record)
    assert "SECRET123" not in record.getMessage()
    assert "ticket=[redacted]" in record.getMessage()
