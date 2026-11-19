"""CONTRACT-V6-MEDIA on the server: previews, dimensions, voice messages,
audio-only sniffing, the channel's media/files/links lists, links kept in step
with edits and deletes, the backfill of an older database, and the nonce on
`message.send` errors."""

from __future__ import annotations

import hashlib
import json
import sqlite3
import struct
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from trio_server import Settings, create_app
from trio_server.db import StorageFullError
from trio_server.links import extract_links, is_url, links_to_store, trim_trailing
from trio_server.media import audio_only, image_dimensions, parse_voice
from trio_server.uploads import sniff_content_type

from .conftest import INVITE, quiet
from .imagegen import WEBP_LOSSLESS_4X4, jpeg, png

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = Path(__file__).resolve().parent / "fixtures"
WAVE = ",".join(str(i * 4) for i in range(64))


def text_channel(trio) -> int:
    return trio.channel_id("text")


def upload(trio, user, content: bytes, filename: str, **parts):
    files = {"file": (filename, content, "application/octet-stream")}
    for name, value in parts.items():
        files[name] = (
            (name, value, "application/octet-stream")
            if isinstance(value, bytes)
            else (
                None,
                value,
            )
        )
    return trio.client.post("/api/uploads", files=files, headers=user["auth"])


def send(sock, channel_id: int, content: str, *, nonce: str | None = None, ids=()):
    frame = {"type": "message.send", "channel_id": channel_id, "content": content}
    if nonce is not None:
        frame["nonce"] = nonce
    if ids:
        frame["attachment_ids"] = list(ids)
    sock.send_json(frame)
    return sock.receive_json()


def uploads_of(trio) -> Path:
    return Path(trio.client.app.state.settings.upload_dir)


# -- one URL rule for client and server -------------------------------------------


def test_the_shared_fixture_finds_exactly_the_links_the_client_finds():
    cases = json.loads((ROOT / "shared" / "linkify-cases.json").read_text("utf-8"))["cases"]
    assert len(cases) >= 20
    for case in cases:
        assert extract_links(case["text"]) == case["links"], case["text"]


def test_url_rule_details():
    assert trim_trailing("https://a.com/x).") == "https://a.com/x"
    assert trim_trailing("https://a.com/(x)") == "https://a.com/(x)"
    assert is_url("https://a.com:0/") and not is_url("https://a.com:99999/")
    assert not is_url("http://1.2.3.4.5/") and is_url("http://1.2.3.4/")
    assert not is_url("http://[::1")
    # A long message keeps at most 50 links, each at most 2048 characters.
    text = " ".join(f"https://a.com/{i}" for i in range(80)) + " https://b.com/" + "x" * 3000
    assert len(links_to_store(text)) == 50


# -- previews and dimensions -------------------------------------------------------


def test_an_image_with_a_preview_carries_both_and_the_preview_counts_in_the_quota(trio):
    ayse = trio.user("Ayşe")
    original = png(1200, 800)
    preview = png(480, 320)
    response = upload(trio, ayse, original, "manzara.png", preview=preview)
    assert response.status_code == 201, response.text
    att = response.json()["attachment"]
    assert att["width"] == 1200 and att["height"] == 800
    assert att["preview_url"] == f"/api/previews/{att['id']}"
    assert att["voice"] is None
    assert att["size"] == len(original)
    served = trio.client.get(att["preview_url"])
    assert served.status_code == 200 and served.content == preview
    assert served.headers["content-type"] == "image/png"
    assert served.headers["content-security-policy"].startswith("sandbox")
    assert served.headers["x-content-type-options"] == "nosniff"
    db = trio.client.app.state.db
    assert trio.client.portal.call(db.stored_bytes, ayse["id"]) == len(original) + len(preview)
    # Not a second attachment: one row.
    assert len(trio.client.portal.call(db.all_attachment_ids)) == 1


