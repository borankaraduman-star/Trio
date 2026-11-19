"""CONTRACT-V3 §2 and §3: logout, device linking, the admin tool, removed users."""

from __future__ import annotations

import io
import sqlite3
import time

import pytest
from starlette.websockets import WebSocketDisconnect

from trio_server import admin, linkcodes

from .conftest import quiet


def code(response) -> str:
    return response.json()["error"]["code"]


def run(trio, *argv: str) -> tuple[int, str]:
    # The tool reads the real clock; the app the test clock. Line them up.
    trio.clock.value = time.time()
    out = io.StringIO()
    status = admin.main(["--db", trio.client.app.state.settings.db_path, *argv], out=out)
    return status, out.getvalue()


def link(trio, raw: str, address: str = "198.51.100.200"):
    return trio.client.post(
        "/api/join", json={"link_code": raw}, headers={"X-Forwarded-For": address}
    )


def recheck(trio) -> None:
    trio.client.portal.call(trio.client.app.state.recheck_tokens)


# -- DELETE /api/session --------------------------------------------------------------


def test_logout_ends_this_token_only(trio):
    ali = trio.user("Ali")
    second = trio.client.post("/api/link-codes", headers=ali["auth"]).json()["code"]
    phone = link(trio, second).json()
    phone_auth = {"Authorization": f"Bearer {phone['token']}"}

    response = trio.client.delete("/api/session", headers=ali["auth"])
    assert response.status_code == 204
    assert response.content == b""
    assert trio.client.get("/api/me", headers=ali["auth"]).status_code == 401
    # The other device is still signed in, as the same user.
    assert trio.client.get("/api/me", headers=phone_auth).json()["user"]["id"] == ali["id"]
    # Twice is a 401: the token is gone.
    assert trio.client.delete("/api/session", headers=ali["auth"]).status_code == 401


def test_logout_needs_a_token(trio):
    for headers in ({}, {"Authorization": "Bearer nope"}):
        response = trio.client.delete("/api/session", headers=headers)
        assert response.status_code == 401
        assert code(response) == "UNAUTHORIZED"


def test_logout_closes_that_tokens_sockets_with_4401(trio):
    ali, berk = trio.user("Ali"), trio.user("Berk")
    with trio.ws(berk) as b, trio.ws(ali) as a1, trio.ws(ali) as a2:
        b.receive_json()  # Ali's presence
        assert trio.client.delete("/api/session", headers=ali["auth"]).status_code == 204
        for sock in (a1, a2):
            with pytest.raises(WebSocketDisconnect) as closed:
                while True:
                    sock.receive_json()
            assert closed.value.code == 4401
        assert b.receive_json() == {"type": "presence", "user_id": ali["id"], "online": False}
        quiet(b)
    with trio.client.websocket_connect(f"/ws?token={ali['token']}") as sock:
        with pytest.raises(WebSocketDisconnect) as closed:
            sock.receive_json()
        assert closed.value.code == 4401


# -- link codes --------------------------------------------------------------------


def test_a_link_code_signs_a_second_device_in_as_the_same_user(trio):
    ali = trio.user("Ali")
    response = trio.client.post("/api/link-codes", headers=ali["auth"])
    assert response.status_code == 201
    body = response.json()
    assert set(body) == {"code", "expires_at"}
    assert len(body["code"]) == linkcodes.CODE_LENGTH
    assert set(body["code"]) <= set(linkcodes.ALPHABET)
    assert body["expires_at"] == "2027-01-15T08:10:00.000Z"  # the test clock + 10 minutes
    # Typed sloppily on the phone.
    typed = body["code"][:5].lower() + "-" + body["code"][5:]
    joined = link(trio, typed)
    assert joined.status_code == 200
    assert joined.json()["user"] == {"id": ali["id"], "name": "Ali", "avatar_url": None}
    assert joined.json()["token"] != ali["token"]
    # No new account, no slot used, no user.joined.
    assert len(trio.client.app.state.hub.users) == 1
    phone = {"Authorization": f"Bearer {joined.json()['token']}"}
    assert trio.client.get("/api/me", headers=phone).json()["user"]["id"] == ali["id"]


def test_a_link_code_works_once(trio):
    ali = trio.user("Ali")
    raw = trio.client.post("/api/link-codes", headers=ali["auth"]).json()["code"]
    assert link(trio, raw).status_code == 200
    response = link(trio, raw)
    assert response.status_code == 403
    assert code(response) == "INVALID_LINK_CODE"


def test_a_link_code_expires_after_ten_minutes(trio):
    ali = trio.user("Ali")
    first = trio.client.post("/api/link-codes", headers=ali["auth"]).json()["code"]
    second = trio.client.post("/api/link-codes", headers=ali["auth"]).json()["code"]
    trio.clock.value += 599
    assert link(trio, first).status_code == 200
    trio.clock.value += 1
    assert code(link(trio, second)) == "INVALID_LINK_CODE"


