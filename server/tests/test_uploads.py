from __future__ import annotations

import os
import sqlite3
from pathlib import Path
from urllib.parse import quote

import pytest
from starlette.testclient import TestClient

from trio_server import Settings, create_app
from trio_server.uploads import clean_filename, sniff_content_type

from .conftest import INVITE, quiet

TEXT = 1
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 100
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 100
GIF = b"GIF89a" + b"\x00" * 50
WEBP = b"RIFF\x10\x00\x00\x00WEBPVP8 " + b"\x00" * 50
MP4 = b"\x00\x00\x00\x18ftypisom" + b"\x00" * 50
WEBM = b"\x1a\x45\xdf\xa3\x9f\x42\x86\x81\x01\x42\x82\x84webm" + b"\x00" * 50
PDF = b"%PDF-1.7\n" + b"\x00" * 50


def upload(trio, user, content: bytes = PNG, filename: str = "kedi.png", **kwargs):
    return trio.client.post(
        "/api/uploads",
        files={"file": (filename, content, kwargs.pop("mime", "application/octet-stream"))},
        headers=user["auth"],
        **kwargs,
    )


def upload_dir(trio) -> Path:
    return Path(trio.client.app.state.settings.upload_dir)


def stored_files(trio) -> list[str]:
    # Files only: the avatars/ and icons/ subdirectories (CONTRACT-V4 C) are not uploads.
    return sorted(p.name for p in upload_dir(trio).iterdir() if p.is_file())


# -- upload -------------------------------------------------------------------


def test_upload_ok(trio):
    ali = trio.user("Ali")
    response = upload(trio, ali, PNG, "kedi resmi.png", mime="text/html")
    assert response.status_code == 201, response.text
    attachment = response.json()["attachment"]
    assert set(attachment) == {
        "id",
        "filename",
        "content_type",
        "size",
        "url",
        # V6 (CONTRACT-V6-MEDIA)
        "preview_url",
        "width",
        "height",
        "voice",
    }
    assert len(attachment["id"]) == 43
    assert attachment["filename"] == "kedi resmi.png"
    # Decided from the bytes, not from what the client claimed.
    assert attachment["content_type"] == "image/png"
    assert attachment["size"] == len(PNG)
    assert attachment["url"] == f"/api/files/{attachment['id']}/kedi%20resmi.png"
    # Stored under the id only, nothing partial left over.
    assert stored_files(trio) == [attachment["id"]]
    assert (upload_dir(trio) / attachment["id"]).read_bytes() == PNG


def test_upload_needs_auth(trio):
    response = trio.client.post("/api/uploads", files={"file": ("a.png", PNG)})
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "UNAUTHORIZED"
    assert stored_files(trio) == []


def test_upload_too_large_is_413_and_leaves_nothing(make_trio):
    trio = make_trio(max_upload_mb=1)
    ali = trio.user("Ali")
    response = upload(trio, ali, b"x" * (1024 * 1024 + 1), "big.bin")
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "FILE_TOO_LARGE"
    assert stored_files(trio) == []
    # Exactly the limit is fine.
    assert upload(trio, ali, b"x" * (1024 * 1024), "ok.bin").status_code == 201