def test_dimensions_without_a_preview_and_unknown_for_other_types(trio):
    ayse = trio.user("Ayşe")
    att = upload(trio, ayse, jpeg(64, 40), "a.jpg").json()["attachment"]
    assert (att["width"], att["height"], att["preview_url"]) == (64, 40, None)
    att = upload(trio, ayse, WEBP_LOSSLESS_4X4, "a.webp").json()["attachment"]
    assert (att["width"], att["height"]) == (4, 4)
    att = upload(trio, ayse, b"merhaba", "a.txt").json()["attachment"]
    assert (att["width"], att["height"]) == (None, None)


def _exif(orientation: int) -> bytes:
    """An APP1 Exif segment with IFD0 Orientation and a GPS pointer."""
    entries = struct.pack("<HHII", 0x0112, 3, 1, orientation) + struct.pack(
        "<HHII", 0x8825, 4, 1, 38
    )
    ifd = struct.pack("<H", 2) + entries + b"\x00\x00\x00\x00"
    tiff = b"II*\x00" + struct.pack("<I", 8) + ifd + b"\x00" * 16
    body = b"Exif\x00\x00" + tiff
    return b"\xff\xe1" + struct.pack(">H", len(body) + 2) + body


@pytest.mark.parametrize(("orientation", "shown"), [(1, (64, 40)), (6, (40, 64)), (8, (40, 64))])
def test_a_jpeg_reports_the_size_its_exif_orientation_shows(tmp_path, orientation, shown):
    plain = jpeg(64, 40)
    rotated = plain[:2] + _exif(orientation) + plain[2:]
    path = tmp_path / "x"
    path.write_bytes(rotated)
    assert image_dimensions(path, "image/jpeg") == shown
    path.write_bytes(b"\xff\xd8\xff\xe0\x00")
    assert image_dimensions(path, "image/jpeg") is None


@pytest.mark.parametrize(
    "preview",
    [
        b"not an image",
        png(641, 10),  # too wide
        b"\x89PNG\r\n\x1a\n" + b"\x00" * 300_000,  # too large
        b"GIF89a" + b"\x00" * 40,  # not PNG/JPEG/WebP
    ],
)
def test_a_bad_preview_refuses_the_upload_and_leaves_nothing(trio, preview):
    ayse = trio.user("Ayşe")
    response = upload(trio, ayse, png(900, 900), "a.png", preview=preview)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "INVALID_PREVIEW"
    assert [p.name for p in uploads_of(trio).iterdir() if p.is_file()] == []
    assert list((uploads_of(trio) / "previews").iterdir()) == []


def test_a_preview_is_only_taken_for_an_image(trio):
    ayse = trio.user("Ayşe")
    response = upload(trio, ayse, b"%PDF-1.4\n", "a.pdf", preview=png(10, 10))
    assert response.json()["error"]["code"] == "INVALID_PREVIEW"


def test_the_preview_goes_with_its_message_and_with_an_orphan(trio):
    ayse = trio.user("Ayşe")
    channel = text_channel(trio)
    att = upload(trio, ayse, png(1200, 800), "a.png", preview=png(48, 32)).json()["attachment"]
    orphan = upload(trio, ayse, png(1200, 800), "b.png", preview=png(48, 32)).json()["attachment"]
    with trio.ws(ayse) as sock:
        message = send(sock, channel, "", ids=[att["id"]])["message"]
    assert message["attachments"][0]["preview_url"] == att["preview_url"]
    previews = uploads_of(trio) / "previews"
    assert sorted(p.name for p in previews.iterdir()) == sorted([att["id"], orphan["id"]])
    assert (
        trio.client.delete(f"/api/messages/{message['id']}", headers=ayse["auth"]).status_code
        == 204
    )
    assert trio.client.get(att["preview_url"]).status_code == 404
    assert [p.name for p in previews.iterdir()] == [orphan["id"]]
    trio.clock.value += 24 * 3600 + 1
    trio.client.portal.call(trio.client.app.state.sweep_orphans)
    assert list(previews.iterdir()) == []
    db = trio.client.app.state.db
    assert trio.client.portal.call(db.stored_bytes, ayse["id"]) == 0


