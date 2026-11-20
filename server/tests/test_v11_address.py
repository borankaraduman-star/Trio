"""CONTRACT-V11-ADDRESS: the canonical address, moving a device, recovery, where sessions are."""

from __future__ import annotations

import logging
import sqlite3

import httpx
import pytest
from starlette.testclient import TestClient

from trio_server import Settings, create_app
from trio_server.config import ConfigError, normalize_public_url

from .conftest import INVITE

CANON = "http://127.0.0.1:9000"
NEW = {"Host": "127.0.0.1:9000"}
RECOVERY = "r3c0very-" + "x" * 30


def _app(make_trio, **extra):
    values = {"public_url": CANON, "test_http_public_url": True}
    values.update(extra)
    return make_trio(**values)


def _move(trio, user, prefs=None, headers=None):
    return trio.client.post(
        "/api/move", json={"prefs": prefs or {}}, headers=headers or user["auth"]
    )


def _redeem(trio, code, address="203.0.113.9"):
    return trio.client.post(
        "/api/join",
        json={"link_code": code},
        headers={**NEW, "X-Forwarded-For": address},
    )


# -- configuration ----------------------------------------------------------------


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("https://trio.example.org", "https://trio.example.org"),
        ("https://Trio.Example.org/", "https://trio.example.org"),
        ("HTTPS://trio.example.org:8443", "https://trio.example.org:8443"),
    ],
)
def test_public_url_normalised(raw, expected):
    assert normalize_public_url(raw) == expected


@pytest.mark.parametrize(
    "raw",
    [
        "http://trio.example.org",
        "https://trio.example.org/path",
        "https://user@trio.example.org",
        "https://trio.example.org?x=1",
        "https://trio.example.org#a",
        "trio.example.org",
        "https://",
        "http://127.0.0.1:9000",
    ],
)
def test_public_url_refused(raw):
    with pytest.raises(ConfigError):
        Settings.from_env({"TRIO_INVITE_CODE": "x", "TRIO_PUBLIC_URL": raw})


def test_http_public_url_only_in_test_mode_and_never_on_railway():
    env = {"TRIO_INVITE_CODE": "x", "TRIO_PUBLIC_URL": CANON, "TRIO_TEST_HTTP_PUBLIC_URL": "1"}
    assert Settings.from_env(env).public_url == CANON
    with pytest.raises(ConfigError):
        Settings.from_env({**env, "TRIO_PUBLIC_URL": "http://example.org:9000"})
    with pytest.raises(ConfigError):
        Settings.from_env({**env, "RAILWAY_ENVIRONMENT": "production"})


def test_recovery_code_must_be_long():
    with pytest.raises(ConfigError):
        Settings.from_env({"TRIO_INVITE_CODE": "x", "TRIO_RECOVERY_CODE": "short"})
    settings = Settings.from_env({"TRIO_INVITE_CODE": "x", "TRIO_RECOVERY_CODE": RECOVERY + " "})
    assert settings.recovery_code == RECOVERY
    assert RECOVERY not in repr(settings)


# -- canonical URLs ---------------------------------------------------------------


def _static(tmp_path):
    static = tmp_path / "static"
    static.mkdir()
    (static / "index.html").write_text("<html></html>")
    (static / "indir.html").write_text(
        '<meta property="og:url" content="/indir">'
        '<link rel="canonical" href="/indir">'
        '<script type="application/ld+json">{"url": "/indir", "image": "/og/a.png"}</script>'
    )
    return str(static)


def test_unset_changes_nothing(make_trio, tmp_path):
    trio = make_trio(static_dir=_static(tmp_path))
    assert "public_url" not in trio.client.get("/api/health").json()
    page = trio.client.get("/indir", headers={"Host": "old.example"}).text
    assert 'content="http://old.example/indir"' in page
    assert (
        "Sitemap: http://old.example/sitemap.xml"
        in trio.client.get("/robots.txt", headers={"Host": "old.example"}).text
    )
    user = trio.user("Ali")
    assert _move(trio, user).json()["error"]["code"] == "NO_PUBLIC_URL"


