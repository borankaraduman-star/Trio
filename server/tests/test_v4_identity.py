"""CONTRACT-V4 C: avatars, renames, the server's name and icon."""

from __future__ import annotations

import os
import struct
import zlib
from pathlib import Path

import pytest

from trio_server.images import inspect_image
from trio_server.profile_routes import IMAGE_MAX_BYTES, PROFILE_LIMIT

from .imagegen import WEBP_ALPHA_5X3, WEBP_LOSSLESS_4X4, WEBP_LOSSY_16X16, jpeg, png, png_chunk
from .test_ws import expect

TEXT = 1


def code(response) -> str:
    return response.json()["error"]["code"]


def put_image(trio, user, data: bytes, url="/api/me/avatar", name="a.png", mime="image/png"):
    return trio.client.put(url, files={"file": (name, data, mime)}, headers=user["auth"])


def avatars(trio) -> list[str]:
    return sorted(os.listdir(Path(trio.client.app.state.settings.upload_dir) / "avatars"))


def icons(trio) -> list[str]:
    return sorted(os.listdir(Path(trio.client.app.state.settings.upload_dir) / "icons"))


# -- the image check --------------------------------------------------------------------


@pytest.mark.parametrize(
    ("data", "kind", "size"),
    [
        (png(1, 1), "image/png", (1, 1)),
        (png(256, 256), "image/png", (256, 256)),
        (png(512, 3), "image/png", (512, 3)),
        (jpeg(1, 1), "image/jpeg", (1, 1)),
        (jpeg(256, 256), "image/jpeg", (256, 256)),
        (jpeg(13, 9), "image/jpeg", (13, 9)),
        (WEBP_LOSSLESS_4X4, "image/webp", (4, 4)),
        (WEBP_LOSSY_16X16, "image/webp", (16, 16)),
        (WEBP_ALPHA_5X3, "image/webp", (5, 3)),
    ],
)
def test_real_images_are_recognised(data, kind, size):
    info = inspect_image(data)
    assert info is not None and info.content_type == kind and (info.width, info.height) == size


def _bad_crc(data: bytes) -> bytes:
    return data[:29] + bytes([data[29] ^ 1]) + data[30:]


BROKEN = {
    "empty": b"",
    "text": b"hello",
    "html named png": b"<html><script>alert(1)</script></html>",
    "gif": b"GIF89a\x01\x00\x01\x00\x00\x00\x00;",
    "svg": b'<svg xmlns="http://www.w3.org/2000/svg"/>',
    "png signature only": b"\x89PNG\r\n\x1a\n",
    "png bad ihdr crc": _bad_crc(png(4, 4)),
    "png truncated": png(4, 4)[:-6],
    "png trailing bytes": png(4, 4) + b"<script>",
    "png no idat": b"\x89PNG\r\n\x1a\n"
    + png_chunk(b"IHDR", struct.pack(">IIBBBBB", 4, 4, 8, 2, 0, 0, 0))
    + png_chunk(b"IEND", b""),
    "png zero width": png(4, 4, ihdr_size=(0, 4)),
    "png bad depth": b"\x89PNG\r\n\x1a\n"
    + png_chunk(b"IHDR", struct.pack(">IIBBBBB", 4, 4, 7, 2, 0, 0, 0))
    + png_chunk(b"IDAT", zlib.compress(b"\x00" * 13))
    + png_chunk(b"IEND", b""),
    "png huge length": b"\x89PNG\r\n\x1a\n" + b"\xff\xff\xff\xffIHDR" + b"\x00" * 20,
    "jpeg soi only": b"\xff\xd8",
    "jpeg no frame": b"\xff\xd8\xff\xda\x00\x08\x01\x01\x00\x00\x3f\x00\x00\xff\xd9",
    "jpeg no eoi": jpeg(8, 8)[:-2],
    "jpeg segment past end": b"\xff\xd8\xff\xe0\xff\xff" + b"\x00" * 10,
    "jpeg eoi first": b"\xff\xd8\xff\xd9",
    "jpeg garbage marker": b"\xff\xd8\x00\x00\x00",
    "webp bad riff size": WEBP_LOSSLESS_4X4[:4] + b"\x00\x10\x00\x00" + WEBP_LOSSLESS_4X4[8:],
    "webp truncated": WEBP_LOSSY_16X16[:30],
    "webp unknown first chunk": b"RIFF\x0c\x00\x00\x00WEBPJUNK\x00\x00\x00\x00",
    "webp no image": b"RIFF\x0c\x00\x00\x00WEBP" + b"VP8L\x00\x00\x00\x00",
    "webp animated": b"RIFF\x16\x00\x00\x00WEBPVP8X\x0a\x00\x00\x00\x02\x00\x00\x00"
    + b"\x03\x00\x00\x03\x00\x00",
}