def noisy_png(width: int, height: int) -> bytes:
    """A PNG that does not compress: random pixels, stored uncompressed."""
    import os
    import zlib

    from .imagegen import png_chunk

    rows = b"".join(b"\x00" + os.urandom(3 * width) for _ in range(height))
    return (
        b"\x89PNG\r\n\x1a\n"
        + png_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + png_chunk(b"IDAT", zlib.compress(rows, 0))
        + png_chunk(b"IEND", b"")
    )


def test_a_preview_that_does_not_fit_the_quota_is_refused(make_trio):
    trio = make_trio(user_quota_mb=1)
    ayse = trio.user("Ayşe")
    first = upload(trio, ayse, b"x" * (1024 * 1024 - 20_000), "a.bin")
    assert first.status_code == 201
    preview = noisy_png(120, 80)
    assert len(preview) > 20_000
    response = upload(trio, ayse, png(1, 1), "a.png", preview=preview)
    assert response.status_code == 413
    assert response.json()["error"]["code"] == "QUOTA_EXCEEDED"
    assert list((uploads_of(trio) / "previews").iterdir()) == []
    # Without the preview it fits.
    assert upload(trio, ayse, png(1, 1), "a.png").status_code == 201


# -- voice messages ----------------------------------------------------------------


# A Matroska header the way MediaRecorder writes it: EBML, Segment, Tracks with
# one TrackEntry whose CodecID is A_OPUS (or V_VP8 + A_OPUS for a video).
def _webm(*codecs: bytes) -> bytes:
    tracks = b"".join(b"\xae\x8a\x86" + bytes([0x80 | len(c)]) + c for c in codecs)
    return (
        b"\x1a\x45\xdf\xa3\x9f\x42\x86\x81\x01\x42\x82\x84webm\x42\x87\x81\x04"
        + b"\x18\x53\x80\x67\x01\xff\xff\xff\xff\xff\xff\xff"
        + b"\x15\x49\xa9\x66\x88"
        + b"\x00" * 8
        + b"\x16\x54\xae\x6b"
        + bytes([0x80 | len(tracks)])
        + tracks
        + b"\x00" * 200
    )


def _mp4(*handlers: bytes) -> bytes:
    def box(kind: bytes, body: bytes) -> bytes:
        return struct.pack(">I", 8 + len(body)) + kind + body

    traks = b"".join(
        box(b"trak", box(b"mdia", box(b"hdlr", b"\x00" * 8 + h + b"\x00" * 13))) for h in handlers
    )
    return box(b"ftyp", b"iso5\x00\x00\x02\x00iso5iso6mp41") + box(b"moov", traks) + b"\x00" * 64


def test_audio_only_recordings_are_audio_and_videos_stay_video():
    assert sniff_content_type(_webm(b"A_OPUS"), "ses.webm") == "audio/webm"
    assert sniff_content_type(_webm(b"V_VP8", b"A_OPUS"), "v.webm") == "video/webm"
    assert sniff_content_type(_webm(b"V_VP9"), "v.webm") == "video/webm"
    assert sniff_content_type(_mp4(b"soun"), "ses.mp4") == "audio/mp4"
    assert sniff_content_type(_mp4(b"vide", b"soun"), "v.mp4") == "video/mp4"
    # The track list not in reach (an index at the end): the brand decides, as before.
    assert sniff_content_type(_mp4()[:40], "v.mp4") == "video/mp4"
    assert audio_only(b"", "image/png") == "image/png"


def test_a_real_chromium_recording_is_audio(trio):
    recorded = FIXTURES / "voice-chromium.webm"
    data = recorded.read_bytes()
    assert sniff_content_type(data[:4096], "kayit.webm") == "audio/webm"
    ayse = trio.user("Ayşe")
    response = upload(
        trio, ayse, data, "sesli-mesaj.webm", voice_duration_ms="2400", voice_waveform=WAVE
    )
    assert response.status_code == 201, response.text
    att = response.json()["attachment"]
    assert att["content_type"] == "audio/webm"
    assert att["voice"] == {"duration_ms": 2400, "waveform": [i * 4 for i in range(64)]}
    served = trio.client.get(att["url"])
    assert served.headers["content-disposition"].startswith("inline")