def test_canonical_url_everywhere(make_trio, tmp_path):
    trio = _app(make_trio, static_dir=_static(tmp_path))
    assert trio.client.get("/api/health").json()["public_url"] == CANON
    page = trio.client.get("/indir", headers={"Host": "old.example"}).text
    assert f'content="{CANON}/indir"' in page
    assert f'href="{CANON}/indir"' in page
    assert f'"url": "{CANON}/indir"' in page
    assert f'"image": "{CANON}/og/a.png"' in page
    assert "old.example" not in page
    robots = trio.client.get("/robots.txt", headers={"Host": "evil.example"}).text
    assert f"Sitemap: {CANON}/sitemap.xml" in robots
    sitemap = trio.client.get("/sitemap.xml", headers={"Host": "a b"}).text
    assert f"<loc>{CANON}/indir</loc>" in sitemap


# -- the move -----------------------------------------------------------------------


def test_full_move(make_trio):
    trio = _app(make_trio)
    ali = trio.user("Ali")
    prefs = {
        "trio.settings": '{"ptt": true}',
        "trio.token": "SECRET",
        "trio.user": "{}",
        "trio.push.device": "d",
        "evil": "x",
        "trio.invite": INVITE,
        "trio.drafts": "{}",
        "trio.voice6": 5,
    }
    with trio.ws(ali) as sock:
        made = _move(trio, ali, prefs)
        assert made.status_code == 201, made.text
        body = made.json()
        code = body["code"]
        assert body["url"] == f"{CANON}/#tasi={code}"
        assert body["public_url"] == CANON

        peek = trio.client.post("/api/move/peek", json={"code": code.lower()}, headers=NEW)
        assert peek.status_code == 200
        assert peek.json()["user"]["name"] == "Ali"
        # peek redeems nothing
        assert (
            trio.client.post("/api/move/peek", json={"code": code}, headers=NEW).status_code == 200
        )

        redeemed = _redeem(trio, code)
        assert redeemed.status_code == 200, redeemed.text
        out = redeemed.json()
        assert out["user"]["id"] == ali["id"]
        assert out["move"]["prefs"] == {
            "trio.settings": '{"ptt": true}',
            "trio.invite": INVITE,
            "trio.drafts": "{}",
        }
        new_auth = {"Authorization": f"Bearer {out['token']}"}
        # single use, and the server forgot the prefs
        assert _redeem(trio, code).status_code == 403
        con = sqlite3.connect(trio.client.app.state.settings.db_path)
        assert con.execute("SELECT count(*) FROM move_codes").fetchone() == (0,)
        assert "SECRET" not in str(con.execute("SELECT * FROM tokens").fetchall())

        # the old session works until the new one is confirmed
        assert trio.client.get("/api/me", headers=ali["auth"]).status_code == 200
        confirmed = trio.client.post("/api/move/confirm", headers={**new_auth, **NEW})
        assert confirmed.json() == {"ended": 1}
        assert sock.receive()["type"] == "websocket.close"
    assert trio.client.get("/api/me", headers=ali["auth"]).status_code == 401
    assert trio.client.post("/api/move/confirm", headers={**new_auth, **NEW}).json() == {"ended": 0}
    assert trio.client.get("/api/me", headers=new_auth).status_code == 200


def test_wrong_invite_not_carried(make_trio):
    trio = _app(make_trio)
    ali = trio.user("Ali")
    code = _move(trio, ali, {"trio.invite": "guess"}).json()["code"]
    assert _redeem(trio, code).json()["move"]["prefs"] == {}


def test_prefs_caps(make_trio):
    trio = _app(make_trio)
    ali = trio.user("Ali")
    big = "x" * (33 * 1024)
    near = "y" * (30 * 1024)
    prefs = {"trio.settings": big, "trio.voice6": near, "trio.music8": near, "trio.channel": near}
    code = _move(trio, ali, prefs).json()["code"]
    carried = _redeem(trio, code).json()["move"]["prefs"]
    assert "trio.settings" not in carried  # over the per-key cap
    assert set(carried) == {"trio.voice6", "trio.music8"}  # the third would pass 64 KiB
    assert _move(trio, ali, prefs=None).status_code == 201
    assert (
        trio.client.post("/api/move", json={"prefs": []}, headers=ali["auth"]).json()["error"][
            "code"
        ]
        == "INVALID_PREFS"
    )
    huge = trio.client.post("/api/move", json={"prefs": {"a": "z" * 200_000}}, headers=ali["auth"])
    assert huge.status_code == 413