@pytest.mark.parametrize("name", sorted(BROKEN))
def test_broken_or_foreign_files_are_not_images(name):
    assert inspect_image(BROKEN[name]) is None


def test_a_webp_whose_canvas_disagrees_with_its_frame_is_refused():
    lying = bytearray(WEBP_ALPHA_5X3)
    lying[24] = 0x09  # canvas width 10, the frame inside is 5
    assert inspect_image(bytes(lying)) is None


# -- avatars ----------------------------------------------------------------------------


def test_upload_replace_and_delete_an_avatar(trio):
    ali, berk = trio.user("Ali"), trio.user("Berk")
    with trio.ws(ali) as a, trio.ws(berk) as b:
        expect(a, "presence")
        first = jpeg(256, 256)
        # The client's claimed type and name do not matter; the bytes do.
        response = put_image(trio, ali, first, name="x.png", mime="text/html")
        assert response.status_code == 200, response.text
        user = response.json()["user"]
        url = user["avatar_url"]
        assert url.startswith(f"/api/avatars/{ali['id']}/") and url.endswith(".jpg")
        for sock in (a, b):
            assert sock.receive_json() == {"type": "user.updated", "user": user}
        served = trio.client.get(url)
        assert served.status_code == 200 and served.content == first
        assert served.headers["content-type"] == "image/jpeg"
        assert served.headers["content-security-policy"] == "sandbox; default-src 'none'"
        assert served.headers["x-content-type-options"] == "nosniff"
        assert "immutable" in served.headers["cache-control"]
        assert served.headers["content-disposition"] == "inline"
        assert avatars(trio) == [f"{ali['id']}-{url.rsplit('/', 1)[1]}"]
        # The same picture again: nothing changes, nothing is broadcast.
        assert put_image(trio, ali, first).json()["user"] == user
        # A new one replaces the old file.
        second = put_image(trio, ali, png(64, 64)).json()["user"]
        assert second["avatar_url"] != url and second["avatar_url"].endswith(".png")
        for sock in (a, b):
            assert expect(sock, "user.updated")["user"] == second
        assert trio.client.get(url).status_code == 404
        assert len(avatars(trio)) == 1
        # ready, /api/me and message authors carry it.
        me = trio.client.get("/api/me", headers=ali["auth"]).json()["user"]
        assert me == {**second, "is_owner": True}  # Ali is the owner (CONTRACT-V6-OPS)
        a.send_json({"type": "message.send", "channel_id": TEXT, "content": "selam"})
        assert expect(a, "message.new")["message"]["author"] == second
        expect(b, "message.new")
        with trio.ws(berk) as b2:
            listed = {u["id"]: u for u in b2.ready["users"]}
            assert listed[ali["id"]]["avatar_url"] == second["avatar_url"]
        # Delete.
        response = trio.client.delete("/api/me/avatar", headers=ali["auth"])
        assert response.json()["user"]["avatar_url"] is None
        assert avatars(trio) == []
        assert trio.client.get(second["avatar_url"]).status_code == 404
        page = trio.client.get(f"/api/channels/{TEXT}/messages", headers=ali["auth"]).json()
        assert page["messages"][0]["author"]["avatar_url"] is None
        # Deleting with no avatar is a quiet 200.
        assert trio.client.delete("/api/me/avatar", headers=ali["auth"]).status_code == 200


def test_avatars_do_not_count_towards_the_quota(make_trio):
    trio = make_trio(user_quota_mb=1)
    ali = trio.user("Ali")
    padded = png(16, 16)
    assert put_image(trio, ali, padded).status_code == 200
    assert trio.client.app.state.db is not None
    used = trio.client.portal.call(trio.client.app.state.db.stored_bytes, ali["id"])
    assert used == 0


@pytest.mark.parametrize(
    ("data", "status", "error"),
    [
        (png(513, 10), 422, "INVALID_IMAGE"),
        (jpeg(10, 600), 422, "INVALID_IMAGE"),
        (png(4, 4, ihdr_size=(4, 4))[:-6], 422, "INVALID_IMAGE"),
        (b"<svg/>", 422, "INVALID_IMAGE"),
        (b"GIF89a" + b"\x00" * 20, 422, "INVALID_IMAGE"),
        (png(4, 4, ihdr_size=(600, 600)), 422, "INVALID_IMAGE"),  # header says 600 px
        (b"\x00" * (IMAGE_MAX_BYTES + 1), 413, "FILE_TOO_LARGE"),
    ],
)
def test_avatar_refusals_leave_nothing(trio, data, status, error):
    ali = trio.user("Ali")
    response = put_image(trio, ali, data)
    assert response.status_code == status and code(response) == error
    assert avatars(trio) == []
    assert trio.client.get("/api/me", headers=ali["auth"]).json()["user"]["avatar_url"] is None