@pytest.mark.parametrize(
    ("duration", "waveform"),
    [
        ("0", WAVE),
        ("130001", WAVE),
        ("12.5", WAVE),
        ("2400", ",".join(["1"] * 63)),
        ("2400", ",".join(["256"] * 64)),
        ("2400", ",".join(["-1"] * 64)),
        ("2400", None),
        (None, WAVE),
    ],
)
def test_bad_voice_fields_are_refused(trio, duration, waveform):
    ayse = trio.user("Ayşe")
    parts = {}
    if duration is not None:
        parts["voice_duration_ms"] = duration
    if waveform is not None:
        parts["voice_waveform"] = waveform
    response = upload(trio, ayse, _webm(b"A_OPUS"), "ses.webm", **parts)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "INVALID_VOICE"


def test_a_voice_marker_needs_an_audio_file_and_is_size_bounded(trio):
    ayse = trio.user("Ayşe")
    response = upload(trio, ayse, png(10, 10), "a.png", voice_duration_ms="10", voice_waveform=WAVE)
    assert response.json()["error"]["code"] == "INVALID_VOICE"
    response = upload(
        trio, ayse, _webm(b"A_OPUS"), "s.webm", voice_duration_ms="1", voice_waveform="0" * 5000
    )
    assert response.status_code == 422 and response.json()["error"]["code"] == "INVALID_VOICE"
    assert parse_voice(None, None, "audio/webm") is None


# -- the channel's lists ------------------------------------------------------------


def test_media_and_files_lists_page_newest_first_and_skip_voice(trio):
    ayse, mehmet = trio.user("Ayşe"), trio.user("Mehmet")
    channel = text_channel(trio)
    ids = []
    with trio.ws(ayse) as sock:
        for i in range(5):
            image = upload(trio, ayse, png(20 + i, 10), f"r{i}.png").json()["attachment"]
            note = upload(trio, ayse, b"not", f"n{i}.txt").json()["attachment"]
            msg = send(sock, channel, f"m{i}", ids=[image["id"], note["id"]])["message"]
            ids.append((msg["id"], image["id"], note["id"]))
        voice = upload(
            trio, ayse, _webm(b"A_OPUS"), "v.webm", voice_duration_ms="900", voice_waveform=WAVE
        ).json()["attachment"]
        send(sock, channel, "", ids=[voice["id"]])
    page = trio.client.get(
        f"/api/channels/{channel}/attachments?kind=media&limit=2", headers=mehmet["auth"]
    ).json()
    assert [i["attachment"]["id"] for i in page["items"]] == [ids[4][1], ids[3][1]]
    first = page["items"][0]
    assert first["message_id"] == ids[4][0] and first["author"]["name"] == "Ayşe"
    assert first["created_at"].endswith("Z")
    assert page["has_more"] is True
    seen = [i["attachment"]["id"] for i in page["items"]]
    while page["has_more"]:
        page = trio.client.get(
            f"/api/channels/{channel}/attachments?kind=media&limit=2&before={page['next_before']}",
            headers=mehmet["auth"],
        ).json()
        seen += [i["attachment"]["id"] for i in page["items"]]
    assert seen == [i[1] for i in reversed(ids)]
    assert page["next_before"] is None
    files = trio.client.get(
        f"/api/channels/{channel}/attachments?kind=file", headers=mehmet["auth"]
    ).json()
    assert [i["attachment"]["id"] for i in files["items"]] == [i[2] for i in reversed(ids)]


def test_several_attachments_of_one_message_page_in_their_own_order(trio):
    ayse = trio.user("Ayşe")
    channel = text_channel(trio)
    images = [
        upload(trio, ayse, png(10, 10), f"{i}.png").json()["attachment"]["id"] for i in range(3)
    ]
    with trio.ws(ayse) as sock:
        send(sock, channel, "üç", ids=images)
    url = f"/api/channels/{channel}/attachments?kind=media&limit=1"
    got = []
    page = trio.client.get(url, headers=ayse["auth"]).json()
    got += [i["attachment"]["id"] for i in page["items"]]
    while page["has_more"]:
        page = trio.client.get(url + f"&before={page['next_before']}", headers=ayse["auth"]).json()
        got += [i["attachment"]["id"] for i in page["items"]]
    assert got == images