def test_move_refusals(make_trio):
    trio = _app(make_trio)
    ali = trio.user("Ali")
    assert (
        _move(trio, ali, headers={**ali["auth"], **NEW}).json()["error"]["code"] == "ALREADY_HERE"
    )
    foreign = _move(trio, ali, headers={**ali["auth"], "Origin": "https://evil.example"})
    assert foreign.status_code == 403
    assert trio.client.post("/api/move", json={}).status_code == 401
    code = _move(trio, ali).json()["code"]
    # redeemed / peeked on the old origin: refused, the code survives
    old = trio.client.post("/api/join", json={"link_code": code})
    assert old.json()["error"]["code"] == "NOT_CANONICAL"
    assert trio.client.post("/api/move/peek", json={"code": code}).status_code == 409
    assert _redeem(trio, code).status_code == 200


def test_one_live_code_per_session_and_not_a_link_code(make_trio):
    trio = _app(make_trio)
    ali = trio.user("Ali")
    first = _move(trio, ali).json()["code"]
    second = _move(trio, ali).json()["code"]
    assert _redeem(trio, first).status_code == 403
    # move codes do not eat the 5 link codes
    for _ in range(5):
        assert trio.client.post("/api/link-codes", headers=ali["auth"]).status_code == 201
    assert _redeem(trio, second).status_code == 200


def test_expiry_and_dead_session(make_trio):
    trio = _app(make_trio)
    ali = trio.user("Ali")
    code = _move(trio, ali).json()["code"]
    trio.clock.value += 601
    assert _redeem(trio, code).status_code == 403
    code = _move(trio, ali).json()["code"]
    assert trio.client.delete("/api/session", headers=ali["auth"]).status_code == 204
    assert trio.client.post("/api/move/peek", json={"code": code}, headers=NEW).status_code == 403
    assert _redeem(trio, code).status_code == 403


def test_wrong_codes_spend_the_limiter(make_trio):
    trio = _app(make_trio)
    headers = {**NEW, "X-Forwarded-For": "203.0.113.50"}
    statuses = [
        trio.client.post("/api/move/peek", json={"code": "ABCDEFGHJK"}, headers=headers).status_code
        for _ in range(11)
    ]
    assert statuses[:10] == [403] * 10
    assert statuses[10] == 429


def test_adopt(make_trio):
    trio = _app(make_trio)
    ali = trio.user("Ali")
    berk = trio.user("Berk")
    new_ali = trio.client.post(
        "/api/join",
        json={"link_code": trio.client.post("/api/link-codes", headers=ali["auth"]).json()["code"]},
        headers={"X-Forwarded-For": "198.51.100.200"},
    ).json()
    new_auth = {"Authorization": f"Bearer {new_ali['token']}"}
    code = _move(trio, ali, {"trio.lastName": "Ali"}).json()["code"]
    other = trio.client.post(
        "/api/move/adopt", json={"code": code}, headers={**berk["auth"], **NEW}
    )
    assert other.json()["error"]["code"] == "OTHER_ACCOUNT"
    assert trio.client.get("/api/me", headers=ali["auth"]).status_code == 200
    code = _move(trio, ali, {"trio.lastName": "Ali"}).json()["code"]
    done = trio.client.post("/api/move/adopt", json={"code": code}, headers={**new_auth, **NEW})
    assert done.status_code == 200
    assert done.json()["prefs"] == {"trio.lastName": "Ali"}
    assert done.json()["ended"] == 1
    assert trio.client.get("/api/me", headers=ali["auth"]).status_code == 401


def test_push_subscriptions_of_the_old_session_go(make_trio):
    trio = _app(make_trio)
    ali = trio.user("Ali")
    db = trio.client.app.state.settings.db_path
    con = sqlite3.connect(db)
    con.execute(
        "INSERT INTO push_subscriptions (user_id, token_hash, endpoint, p256dh, auth, "
        "ua_family, label, created_at) SELECT user_id, token_hash, 'https://push.example/1', "
        "'k', 'a', 'chrome', 'x', 'now' FROM tokens"
    )
    con.commit()
    code = _move(trio, ali).json()["code"]
    token = _redeem(trio, code).json()["token"]
    trio.client.post("/api/move/confirm", headers={"Authorization": f"Bearer {token}"})
    assert con.execute("SELECT count(*) FROM push_subscriptions").fetchone() == (0,)


def test_revoke_tokens_drops_move_codes(make_trio):
    trio = _app(make_trio)
    ali = trio.user("Ali")
    _move(trio, ali)
    from trio_server import admin

    con = sqlite3.connect(trio.client.app.state.settings.db_path, isolation_level=None)
    con.row_factory = sqlite3.Row
    admin.do_revoke_tokens(con, "Ali")
    assert tuple(con.execute("SELECT count(*) FROM move_codes").fetchone()) == (0,)