@pytest.mark.parametrize("raw", ["", "nope", "2" * 10, "2" * 64, "2" * 65, 12345, ["x"], {"a": 1}])
def test_unknown_or_malformed_link_codes_are_403(trio, raw):
    trio.user("Ali")
    response = link(trio, raw)
    assert response.status_code == 403
    assert code(response) == "INVALID_LINK_CODE"


def test_link_code_and_invite_paths(trio):
    ali = trio.user("Ali")
    raw = trio.client.post("/api/link-codes", headers=ali["auth"]).json()["code"]
    # link_code wins over invite_code + name: no account named Zeynep appears.
    response = trio.client.post(
        "/api/join", json={"link_code": raw, "invite_code": "correct-horse", "name": "Zeynep"}
    )
    assert response.status_code == 200
    assert response.json()["user"]["name"] == "Ali"
    # A null link_code is the old invite path.
    response = trio.client.post(
        "/api/join", json={"link_code": None, "invite_code": "correct-horse", "name": "Zeynep"}
    )
    assert response.status_code == 201


def test_at_most_five_live_link_codes_per_user(trio):
    ali, berk = trio.user("Ali"), trio.user("Berk")
    codes = [trio.client.post("/api/link-codes", headers=ali["auth"]) for _ in range(5)]
    assert all(r.status_code == 201 for r in codes)
    response = trio.client.post("/api/link-codes", headers=ali["auth"])
    assert response.status_code == 429
    assert code(response) == "TOO_MANY_LINK_CODES"
    assert trio.client.post("/api/link-codes", headers=berk["auth"]).status_code == 201
    # Using one frees its place; so does expiry.
    assert link(trio, codes[0].json()["code"]).status_code == 200
    assert trio.client.post("/api/link-codes", headers=ali["auth"]).status_code == 201
    assert trio.client.post("/api/link-codes", headers=ali["auth"]).status_code == 429
    trio.clock.value += 600
    assert trio.client.post("/api/link-codes", headers=ali["auth"]).status_code == 201


def test_link_codes_need_a_token(trio):
    assert trio.client.post("/api/link-codes").status_code == 401


def test_link_codes_are_stored_only_as_their_hash(trio):
    ali = trio.user("Ali")
    raw = trio.client.post("/api/link-codes", headers=ali["auth"]).json()["code"]
    db = sqlite3.connect(trio.client.app.state.settings.db_path)
    dump = "\n".join(db.iterdump())
    rows = db.execute("SELECT code_hash FROM link_codes").fetchall()
    db.close()
    assert rows == [(linkcodes.hash_code(raw),)]
    assert raw not in dump


def test_link_code_attempts_share_the_join_rate_limit(trio):
    here = "203.0.113.50"
    for _ in range(5):
        assert code(link(trio, "ZZZZZZZZZZ", here)) == "INVALID_LINK_CODE"
    for _ in range(5):
        assert trio.join("x", code="wrong", headers={"X-Forwarded-For": here}).status_code == 403
    ali = trio.user("Ali")
    raw = trio.client.post("/api/link-codes", headers=ali["auth"]).json()["code"]
    response = link(trio, raw, here)
    assert response.status_code == 429
    assert code(response) == "RATE_LIMITED"


# -- the admin tool ------------------------------------------------------------------


def test_admin_list_users(trio):
    trio.user("Ali")
    trio.user("Berk")
    status, out = run(trio, "list-users")
    assert status == 0
    assert "Ali" in out and "Berk" in out and "2 active user(s)" in out


def test_admin_on_a_missing_database(tmp_path, capsys):
    assert admin.main(["--db", str(tmp_path / "none.db"), "list-users"]) == 1
    assert "no database" in capsys.readouterr().err
    assert not (tmp_path / "none.db").exists()


def test_admin_unknown_user(trio, capsys):
    trio.user("Ali")
    for argv in (("remove-user", "Nobody"), ("revoke-tokens", "#99"), ("new-link-code", "\n")):
        assert run(trio, *argv)[0] == 1
    assert "no active user" in capsys.readouterr().err


def test_admin_revoke_tokens_signs_out_everywhere_and_closes_open_sockets(trio):
    ali, berk = trio.user("Ali"), trio.user("Berk")
    stale_code = trio.client.post("/api/link-codes", headers=ali["auth"]).json()["code"]
    with trio.ws(berk) as b, trio.ws(ali) as a:
        b.receive_json()  # Ali's presence
        status, out = run(trio, "revoke-tokens", "ali")
        assert status == 0 and "1 session(s)" in out
        # REST notices at once ...
        assert trio.client.get("/api/me", headers=ali["auth"]).status_code == 401
        # ... the open socket at the next re-check.
        quiet(a)
        recheck(trio)
        with pytest.raises(WebSocketDisconnect) as closed:
            while True:
                a.receive_json()
        assert closed.value.code == 4401
        assert b.receive_json()["online"] is False
        quiet(b)
    # Unused link codes went too; the account did not.
    assert code(link(trio, stale_code)) == "INVALID_LINK_CODE"
    status, out = run(trio, "new-link-code", "Ali")
    raw = out.split(": ", 1)[1].split()[0]
    assert link(trio, raw).json()["user"] == {"id": ali["id"], "name": "Ali", "avatar_url": None}