def test_the_lists_need_a_token_a_text_channel_and_a_real_cursor(trio):
    ayse = trio.user("Ayşe")
    channel = text_channel(trio)
    voice = trio.channel_id("voice")
    for path in (f"/api/channels/{channel}/attachments", f"/api/channels/{channel}/links"):
        assert trio.client.get(path).status_code == 401
        assert trio.client.get(path + "?before=abc", headers=ayse["auth"]).status_code == 422
        too_big = f"?before={2**63}-0"
        assert trio.client.get(path + too_big, headers=ayse["auth"]).status_code == 422
        assert trio.client.get(path + "?limit=101", headers=ayse["auth"]).status_code == 422
    assert trio.client.get(f"/api/channels/{voice}/links", headers=ayse["auth"]).status_code == 404
    assert trio.client.get("/api/channels/999/attachments", headers=ayse["auth"]).status_code == 404
    bad = trio.client.get(f"/api/channels/{channel}/attachments?kind=x", headers=ayse["auth"])
    assert bad.status_code == 422
    assert trio.client.get(f"/api/previews/{'A' * 43}").status_code == 404
    assert trio.client.get("/api/previews/../trio.db").status_code == 404


def links(trio, user, channel, **query) -> list:
    q = "&".join(f"{k}={v}" for k, v in query.items())
    return trio.client.get(f"/api/channels/{channel}/links?{q}", headers=user["auth"]).json()


def test_links_follow_sends_edits_and_deletes(trio):
    ayse, mehmet = trio.user("Ayşe"), trio.user("Mehmet")
    channel = text_channel(trio)
    with trio.ws(ayse) as sock:
        a = send(sock, channel, "bak https://a.com/x, ve https://b.com/(y)")["message"]
        b = send(sock, channel, "linksiz")["message"]
        c = send(sock, channel, "tek https://c.com")["message"]
    page = links(trio, mehmet, channel)
    assert [(i["url"], i["message_id"]) for i in page["items"]] == [
        ("https://c.com", c["id"]),
        ("https://a.com/x", a["id"]),
        ("https://b.com/(y)", a["id"]),
    ]
    assert page["items"][1]["excerpt"] == "bak https://a.com/x, ve https://b.com/(y)"
    assert page["items"][1]["author"]["name"] == "Ayşe"
    edit = trio.client.patch(
        f"/api/messages/{b['id']}", json={"content": "şimdi https://d.com/z."}, headers=ayse["auth"]
    )
    assert edit.status_code == 200
    trio.client.patch(
        f"/api/messages/{a['id']}", json={"content": "artık yok"}, headers=ayse["auth"]
    )
    trio.client.delete(f"/api/messages/{c['id']}", headers=ayse["auth"])
    assert [i["url"] for i in links(trio, mehmet, channel)["items"]] == ["https://d.com/z"]
    # Paging through links.
    with trio.ws(ayse) as sock:
        for i in range(5):
            send(sock, channel, f"https://p.com/{i} https://q.com/{i}")
    page = links(trio, mehmet, channel, limit=3)
    seen = [i["url"] for i in page["items"]]
    while page["has_more"]:
        page = links(trio, mehmet, channel, limit=3, before=page["next_before"])
        seen += [i["url"] for i in page["items"]]
    expected = [u for i in reversed(range(5)) for u in (f"https://p.com/{i}", f"https://q.com/{i}")]
    assert seen == [*expected, "https://d.com/z"]


# -- the database of a v5 server -----------------------------------------------------