# -- where sessions are, the owner's view ------------------------------------------


def _transport(data_since_of):
    def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == f"{CANON}/api/health"
        return httpx.Response(200, json={"ok": True, "data_since": data_since_of()})

    return httpx.MockTransport(handler)


def test_owner_address_counts(make_trio):
    holder: dict = {}
    trio = _app(make_trio, http_transport=_transport(lambda: holder["since"]))
    holder["since"] = trio.client.app.state.boot["data_since"]
    ali = trio.user("Ali")  # the owner (lowest id)
    berk = trio.user("Berk")
    trio.client.get("/api/me", headers=ali["auth"])
    trio.client.get("/api/me", headers=berk["auth"])
    view = trio.client.get("/api/owner/address", headers=ali["auth"]).json()
    assert view["public_url"] == CANON
    assert view["sessions"] == {"total": 2, "canonical": 0, "other": 2, "unknown": 0, "moved": 0}
    assert view["other_origins"] == [{"origin": "http://testserver", "sessions": 2}]
    assert view["reachable"]["ok"] and view["reachable"]["same_server"]
    assert view["safe_to_retire"] is False
    for user in (ali, berk):
        token = _redeem(trio, _move(trio, user).json()["code"], f"203.0.113.{user['id']}").json()[
            "token"
        ]
        auth = {"Authorization": f"Bearer {token}"}
        trio.client.post("/api/move/confirm", headers={**auth, **NEW})
        if user is ali:
            ali_auth = {**auth, **NEW}
    view = trio.client.get("/api/owner/address", headers=ali_auth).json()
    assert view["sessions"] == {"total": 2, "canonical": 2, "other": 0, "unknown": 0, "moved": 2}
    assert view["safe_to_retire"] is True
    assert view["request_origin"] == CANON
    berk_new = trio.client.get("/api/owner/address", headers={**berk["auth"]})
    assert berk_new.status_code == 401


def test_owner_address_non_owner_and_unreachable(make_trio):
    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no")

    trio = _app(make_trio, http_transport=httpx.MockTransport(down))
    ali = trio.user("Ali")
    berk = trio.user("Berk")
    assert trio.client.get("/api/owner/address", headers=berk["auth"]).status_code == 403
    view = trio.client.get("/api/owner/address", headers=ali["auth"]).json()
    assert view["reachable"]["ok"] is False
    assert view["reachable"]["detail"] == "ConnectError"
    assert view["safe_to_retire"] is False


def test_origin_is_written_only_on_change(make_trio):
    trio = _app(make_trio)
    ali = trio.user("Ali")
    origins = trio.client.app.state.session_origins
    trio.client.get("/api/me", headers=ali["auth"])
    calls = []
    original = origins.db.conn.execute

    def counting(sql, *args):
        if sql.startswith("UPDATE tokens SET last_origin"):
            calls.append(sql)
        return original(sql, *args)

    origins.db.conn.execute = counting  # type: ignore[method-assign]
    try:
        for _ in range(5):
            trio.client.get("/api/me", headers=ali["auth"])
        assert calls == []
        trio.client.get("/api/me", headers={**ali["auth"], **NEW})
        assert len(calls) == 1
    finally:
        origins.db.conn.execute = original  # type: ignore[method-assign]


def test_schema_upgrade_from_v10_tokens(tmp_path):
    path = tmp_path / "v10.db"
    con = sqlite3.connect(path)
    con.executescript(
        """
        CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
            name_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, removed_at TEXT,
            avatar TEXT);
        CREATE TABLE tokens (token_hash TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            created_at TEXT NOT NULL);
        """
    )
    from trio_server.db import hash_token

    con.execute("INSERT INTO users VALUES (1, 'Ali', 'ali', 'now', NULL, NULL)")
    con.execute("INSERT INTO tokens VALUES (?, 1, 'now')", (hash_token("tok-ali"),))
    con.commit()
    con.close()
    settings = Settings(
        invite_code=INVITE,
        db_path=str(path),
        upload_dir=str(tmp_path / "up"),
        public_url=CANON,
        test_http_public_url=True,
    )
    with TestClient(create_app(settings)) as client:
        auth = {"Authorization": "Bearer tok-ali"}
        assert client.get("/api/me", headers=auth).status_code == 200
        made = client.post("/api/move", json={}, headers=auth)
        assert made.status_code == 201
        token = client.post(
            "/api/join", json={"link_code": made.json()["code"]}, headers=NEW
        ).json()["token"]
        assert client.post(
            "/api/move/confirm", headers={"Authorization": f"Bearer {token}"}
        ).json() == {"ended": 1}
    cols = {r[1] for r in sqlite3.connect(path).execute("PRAGMA table_info(tokens)")}
    assert {"last_origin", "via_move", "moved_from"} <= cols


