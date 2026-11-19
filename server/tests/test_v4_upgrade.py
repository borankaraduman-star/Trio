"""A database written by the v3 server upgrades on boot and every v4 feature works on it."""

from __future__ import annotations

import hashlib
import sqlite3

from starlette.testclient import TestClient

from trio_server import Settings, create_app

from .conftest import INVITE
from .imagegen import png

# The schema of the v3 server (dev before CONTRACT-V4), verbatim in shape.
V3_SCHEMA = """
CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
    name_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, removed_at TEXT);
CREATE TABLE tokens (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL);
CREATE TABLE channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('text', 'voice')), created_at TEXT NOT NULL);
CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    author_id INTEGER NOT NULL REFERENCES users(id),
    content TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX idx_messages_channel_id ON messages (channel_id, id);
CREATE TABLE attachments (
    id TEXT PRIMARY KEY, uploader_id INTEGER NOT NULL REFERENCES users(id),
    message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE, position INTEGER,
    filename TEXT NOT NULL, content_type TEXT NOT NULL, size INTEGER NOT NULL,
    created_at TEXT NOT NULL, created_ts REAL NOT NULL);
CREATE INDEX idx_attachments_message ON attachments (message_id, position);
CREATE INDEX idx_attachments_orphans ON attachments (created_ts) WHERE message_id IS NULL;
CREATE INDEX idx_attachments_uploader ON attachments (uploader_id);
CREATE TABLE link_codes (
    code_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_ts REAL NOT NULL, expires_ts REAL NOT NULL);
CREATE INDEX idx_link_codes_user ON link_codes (user_id, expires_ts);
"""
TS = "2026-11-01T00:00:00.000Z"
ATT = "A" * 43


def build_v3(tmp_path):
    path = tmp_path / "v3.db"
    uploads = tmp_path / "uploads"
    uploads.mkdir()
    con = sqlite3.connect(path)
    con.executescript(V3_SCHEMA)
    for uid, name, token in ((1, "Ali", "tok-ali"), (2, "Berk", "tok-berk")):
        con.execute("INSERT INTO users VALUES (?, ?, ?, ?, NULL)", (uid, name, name.lower(), TS))
        con.execute(
            "INSERT INTO tokens VALUES (?, ?, ?)",
            (hashlib.sha256(token.encode()).hexdigest(), uid, TS),
        )
    con.execute("INSERT INTO channels VALUES (1, 'genel', 'text', ?)", (TS,))
    con.execute("INSERT INTO channels VALUES (2, 'Sohbet', 'voice', ?)", (TS,))
    con.execute("INSERT INTO messages VALUES (1, 1, 1, 'eski mesaj', ?)", (TS,))
    con.execute("INSERT INTO messages VALUES (2, 1, 1, '', ?)", (TS,))
    con.execute(
        "INSERT INTO attachments VALUES (?, 1, 2, 0, 'eski.png', 'image/png', 4, ?, 1)", (ATT, TS)
    )
    con.commit()
    con.close()
    (uploads / ATT).write_bytes(b"\x89PNG")
    return path, uploads


def test_a_v3_database_upgrades_and_every_v4_feature_works(tmp_path):
    path, uploads = build_v3(tmp_path)
    settings = Settings(invite_code=INVITE, db_path=str(path), upload_dir=str(uploads))
    ali = {"Authorization": "Bearer tok-ali"}
    berk = {"Authorization": "Bearer tok-berk"}
    with TestClient(create_app(settings)) as client:
        old = client.get("/api/channels/1/messages", headers=ali).json()["messages"]
        assert [m["id"] for m in old] == [1, 2]
        assert old[0]["edited_at"] is None and old[0]["reactions"] == [] and old[0]["rev"] == 0
        assert old[0]["author"] == {"id": 1, "name": "Ali", "avatar_url": None}
        # Reply to an old message, react, pin, edit, delete.
        with client.websocket_connect("/ws?token=tok-ali") as sock:
            ready = sock.receive_json()
            assert ready["server"] == {"name": "Trio", "icon_url": None}
            sock.send_json(
                {"type": "message.send", "channel_id": 1, "content": "cevap", "reply_to": 2}
            )
            reply = sock.receive_json()["message"]
            assert reply["reply_to"] == {
                "id": 2,
                "author": {"id": 1, "name": "Ali"},
                "excerpt": "📎 eski.png",
            }
        assert client.put("/api/messages/1/reactions/%F0%9F%91%8D", headers=berk).status_code == 200
        assert client.put("/api/messages/1/pin", headers=berk).json()["message"]["pinned_by"] == 2
        edited = client.patch("/api/messages/1", json={"content": "yeni"}, headers=ali).json()
        assert edited["message"]["edited_at"] is not None and edited["message"]["rev"] == 3
        assert client.delete("/api/messages/2", headers=ali).status_code == 204
        assert not (uploads / ATT).exists()
        listed = client.get("/api/channels/1/messages", headers=ali).json()["messages"]
        assert listed[-1]["reply_to"] == {"id": 2, "deleted": True}
        pins = client.get("/api/channels/1/pins", headers=ali).json()["messages"]
        assert [m["id"] for m in pins] == [1]
        # Identity.
        response = client.put("/api/me/avatar", files={"file": ("a.png", png(16, 16))}, headers=ali)
        assert response.status_code == 200, response.text
        assert client.patch("/api/me", json={"name": "Alican"}, headers=ali).status_code == 200
        assert client.patch("/api/server", json={"name": "Biz"}, headers=ali).status_code == 200
        icon = client.put(
            "/api/server/icon", files={"file": ("i.png", png(8, 8))}, headers=berk
        ).json()
        assert client.get(icon["server"]["icon_url"]).status_code == 200
    # Boots again on the upgraded file; nothing applied twice.
    with TestClient(create_app(settings)) as client:
        me = client.get("/api/me", headers=ali).json()["user"]
        assert me["name"] == "Alican" and me["avatar_url"] is not None
        assert client.get("/api/server", headers=ali).json()["server"]["name"] == "Biz"
    con = sqlite3.connect(path)
    columns = {r[1] for r in con.execute("PRAGMA table_info(messages)")}
    assert {"edited_at", "reply_to_id", "rev"} <= columns
    assert "avatar" in {r[1] for r in con.execute("PRAGMA table_info(users)")}
    assert con.execute("SELECT count(*) FROM server_profile").fetchone() == (1,)
    con.close()


def test_the_admin_tool_works_on_a_v3_database(tmp_path):
    import io

    from trio_server import admin

    path, _ = build_v3(tmp_path)
    out = io.StringIO()
    assert admin.main(["--db", str(path), "list-users"], out=out) == 0
    assert "Ali" in out.getvalue()
    con = sqlite3.connect(path)
    assert "rev" in {r[1] for r in con.execute("PRAGMA table_info(messages)")}
    con.close()