V5_EXTRA = """
ALTER TABLE users ADD COLUMN avatar TEXT;
ALTER TABLE messages ADD COLUMN edited_at TEXT;
ALTER TABLE messages ADD COLUMN reply_to_id INTEGER;
ALTER TABLE messages ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;
CREATE TABLE reactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    key TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id),
    UNIQUE (message_id, key, user_id));
CREATE TABLE pins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
    channel_id INTEGER NOT NULL, pinned_by INTEGER NOT NULL REFERENCES users(id),
    pinned_at TEXT NOT NULL);
CREATE TABLE server_profile (id INTEGER PRIMARY KEY CHECK (id = 1), name TEXT NOT NULL, icon TEXT);
INSERT INTO server_profile (id, name) VALUES (1, 'Trio');
"""


def build_v5(tmp_path, messages: int) -> tuple[Path, Path]:
    from .test_v4_upgrade import TS, V3_SCHEMA

    path = tmp_path / "v5.db"
    uploads = tmp_path / "uploads"
    uploads.mkdir()
    con = sqlite3.connect(path)
    con.executescript(V3_SCHEMA + V5_EXTRA)
    con.execute("INSERT INTO users VALUES (1, 'Ali', 'ali', ?, NULL, NULL)", (TS,))
    con.execute("INSERT INTO tokens VALUES (?, 1, ?)", (hashlib.sha256(b"tok-ali").hexdigest(), TS))
    con.execute("INSERT INTO channels VALUES (1, 'genel', 'text', ?)", (TS,))
    con.execute("INSERT INTO channels VALUES (2, 'Sohbet', 'voice', ?)", (TS,))
    for i in range(1, messages + 1):
        content = f"mesaj {i} https://eski.com/{i}" if i % 3 == 0 else f"mesaj {i}"
        con.execute(
            "INSERT INTO messages (id, channel_id, author_id, content, created_at) "
            "VALUES (?, 1, 1, ?, ?)",
            (i, content, TS),
        )
    con.execute(
        "INSERT INTO attachments VALUES (?, 1, 1, 0, 'eski.png', 'image/png', 4, ?, 1)",
        ("B" * 43, TS),
    )
    con.commit()
    con.close()
    (uploads / ("B" * 43)).write_bytes(b"\x89PNG")
    return path, uploads


def test_a_v5_database_upgrades_and_its_links_are_backfilled_once(tmp_path):
    path, uploads = build_v5(tmp_path, 1234)
    settings = Settings(invite_code=INVITE, db_path=str(path), upload_dir=str(uploads))
    ali = {"Authorization": "Bearer tok-ali"}
    with TestClient(create_app(settings)) as client:
        got = []
        page = client.get("/api/channels/1/links?limit=100", headers=ali).json()
        got += page["items"]
        while page["has_more"]:
            page = client.get(
                f"/api/channels/1/links?limit=100&before={page['next_before']}", headers=ali
            ).json()
            got += page["items"]
        assert len(got) == 1234 // 3
        assert got[0]["url"] == "https://eski.com/1233"
        # The old attachment reads with null v6 fields.
        att = client.get("/api/channels/1/attachments", headers=ali).json()["items"][0]
        assert att["attachment"]["preview_url"] is None and att["attachment"]["width"] is None
        assert att["attachment"]["voice"] is None
    con = sqlite3.connect(path)
    assert con.execute("SELECT done_through FROM links_backfill").fetchone() == (1234,)
    assert con.execute("SELECT count(*) FROM links").fetchone() == (411,)
    con.close()
    # Starting again neither duplicates nor loses a link.
    with TestClient(create_app(settings)) as client:
        pass
    con = sqlite3.connect(path)
    assert con.execute("SELECT count(*) FROM links").fetchone() == (411,)
    con.close()


def test_an_interrupted_backfill_continues(tmp_path):
    path, uploads = build_v5(tmp_path, 30)
    settings = Settings(invite_code=INVITE, db_path=str(path), upload_dir=str(uploads))
    with TestClient(create_app(settings)):
        pass
    con = sqlite3.connect(path)
    # As if the first start had stopped after message 10 with stale rows written.
    con.execute("UPDATE links_backfill SET done_through = 10")
    con.execute("DELETE FROM links WHERE message_id > 20")
    con.execute("INSERT INTO links (message_id, channel_id, position, url) VALUES (12, 1, 0, 'x')")
    con.commit()
    con.close()
    with TestClient(create_app(settings)):
        pass
    con = sqlite3.connect(path)
    urls = [r[0] for r in con.execute("SELECT url FROM links ORDER BY message_id")]
    con.close()
    assert urls == [f"https://eski.com/{i}" for i in range(3, 31, 3)]