def test_avatar_upload_needs_a_file_part_and_a_token(trio):
    ali = trio.user("Ali")
    response = trio.client.put("/api/me/avatar", data={"x": "1"}, headers=ali["auth"])
    assert code(response) == "INVALID_UPLOAD"
    assert (
        trio.client.put("/api/me/avatar", files={"file": ("a.png", png(2, 2))}).status_code == 401
    )
    assert trio.client.delete("/api/me/avatar").status_code == 401


@pytest.mark.parametrize(
    "path",
    [
        "/api/avatars/1/0123456789abcdef0123456789abcdef.png",
        "/api/avatars/1/..%2F..%2Ftrio.db",
        "/api/avatars/1/x",
        "/api/avatars/0/a.png",
        f"/api/avatars/{2**63}/a.png",
        "/api/server/icon/0123456789abcdef0123456789abcdef.png",
        "/api/server/icon/x.png",
    ],
)
def test_unknown_avatars_and_icons_are_404(trio, path):
    trio.user("Ali")
    assert trio.client.get(path).status_code in (404, 422)


def test_another_users_avatar_path_is_not_theirs(trio):
    ali, berk = trio.user("Ali"), trio.user("Berk")
    url = put_image(trio, ali, png(8, 8)).json()["user"]["avatar_url"]
    stored = url.rsplit("/", 1)[1]
    assert trio.client.get(f"/api/avatars/{berk['id']}/{stored}").status_code == 404


# -- renames ----------------------------------------------------------------------------


def test_rename(trio):
    ali, berk = trio.user("Ali"), trio.user("Berk")
    with trio.ws(ali) as a, trio.ws(berk) as b:
        expect(a, "presence")
        a.send_json({"type": "message.send", "channel_id": TEXT, "content": "eski ad"})
        expect(a, "message.new")
        expect(b, "message.new")
        response = trio.client.patch("/api/me", json={"name": "  Alican "}, headers=ali["auth"])
        assert response.status_code == 200
        user = response.json()["user"]
        assert user == {"id": ali["id"], "name": "Alican", "avatar_url": None}
        for sock in (a, b):
            assert sock.receive_json() == {"type": "user.updated", "user": user}
        # Old messages show the new name: authors are joined by id.
        page = trio.client.get(f"/api/channels/{TEXT}/messages", headers=ali["auth"]).json()
        assert page["messages"][0]["author"]["name"] == "Alican"
        # Same validation and uniqueness as join; a case change of one's own name is fine.
        assert code(trio.client.patch("/api/me", json={"name": "BERK"}, headers=ali["auth"])) == (
            "NAME_TAKEN"
        )
        for bad in ("", " ", "x" * 33, "a\nb", 5, None, "‮Ali"):
            response = trio.client.patch("/api/me", json={"name": bad}, headers=ali["auth"])
            assert response.status_code == 422 and code(response) == "INVALID_NAME", bad
        assert (
            trio.client.patch("/api/me", json={"name": "ALICAN"}, headers=ali["auth"]).json()[
                "user"
            ]["name"]
            == "ALICAN"
        )
        assert expect(b, "user.updated")["user"]["name"] == "ALICAN"
        # The same name again: no broadcast.
        trio.client.patch("/api/me", json={"name": "ALICAN"}, headers=ali["auth"])
        b.send_json({"type": "ping"})
        assert b.receive_json() == {"type": "pong"}
    # The old name is free for a newcomer.
    assert trio.join("Ali").status_code == 201
    assert code(trio.join("alican")) == "NAME_TAKEN"


def test_profile_changes_are_limited(trio):
    ali = trio.user("Ali")
    for i in range(PROFILE_LIMIT):
        assert (
            trio.client.patch("/api/me", json={"name": f"Ali{i}"}, headers=ali["auth"]).status_code
            == 200
        )
    for request in (
        lambda: trio.client.patch("/api/me", json={"name": "Ali"}, headers=ali["auth"]),
        lambda: put_image(trio, ali, png(2, 2)),
        lambda: trio.client.patch("/api/server", json={"name": "x"}, headers=ali["auth"]),
    ):
        response = request()
        assert response.status_code == 429 and code(response) == "RATE_LIMITED"
    trio.clock.value += 61
    assert (
        trio.client.patch("/api/me", json={"name": "Ali"}, headers=ali["auth"]).status_code == 200
    )