# -- recovery -------------------------------------------------------------------------


def _recover(trio, code, address="203.0.113.77"):
    return trio.client.post(
        "/api/join", json={"recovery_code": code}, headers={"X-Forwarded-For": address}
    )


def test_recovery_off_by_default(make_trio):
    trio = make_trio()
    trio.user("Ali")
    response = _recover(trio, RECOVERY)
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "INVALID_RECOVERY_CODE"


def test_recovery_signs_in_the_owner(make_trio, caplog):
    trio = make_trio(recovery_code=RECOVERY)
    ali = trio.user("Ali")
    trio.user("Berk")
    assert _recover(trio, RECOVERY[:-1] + "y").status_code == 403
    with caplog.at_level(logging.WARNING, logger="trio"):
        response = _recover(trio, RECOVERY)
    assert response.status_code == 200
    body = response.json()
    assert body["recovery"] is True and body["user"]["id"] == ali["id"]
    assert any("recovery.used" in r.getMessage() for r in caplog.records)
    assert RECOVERY not in caplog.text
    auth = {"Authorization": f"Bearer {body['token']}"}
    me = trio.client.get("/api/me", headers=auth).json()["user"]
    assert me["is_owner"] is True
    view = trio.client.get("/api/owner/address", headers=auth).json()
    assert view["recovery"]["configured"] is True
    assert view["recovery"]["used_at"] is not None
    assert view["recovery"]["uses_this_boot"] == 1


def test_recovery_per_boot_limit(make_trio):
    trio = make_trio(recovery_code=RECOVERY)
    trio.user("Ali")
    for i in range(3):
        assert _recover(trio, RECOVERY, f"203.0.113.{i + 1}").status_code == 200
    limited = _recover(trio, RECOVERY, "203.0.113.9")
    assert limited.status_code == 429
    assert limited.json()["error"]["code"] == "RECOVERY_LIMIT"


def test_recovery_spends_the_join_limiter(make_trio):
    trio = make_trio(recovery_code=RECOVERY)
    trio.user("Ali")
    statuses = [_recover(trio, "nope", "203.0.113.200").status_code for _ in range(11)]
    assert statuses[:10] == [403] * 10 and statuses[10] == 429


def test_recovery_no_owner(make_trio):
    trio = make_trio(recovery_code=RECOVERY, owner="Nobody")
    trio.user("Ali")
    assert _recover(trio, RECOVERY).json()["error"]["code"] == "NO_OWNER"


def test_recovery_mark_cleared_when_unset(make_trio, tmp_path):
    db = str(tmp_path / "rec.db")
    trio = make_trio(recovery_code=RECOVERY, db_path=db)
    trio.user("Ali")
    assert _recover(trio, RECOVERY).status_code == 200
    trio.client.__exit__(None, None, None)
    con = sqlite3.connect(db)
    assert con.execute("SELECT count(*) FROM meta WHERE key='recovery_used_at'").fetchone() == (1,)
    con.close()
    again = make_trio(db_path=db)
    again.client.get("/api/health")
    con = sqlite3.connect(db)
    assert con.execute("SELECT count(*) FROM meta WHERE key='recovery_used_at'").fetchone() == (0,)


def test_backup_snapshot_has_no_move_codes(make_trio):
    trio = _app(make_trio)
    ali = trio.user("Ali")
    _move(trio, ali)
    ticket = trio.client.post("/api/owner/backup-tickets", headers=ali["auth"]).json()
    archive = trio.client.get(ticket["url"])
    assert archive.status_code == 200
    import io
    import tarfile

    with tarfile.open(fileobj=io.BytesIO(archive.content)) as tar:
        data = tar.extractfile("trio.db").read()
    import tempfile

    with tempfile.NamedTemporaryFile(suffix=".db") as tmp:
        tmp.write(data)
        tmp.flush()
        snap = sqlite3.connect(tmp.name)
        assert snap.execute("SELECT count(*) FROM move_codes").fetchone() == (0,)
        snap.close()