# -- the nonce on errors answering message.send ---------------------------------------


def errors_for(trio, frames: list[dict]) -> list[dict]:
    ayse = trio.user("Ayşe")
    out = []
    with trio.ws(ayse) as sock:
        for frame in frames:
            sock.send_json({"type": "message.send", **frame})
            out.append(sock.receive_json())
        quiet(sock)
    return out


def test_every_message_send_error_names_its_nonce(trio, monkeypatch):
    channel = text_channel(trio)
    voice = trio.channel_id("voice")
    frames = [
        {"channel_id": voice, "content": "x", "nonce": "n1"},  # INVALID_CHANNEL
        {"channel_id": channel, "content": "", "nonce": "n2"},  # INVALID_MESSAGE
        {"channel_id": channel, "content": "x", "nonce": "n3", "reply_to": "a"},  # BAD_REQUEST
        {"channel_id": channel, "content": "x", "nonce": "n4", "reply_to": 999},  # INVALID_REPLY
        {"channel_id": channel, "content": "x", "nonce": "n5", "attachment_ids": ["A" * 43]},
        {"channel_id": channel, "content": "x", "nonce": "n6", "attachment_ids": "x"},
        {"channel_id": channel, "content": "x" * 4001, "nonce": "n7"},
    ]
    got = errors_for(trio, frames)
    assert [(e["type"], e["code"], e.get("nonce")) for e in got] == [
        ("error", "INVALID_CHANNEL", "n1"),
        ("error", "INVALID_MESSAGE", "n2"),
        ("error", "BAD_REQUEST", "n3"),
        ("error", "INVALID_REPLY", "n4"),
        ("error", "INVALID_ATTACHMENT", "n5"),
        ("error", "BAD_REQUEST", "n6"),
        ("error", "INVALID_MESSAGE", "n7"),
    ]


def test_storage_full_and_internal_errors_name_the_nonce_and_a_bad_nonce_none(trio, monkeypatch):
    channel = text_channel(trio)
    db = trio.client.app.state.db

    async def full(*args, **kwargs):
        raise StorageFullError

    monkeypatch.setattr(db, "create_message", full)
    ayse = trio.user("Ayşe")
    with trio.ws(ayse) as sock:
        sock.send_json(
            {"type": "message.send", "channel_id": channel, "content": "x", "nonce": "a"}
        )
        assert sock.receive_json() | {"message": ""} == {
            "type": "error",
            "code": "STORAGE_FULL",
            "message": "",
            "nonce": "a",
        }

        async def broken(*args, **kwargs):
            raise RuntimeError("boom")

        monkeypatch.setattr(db, "create_message", broken)
        sock.send_json(
            {"type": "message.send", "channel_id": channel, "content": "x", "nonce": "b"}
        )
        frame = sock.receive_json()
        assert (frame["code"], frame["nonce"]) == ("INTERNAL", "b")
        sock.send_json({"type": "message.send", "channel_id": channel, "content": "x"})
        assert "nonce" not in sock.receive_json()
        sock.send_json({"type": "message.send", "channel_id": channel, "nonce": "z" * 129})
        frame = sock.receive_json()
        assert frame["code"] == "BAD_REQUEST" and "nonce" not in frame
        sock.send_json({"type": "message.send", "channel_id": channel, "content": "x", "nonce": 5})
        assert "nonce" not in sock.receive_json()
        quiet(sock)


def test_a_replayed_nonce_is_still_answered_with_the_message(trio):
    channel = text_channel(trio)
    ayse = trio.user("Ayşe")
    with trio.ws(ayse) as sock:
        first = send(sock, channel, "bir", nonce="r1")
        again = send(sock, channel, "", nonce="r1")  # would be INVALID_MESSAGE if read
        assert again["type"] == "message.new" and again["message"]["id"] == first["message"]["id"]