# -- the server -------------------------------------------------------------------------


def test_the_server_profile(trio):
    ali, berk = trio.user("Ali"), trio.user("Berk")
    assert trio.client.get("/api/server", headers=ali["auth"]).json() == {
        "server": {"name": "Trio", "icon_url": None},
        "voice_room_max": 8,  # CONTRACT-V10-GROUPS §2
    }
    assert trio.client.get("/api/server").status_code == 401
    with trio.ws(ali) as a, trio.ws(berk) as b:
        expect(a, "presence")
        assert a.ready["server"] == {"name": "Trio", "icon_url": None}
        response = trio.client.patch("/api/server", json={"name": " Üçlü "}, headers=berk["auth"])
        server = response.json()["server"]
        assert server == {"name": "Üçlü", "icon_url": None}
        for sock in (a, b):
            assert sock.receive_json() == {"type": "server.updated", "server": server}
        for bad in ("", "x" * 33, 1, "a\x00"):
            response = trio.client.patch("/api/server", json={"name": bad}, headers=ali["auth"])
            assert code(response) == "INVALID_NAME"
        icon = WEBP_LOSSY_16X16
        response = put_image(trio, ali, icon, url="/api/server/icon", name="i.webp")
        assert response.status_code == 200, response.text
        server = response.json()["server"]
        assert server["name"] == "Üçlü" and server["icon_url"].startswith("/api/server/icon/")
        assert server["icon_url"].endswith(".webp")
        for sock in (a, b):
            assert expect(sock, "server.updated")["server"] == server
        served = trio.client.get(server["icon_url"])
        assert served.content == icon and served.headers["content-type"] == "image/webp"
        assert served.headers["content-security-policy"] == "sandbox; default-src 'none'"
        replaced = put_image(trio, berk, png(32, 32), url="/api/server/icon").json()["server"]
        assert trio.client.get(server["icon_url"]).status_code == 404
        assert len(icons(trio)) == 1
        assert trio.client.get("/api/server", headers=ali["auth"]).json()["server"] == replaced
        bad = put_image(trio, ali, png(600, 600), url="/api/server/icon")
        assert code(bad) == "INVALID_IMAGE"
        cleared = trio.client.delete("/api/server/icon", headers=ali["auth"]).json()["server"]
        assert cleared == {"name": "Üçlü", "icon_url": None}
        assert icons(trio) == []
    with trio.ws(ali) as a:
        assert a.ready["server"] == {"name": "Üçlü", "icon_url": None}


def test_profile_files_left_by_a_crash_are_swept_at_start(make_trio, tmp_path):
    db, uploads = str(tmp_path / "p.db"), tmp_path / "p-up"
    trio = make_trio(db_path=db, upload_dir=str(uploads))
    ali = trio.user("Ali")
    url = put_image(trio, ali, png(8, 8)).json()["user"]["avatar_url"]
    icon = put_image(trio, ali, png(9, 9), url="/api/server/icon").json()["server"]["icon_url"]
    (uploads / "avatars" / f"{ali['id']}-{'0' * 32}.png").write_bytes(b"old")
    (uploads / "avatars" / "half.part").write_bytes(b"x")
    (uploads / "icons" / f"{'1' * 32}.png").write_bytes(b"old")
    trio.client.__exit__(None, None, None)
    again = make_trio(db_path=db, upload_dir=str(uploads))
    assert sorted(os.listdir(uploads / "avatars")) == [f"{ali['id']}-{url.rsplit('/', 1)[1]}"]
    assert sorted(os.listdir(uploads / "icons")) == [icon.rsplit("/", 1)[1]]
    assert again.client.get(url).status_code == 200


def test_static_webp_is_served_as_image_webp(make_trio, tmp_path, monkeypatch):
    import mimetypes

    dist = tmp_path / "dist-webp"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html>")
    (dist / "assets" / "art-1.webp").write_bytes(WEBP_LOSSLESS_4X4)
    # As on a system whose mime.types has no .webp entry.
    bare = mimetypes.MimeTypes(filenames=())
    bare.types_map[True].pop(".webp", None)
    monkeypatch.setattr(mimetypes, "_db", bare)
    monkeypatch.setattr(mimetypes, "inited", True)
    assert mimetypes.guess_type("x.webp")[0] is None
    trio = make_trio(static_dir=str(dist))
    response = trio.client.get("/assets/art-1.webp")
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/webp"