def test_admin_new_link_code(trio):
    ali = trio.user("Işıl")
    status, out = run(trio, "new-link-code", "IŞIL")
    assert status == 0
    raw = out.split(": ", 1)[1].split()[0]
    response = link(trio, raw)
    assert response.status_code == 200
    assert response.json()["user"]["id"] == ali["id"]
    # By id too, and the same five-code rule.
    for _ in range(5):
        assert run(trio, "new-link-code", f"#{ali['id']}")[0] == 0
    assert run(trio, "new-link-code", f"#{ali['id']}")[0] == 1


def test_admin_remove_user(make_trio):
    trio = make_trio(max_users=2)
    ali, berk = trio.user("Ali"), trio.user("Berk")
    with trio.ws(ali) as a:
        a.send_json({"type": "message.send", "channel_id": 1, "content": "eski mesaj"})
        assert a.receive_json()["type"] == "message.new"
    assert code(trio.join("Cem")) == "SERVER_FULL"

    with trio.ws(berk) as b, trio.ws(ali) as a:
        b.receive_json()  # Ali online
        status, out = run(trio, "remove-user", "Ali")
        assert status == 0 and "removed Ali" in out
        # Signed out at once for REST, the socket closes on the re-check, and
        # everybody learns that the account is gone.
        assert trio.client.get("/api/me", headers=ali["auth"]).status_code == 401
        recheck(trio)
        with pytest.raises(WebSocketDisconnect) as closed:
            while True:
                a.receive_json()
        assert closed.value.code == 4401
        frames = [b.receive_json(), b.receive_json()]
        assert {"type": "presence", "user_id": ali["id"], "online": False} in frames
        assert {"type": "user.removed", "user_id": ali["id"]} in frames
        quiet(b)

    # The slot and the name are free; the new Ali is somebody else.
    new_ali = trio.user("ali")
    assert new_ali["id"] != ali["id"]
    assert code(trio.join("Cem")) == "SERVER_FULL"
    # Old messages keep their author's name and id.
    messages = trio.client.get("/api/channels/1/messages", headers=berk["auth"]).json()
    assert messages["messages"][0]["author"] == {"id": ali["id"], "name": "Ali", "avatar_url": None}
    # ready.users lists only current accounts.
    with trio.ws(berk) as b:
        assert [u["id"] for u in b.ready["users"]] == [berk["id"], new_ali["id"]]
    # A removed user cannot come back through an old link code or the tool.
    assert run(trio, "remove-user", f"#{ali['id']}")[0] == 1
    status, out = run(trio, "list-users")
    assert "removed" in out and "2 active user(s)" in out


def test_a_removed_users_link_code_is_dead(trio):
    ali = trio.user("Ali")
    raw = trio.client.post("/api/link-codes", headers=ali["auth"]).json()["code"]
    # The tool deletes link codes on removal; a code that somehow survived
    # (written directly) still does not sign a removed user in.
    db = sqlite3.connect(trio.client.app.state.settings.db_path)
    db.execute("UPDATE users SET removed_at = 'x', name_key = '#removed:1' WHERE id = ?", (1,))
    db.commit()
    db.close()
    assert code(link(trio, raw)) == "INVALID_LINK_CODE"


def test_a_removed_user_stays_removed_across_a_restart(make_trio, tmp_path):
    path = str(tmp_path / "keep.db")
    first = make_trio(db_path=path)
    ali, berk = first.user("Ali"), first.user("Berk")
    assert admin.main(["--db", path, "remove-user", "Ali"], out=io.StringIO()) == 0
    second = make_trio(db_path=path)
    assert list(second.client.app.state.hub.users) == [berk["id"]]
    assert second.client.get("/api/me", headers=ali["auth"]).status_code == 401


def test_the_admin_tool_upgrades_an_old_database(tmp_path):
    path = tmp_path / "old.db"
    con = sqlite3.connect(path)
    con.executescript(
        "CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,"
        " name_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);"
        "INSERT INTO users VALUES (1, 'Ali', 'ali', '2026-01-01T00:00:00.000Z');"
    )
    con.commit()
    con.close()
    out = io.StringIO()
    assert admin.main(["--db", str(path), "remove-user", "Ali"], out=out) == 0
    con = sqlite3.connect(path)
    assert con.execute("SELECT name, name_key FROM users").fetchall() == [("Ali", "#removed:1")]
    con.close()