def test_real_chromium_recordings_of_each_kind():
    """Recorded by Chromium 1243's MediaRecorder (fake microphone and camera)."""
    video = (FIXTURES / "video-chromium.webm").read_bytes()
    assert sniff_content_type(video[:4096], "v.webm") == "video/webm"
    mp4 = (FIXTURES / "voice-chromium.mp4").read_bytes()  # audio/mp4;codecs=opus
    assert sniff_content_type(mp4[:4096], "kayit.mp4") == "audio/mp4"


# -- with CONTRACT-V6-OPS §4: a file its uploader deleted -------------------------------


def test_a_deleted_file_leaves_the_lists_and_takes_its_preview_with_it(trio):
    ayse, mehmet = trio.user("Ayşe"), trio.user("Mehmet")
    channel = text_channel(trio)
    photo = upload(trio, ayse, png(1200, 800), "a.png", preview=png(48, 32)).json()["attachment"]
    kept = upload(trio, ayse, png(30, 20), "b.png").json()["attachment"]
    note = upload(trio, ayse, b"not", "n.txt").json()["attachment"]
    with trio.ws(ayse) as sock:
        send(sock, channel, "üçü", ids=[photo["id"], kept["id"], note["id"]])
    db = trio.client.app.state.db
    before = trio.client.portal.call(db.stored_bytes, ayse["id"])
    for att in (photo, note):
        response = trio.client.delete(f"/api/attachments/{att['id']}", headers=ayse["auth"])
        assert response.status_code == 200, response.text
    media = trio.client.get(f"/api/channels/{channel}/attachments", headers=mehmet["auth"]).json()
    assert [i["attachment"]["id"] for i in media["items"]] == [kept["id"]]
    files = trio.client.get(
        f"/api/channels/{channel}/attachments?kind=file", headers=mehmet["auth"]
    ).json()
    assert files["items"] == []
    assert trio.client.get(photo["preview_url"]).status_code == 404
    assert list((uploads_of(trio) / "previews").iterdir()) == []
    after = trio.client.portal.call(db.stored_bytes, ayse["id"])
    assert after == before - photo["size"] - len(png(48, 32)) - note["size"]
    storage = trio.client.get("/api/me/storage", headers=ayse["auth"]).json()
    assert storage["used_bytes"] == after
    # The message keeps the tombstones, with no v6 fields to show.
    message = trio.client.get(f"/api/channels/{channel}/messages", headers=mehmet["auth"]).json()
    assert message["messages"][-1]["attachments"][0] == {
        "id": photo["id"],
        "filename": "a.png",
        "deleted": True,
    }


def test_a_preview_left_by_a_crash_after_a_delete_is_swept_at_start(tmp_path):
    settings = Settings(
        invite_code=INVITE, db_path=str(tmp_path / "t.db"), upload_dir=str(tmp_path / "u")
    )
    with TestClient(create_app(settings)) as client:
        token = client.post(
            "/api/join",
            json={"invite_code": INVITE, "name": "Ali"},
            headers={"X-Forwarded-For": "198.51.100.9"},
        ).json()["token"]
        auth = {"Authorization": f"Bearer {token}"}
        att = client.post(
            "/api/uploads",
            files={"file": ("a.png", png(1200, 800)), "preview": ("p.png", png(48, 32))},
            headers=auth,
        ).json()["attachment"]
        with client.websocket_connect(f"/ws?token={token}") as sock:
            sock.receive_json()
            sock.send_json(
                {
                    "type": "message.send",
                    "channel_id": 1,
                    "content": "",
                    "attachment_ids": [att["id"]],
                }
            )
            sock.receive_json()
    con = sqlite3.connect(tmp_path / "t.db")
    con.execute("UPDATE attachments SET deleted_at = '2026-11-19T00:00:00.000Z'")
    con.commit()
    con.close()
    preview = tmp_path / "u" / "previews" / att["id"]
    assert preview.is_file()
    with TestClient(create_app(settings)):
        pass
    assert not preview.exists()