def test_upload_too_large_is_counted_while_streaming(make_trio):
    """A chunked body (no Content-Length) is cut off at the limit as it arrives."""
    trio = make_trio(max_upload_mb=1)
    ali = trio.user("Ali")
    boundary = "trio-boundary"
    head = (
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="b.bin"\r\n'
        "Content-Type: application/octet-stream\r\n\r\n"
    ).encode()
    sent = []

    def body():
        yield head
        for _ in range(40):  # 40 x 64 KiB = 2.5 MiB, past the 1 MiB limit
            sent.append(1)
            yield b"y" * 65536
        yield f"\r\n--{boundary}--\r\n".encode()

    response = trio.client.post(
        "/api/uploads",
        content=body(),
        headers={**ali["auth"], "Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "FILE_TOO_LARGE"
    assert stored_files(trio) == []


def test_upload_declared_length_over_the_limit_is_refused_up_front(make_trio):
    trio = make_trio(max_upload_mb=1)
    ali = trio.user("Ali")
    response = trio.client.post(
        "/api/uploads",
        content=b"",
        headers={
            **ali["auth"],
            "Content-Type": "multipart/form-data; boundary=x",
            "Content-Length": str(5 * 1024 * 1024),
        },
    )
    assert response.status_code == 413


@pytest.mark.parametrize(
    ("kwargs", "why"),
    [
        ({"files": {"file": ("empty.txt", b"")}}, "empty file"),
        ({"files": {"file": ("", b"abc")}}, "empty filename"),
        ({"files": {"file": ("../", b"abc")}}, "only a path"),
        ({"files": {"other": ("a.txt", b"abc")}}, "no file part"),
        ({"data": {"file": "abc"}}, "a field, not a file"),
        ({"json": {"file": "abc"}}, "not multipart"),
        (
            {"content": b"garbage", "headers": {"Content-Type": "multipart/form-data"}},
            "no boundary",
        ),
    ],
)
def test_upload_invalid(trio, kwargs, why):
    ali = trio.user("Ali")
    headers = {**ali["auth"], **kwargs.pop("headers", {})}
    response = trio.client.post("/api/uploads", headers=headers, **kwargs)
    assert response.status_code == 422, why
    assert response.json()["error"]["code"] == "INVALID_UPLOAD", why
    assert stored_files(trio) == [], why


def test_upload_truncated_body_is_refused(trio):
    ali = trio.user("Ali")
    boundary = "bnd"
    body = (
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n\r\n'
        "hello"
    ).encode()
    response = trio.client.post(
        "/api/uploads",
        content=body,
        headers={**ali["auth"], "Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    assert response.status_code == 422
    assert stored_files(trio) == []


@pytest.mark.parametrize(
    ("raw", "clean"),
    [
        ("../../etc/passwd", "passwd"),
        ("..\\..\\windows\\system32\\a.dll", "a.dll"),
        ("/abs/path/x.txt", "x.txt"),
        ("a\x00b\nc‮d.txt", "abcd.txt"),
        ("  boşluk.txt  ", "boşluk.txt"),
        ("..", None),
        (".", None),
        ("dir/", None),
        ("x" * 200 + ".jpeg", "x" * 115 + ".jpeg"),
        ("y" * 200, "y" * 120),
    ],
)
def test_clean_filename(raw, clean):
    assert clean_filename(raw) == clean
    if clean is not None:
        assert len(clean) <= 120


def test_traversal_filenames_never_become_paths(trio, tmp_path):
    ali = trio.user("Ali")
    for name in ("../../evil.txt", "..%2f..%2fevil.txt", "/etc/passwd", "a/../../b.txt"):
        response = upload(trio, ali, b"data", name)
        assert response.status_code == 201, name
        attachment = response.json()["attachment"]
        assert "/" not in attachment["filename"]
        assert (upload_dir(trio) / attachment["id"]).is_file()
    assert not (tmp_path / "evil.txt").exists()
    assert all(len(f) == 43 for f in stored_files(trio))


@pytest.mark.parametrize(
    ("content", "filename", "expected"),
    [
        (PNG, "a.bin", "image/png"),
        (JPEG, "a", "image/jpeg"),
        (GIF, "a.gif", "image/gif"),
        (WEBP, "a.txt", "image/webp"),
        (MP4, "a.mp4", "video/mp4"),
        (WEBM, "a.webm", "video/webm"),
        (PDF, "a.pdf", "application/pdf"),
        (b"hello", "notes.txt", "text/plain"),
        (b"<html>", "page.html", "text/html"),
        (b"<svg/>", "logo.svg", "image/svg+xml"),
        (b"ID3\x03rest", "song.mp3", "audio/mpeg"),
        (b"OggS\x00rest", "a.ogg", "audio/ogg"),
        (b"RIFF\x00\x00\x00\x00WAVEfmt ", "a.wav", "audio/wav"),
        (b"not really a png", "fake.png", "application/octet-stream"),
        (b"what", "a.exe", "application/octet-stream"),
        (b"what", "noext", "application/octet-stream"),
    ],
)
def test_sniffing(content, filename, expected):
    assert sniff_content_type(content[:64], filename) == expected


# -- download -----------------------------------------------------------------


def download(trio, attachment, **kwargs):
    return trio.client.get(attachment["url"], **kwargs)


@pytest.mark.parametrize(
    ("content", "filename", "disposition"),
    [
        (PNG, "kedi.png", "inline"),
        (JPEG, "a.jpg", "inline"),
        (GIF, "a.gif", "inline"),
        (WEBP, "a.webp", "inline"),
        (MP4, "a.mp4", "inline"),
        (WEBM, "a.webm", "inline"),
        (PDF, "a.pdf", "inline"),
        (b"ID3\x03", "a.mp3", "inline"),
        (b"OggS\x00", "a.ogg", "inline"),
        (b"RIFF\x00\x00\x00\x00WAVE", "a.wav", "inline"),
        (b"<html><script>alert(1)</script>", "x.html", "attachment"),
        (b"<svg onload=alert(1)/>", "x.svg", "attachment"),
        (b"hello", "a.txt", "attachment"),
        (b"\x00\x01", "a.bin", "attachment"),
    ],
)
def test_download_headers_and_disposition(trio, content, filename, disposition):
    ali = trio.user("Ali")
    attachment = upload(trio, ali, content, filename).json()["attachment"]
    response = download(trio, attachment)  # no auth: the id is the capability
    assert response.status_code == 200
    assert response.content == content
    assert response.headers["content-type"].split(";")[0] == attachment["content_type"]
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["content-security-policy"] == "sandbox; default-src 'none'"
    assert response.headers["cache-control"] == "private, max-age=31536000, immutable"
    disp = response.headers["content-disposition"]
    assert disp.split(";")[0] == disposition
    assert f"filename*=UTF-8''{quote(filename, safe='')}" in disp
    assert response.headers["accept-ranges"] == "bytes"


def test_download_non_ascii_and_quote_filenames(trio):
    ali = trio.user("Ali")
    name = 'çay "fincanı";.txt'
    attachment = upload(trio, ali, b"x", name).json()["attachment"]
    assert attachment["url"].endswith("/" + quote(name, safe=""))
    disp = download(trio, attachment).headers["content-disposition"]
    assert disp.startswith('attachment; filename="_ay _fincan___.txt"; ')
    assert disp.endswith("filename*=UTF-8''" + quote(name, safe=""))


def test_download_range(trio):
    ali = trio.user("Ali")
    content = bytes(range(256)) * 4
    attachment = upload(trio, ali, content, "a.bin").json()["attachment"]
    response = download(trio, attachment, headers={"Range": "bytes=10-19"})
    assert response.status_code == 206
    assert response.content == content[10:20]
    assert response.headers["content-range"] == f"bytes 10-19/{len(content)}"
    assert response.headers["content-security-policy"] == "sandbox; default-src 'none'"
    tail = download(trio, attachment, headers={"Range": "bytes=-5"})
    assert tail.status_code == 206 and tail.content == content[-5:]
    bad = download(trio, attachment, headers={"Range": f"bytes={len(content) + 10}-"})
    assert bad.status_code == 416


def test_download_head(trio):
    ali = trio.user("Ali")
    attachment = upload(trio, ali, PNG).json()["attachment"]
    response = trio.client.head(attachment["url"])
    assert response.status_code == 200
    assert int(response.headers["content-length"]) == len(PNG)


def test_download_unknown_ids_are_404(trio):
    ali = trio.user("Ali")
    attachment = upload(trio, ali, PNG).json()["attachment"]
    for path in (
        "/api/files/" + "A" * 43 + "/x.png",
        "/api/files/short/x.png",
        "/api/files/../trio-0.db/x",
        "/api/files/%2e%2e/x",
        f"/api/files/{attachment['id']}",  # no name segment
    ):
        response = trio.client.get(path)
        assert response.status_code == 404, path
        assert response.json()["error"]["code"] == "NOT_FOUND"
    # The name segment is only for the browser: another name still serves the bytes.
    assert trio.client.get(f"/api/files/{attachment['id']}/other.png").content == PNG


# -- message.send with attachments ----------------------------------------------


def expect(sock, frame_type):
    frame = sock.receive_json()
    assert frame["type"] == frame_type, frame
    return frame


def expect_error(sock, code):
    frame = expect(sock, "error")
    assert frame["code"] == code, frame


def test_message_with_attachments(trio):
    ali, berk = trio.user("Ali"), trio.user("Berk")
    first = upload(trio, ali, PNG, "a.png").json()["attachment"]
    second = upload(trio, ali, b"hello", "b.txt").json()["attachment"]
    with trio.ws(ali) as a, trio.ws(berk) as b:
        expect(a, "presence")
        a.send_json(
            {
                "type": "message.send",
                "channel_id": TEXT,
                "content": "bak",
                "nonce": "n",
                "attachment_ids": [second["id"], first["id"]],
            }
        )
        own = expect(a, "message.new")
        assert own["nonce"] == "n"
        assert own["message"]["attachments"] == [second, first]  # the order sent
        assert expect(b, "message.new")["message"] == own["message"]
    listed = trio.client.get(f"/api/channels/{TEXT}/messages", headers=berk["auth"]).json()
    assert listed["messages"] == [own["message"]]


def test_empty_content_is_allowed_only_with_attachments(trio):
    ali = trio.user("Ali")
    att = upload(trio, ali).json()["attachment"]
    with trio.ws(ali) as a:
        a.send_json({"type": "message.send", "channel_id": TEXT, "content": "   "})
        expect_error(a, "INVALID_MESSAGE")
        a.send_json({"type": "message.send", "channel_id": TEXT, "attachment_ids": []})
        expect_error(a, "INVALID_MESSAGE")
        a.send_json({"type": "message.send", "channel_id": TEXT, "attachment_ids": [att["id"]]})
        message = expect(a, "message.new")["message"]
        assert message["content"] == ""
        assert message["attachments"] == [att]


def test_someone_elses_upload_is_refused_and_nothing_is_stored(trio):
    ali, berk = trio.user("Ali"), trio.user("Berk")
    mine = upload(trio, ali).json()["attachment"]
    theirs = upload(trio, berk).json()["attachment"]
    with trio.ws(ali) as a:
        a.send_json(
            {
                "type": "message.send",
                "channel_id": TEXT,
                "content": "x",
                "attachment_ids": [mine["id"], theirs["id"]],
            }
        )
        expect_error(a, "INVALID_ATTACHMENT")
        quiet(a)
    assert trio.client.get(f"/api/channels/{TEXT}/messages", headers=ali["auth"]).json() == {
        "messages": [],
        "has_more": False,
    }
    # Neither was claimed: mine is still usable.
    with trio.ws(ali) as a:
        a.send_json(
            {
                "type": "message.send",
                "channel_id": TEXT,
                "content": "",
                "attachment_ids": [mine["id"]],
            }
        )
        assert expect(a, "message.new")["message"]["attachments"] == [mine]


def test_an_attachment_cannot_be_used_twice(trio):
    ali = trio.user("Ali")
    att = upload(trio, ali).json()["attachment"]
    with trio.ws(ali) as a:
        send = {"type": "message.send", "channel_id": TEXT, "attachment_ids": [att["id"]]}
        a.send_json(send)
        expect(a, "message.new")
        a.send_json(send)
        expect_error(a, "INVALID_ATTACHMENT")
        a.send_json({**send, "attachment_ids": [att["id"], att["id"]]})
        expect_error(a, "INVALID_ATTACHMENT")


def test_unknown_and_malformed_ids(trio):
    ali = trio.user("Ali")
    with trio.ws(ali) as a:
        base = {"type": "message.send", "channel_id": TEXT, "content": "x"}
        a.send_json({**base, "attachment_ids": ["B" * 43]})
        expect_error(a, "INVALID_ATTACHMENT")
        a.send_json({**base, "attachment_ids": ["../x"]})
        expect_error(a, "INVALID_ATTACHMENT")
        a.send_json({**base, "attachment_ids": "nope"})
        expect_error(a, "BAD_REQUEST")
        a.send_json({**base, "attachment_ids": [1]})
        expect_error(a, "BAD_REQUEST")


def test_at_most_ten_attachments(trio):
    ali = trio.user("Ali")
    ids = [upload(trio, ali, b"x", f"{i}.txt").json()["attachment"]["id"] for i in range(11)]
    with trio.ws(ali) as a:
        a.send_json({"type": "message.send", "channel_id": TEXT, "attachment_ids": ids})
        expect_error(a, "INVALID_ATTACHMENT")
        a.send_json({"type": "message.send", "channel_id": TEXT, "attachment_ids": ids[:10]})
        assert len(expect(a, "message.new")["message"]["attachments"]) == 10


# -- orphan sweep -------------------------------------------------------------


def test_orphans_are_swept_after_24_hours_on_the_next_upload(trio):
    ali = trio.user("Ali")
    orphan = upload(trio, ali, b"old", "old.txt").json()["attachment"]
    used = upload(trio, ali, b"used", "used.txt").json()["attachment"]
    with trio.ws(ali) as a:
        a.send_json({"type": "message.send", "channel_id": TEXT, "attachment_ids": [used["id"]]})
        expect(a, "message.new")

    trio.clock.value += 24 * 3600 - 1
    upload(trio, ali, b"new", "new.txt")
    assert download(trio, orphan).status_code == 200  # not yet

    trio.clock.value += 2
    # Past 24 hours an unswept orphan can no longer be attached either.
    with trio.ws(ali) as a:
        a.send_json({"type": "message.send", "channel_id": TEXT, "attachment_ids": [orphan["id"]]})
        expect_error(a, "INVALID_ATTACHMENT")
    fresh = upload(trio, ali, b"newer", "newer.txt").json()["attachment"]
    assert download(trio, orphan).status_code == 404
    assert not (upload_dir(trio) / orphan["id"]).exists()
    # Attached files are never swept.
    assert download(trio, used).status_code == 200
    assert orphan["id"] not in stored_files(trio)
    assert fresh["id"] in stored_files(trio)


def test_leftover_partial_files_are_removed_on_start(make_trio, tmp_path):
    uploads = tmp_path / "up"
    uploads.mkdir()
    (uploads / ("Z" * 43 + ".part")).write_bytes(b"half")
    make_trio(upload_dir=str(uploads))
    assert sorted(os.listdir(uploads)) == ["avatars", "icons", "previews"]


# -- a database created by v1 ------------------------------------------------------

V1_SCHEMA = """
CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
    name_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
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
"""


def test_a_v1_database_upgrades_on_boot(tmp_path):
    import hashlib

    path = tmp_path / "v1.db"
    con = sqlite3.connect(path)
    con.executescript(V1_SCHEMA)
    ts = "2026-01-01T00:00:00.000Z"
    con.execute("INSERT INTO users VALUES (1, 'Ali', 'ali', ?)", (ts,))
    token = "old-token"
    con.execute(
        "INSERT INTO tokens VALUES (?, 1, ?)", (hashlib.sha256(token.encode()).hexdigest(), ts)
    )
    con.execute("INSERT INTO channels VALUES (1, 'genel', 'text', ?)", (ts,))
    con.execute("INSERT INTO channels VALUES (2, 'Sohbet', 'voice', ?)", (ts,))
    con.execute("INSERT INTO messages VALUES (1, 1, 1, 'eski mesaj', ?)", (ts,))
    con.commit()
    con.close()

    settings = Settings(invite_code=INVITE, db_path=str(path), upload_dir=str(tmp_path / "uploads"))
    auth = {"Authorization": f"Bearer {token}"}
    with TestClient(create_app(settings)) as client:
        # The old message reads, now with an empty attachments list.
        listed = client.get("/api/channels/1/messages", headers=auth).json()
        assert listed["messages"][0]["content"] == "eski mesaj"
        assert listed["messages"][0]["attachments"] == []
        # Attachments work end to end.
        att = client.post("/api/uploads", files={"file": ("a.png", PNG)}, headers=auth).json()[
            "attachment"
        ]
        with client.websocket_connect(f"/ws?token={token}") as sock:
            assert sock.receive_json()["type"] == "ready"
            sock.send_json({"type": "message.send", "channel_id": 1, "attachment_ids": [att["id"]]})
            assert sock.receive_json()["message"]["attachments"] == [att]
        assert client.get(att["url"]).content == PNG
    # Not seeded twice, schema present, boots again.
    with TestClient(create_app(settings)) as client:
        assert len(client.get("/api/channels", headers=auth).json()["channels"]) == 2
    con = sqlite3.connect(path)
    tables = {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert "attachments" in tables
    con.close()
