"""CONTRACT-V3 §4 and §8: storage quota, disk reserve, one upload at a time, sniffing by brand."""

from __future__ import annotations

import asyncio
import errno
import io
import os
import sqlite3

import httpx
import pytest

from trio_server import Settings, create_app
from trio_server.db import StorageFullError
from trio_server.uploads import sniff_content_type

from .conftest import INVITE
from .test_uploads import PNG, download, stored_files, upload, upload_dir

MB = 1024 * 1024


def code(response) -> str:
    return response.json()["error"]["code"]


def ftyp(major: bytes, *compatible: bytes) -> bytes:
    body = major + b"\x00\x00\x00\x00" + b"".join(compatible)
    return (8 + len(body)).to_bytes(4, "big") + b"ftyp" + body + b"\x00" * 64


# -- quota ----------------------------------------------------------------------


def test_the_quota_counts_everything_a_user_stored(make_trio):
    trio = make_trio(user_quota_mb=1, max_upload_mb=1)
    ali, berk = trio.user("Ali"), trio.user("Berk")
    first = upload(trio, ali, b"a" * (600 * 1024), "a.bin")
    assert first.status_code == 201
    # 600 KiB + 600 KiB is past 1 MiB: refused while streaming, nothing kept.
    response = upload(trio, ali, b"b" * (600 * 1024), "b.bin")
    assert response.status_code == 413
    assert code(response) == "QUOTA_EXCEEDED"
    assert stored_files(trio) == [first.json()["attachment"]["id"]]
    # Exactly what is left fits.
    assert upload(trio, ali, b"c" * (424 * 1024), "c.bin").status_code == 201
    # Full now: refused before a byte is read.
    response = upload(trio, ali, b"d", "d.txt")
    assert response.status_code == 413
    assert code(response) == "QUOTA_EXCEEDED"
    # Somebody else has their own quota.
    assert upload(trio, berk, b"e" * (600 * 1024), "e.bin").status_code == 201


def test_attached_files_count_towards_the_quota_too(make_trio):
    trio = make_trio(user_quota_mb=1)
    ali = trio.user("Ali")
    attachment = upload(trio, ali, b"x" * MB, "x.bin").json()["attachment"]
    with trio.ws(ali) as sock:
        sock.send_json(
            {"type": "message.send", "channel_id": 1, "attachment_ids": [attachment["id"]]}
        )
        assert sock.receive_json()["type"] == "message.new"
    assert code(upload(trio, ali, b"y", "y.txt")) == "QUOTA_EXCEEDED"


def test_a_declared_length_over_the_quota_is_refused_up_front(make_trio):
    trio = make_trio(user_quota_mb=1, max_upload_mb=5)
    ali = trio.user("Ali")
    response = trio.client.post(
        "/api/uploads",
        content=b"",
        headers={
            **ali["auth"],
            "Content-Type": "multipart/form-data; boundary=x",
            "Content-Length": str(3 * MB),
        },
    )
    assert response.status_code == 413
    assert code(response) == "QUOTA_EXCEEDED"


def test_settings_for_quota_reserve_and_hops():
    settings = Settings.from_env({"TRIO_INVITE_CODE": "x"})
    assert (settings.user_quota_mb, settings.disk_reserve_mb, settings.trusted_proxy_hops) == (
        1024,
        200,
        1,
    )
    settings = Settings.from_env(
        {
            "TRIO_INVITE_CODE": "x",
            "TRIO_USER_QUOTA_MB": "50",
            "TRIO_DISK_RESERVE_MB": "0",
            "TRIO_TRUSTED_PROXY_HOPS": "0",
        }
    )
    assert (settings.user_quota_bytes, settings.disk_reserve_bytes) == (50 * MB, 0)
    assert settings.trusted_proxy_hops == 0


# -- disk space -------------------------------------------------------------------


def test_an_upload_that_would_eat_the_reserve_is_507(make_trio):
    free = {"bytes": 300 * MB}
    trio = make_trio(disk_reserve_mb=200, disk_free=lambda path: free["bytes"])
    ali = trio.user("Ali")
    assert upload(trio, ali).status_code == 201
    free["bytes"] = 200 * MB + 10  # less than the reserve plus this upload
    response = upload(trio, ali)
    assert response.status_code == 507
    assert code(response) == "STORAGE_FULL"
    assert len(stored_files(trio)) == 1
    # Everything else keeps working.
    assert trio.client.get("/api/me", headers=ali["auth"]).status_code == 200


def test_the_disk_filling_up_while_streaming_is_507_and_leaves_nothing(make_trio):
    checks = []

    def disk_free(path):
        checks.append(1)
        # Plenty at the start, gone by the first look while streaming.
        return 10_000 * MB if len(checks) == 1 else 0

    trio = make_trio(disk_reserve_mb=1, disk_free=disk_free)
    ali = trio.user("Ali")
    response = upload(trio, ali, b"z" * (3 * MB), "big.bin")
    assert response.status_code == 507
    assert code(response) == "STORAGE_FULL"
    assert stored_files(trio) == []


def test_enospc_during_the_write_is_507_and_removes_the_partial_file(trio, monkeypatch):
    """Simulated: a real full disk is exercised against a tmpfs in the final report."""
    real_fdopen = os.fdopen

    class FullDisk(io.RawIOBase):
        def __init__(self, fd: int) -> None:
            self.inner = real_fdopen(fd, "wb")
            self.written = 0

        def write(self, data) -> int:
            self.written += len(data)
            if self.written > 1000:
                raise OSError(errno.ENOSPC, "No space left on device")
            return self.inner.write(data)

        def close(self) -> None:
            self.inner.close()

    monkeypatch.setattr(os, "fdopen", lambda fd, mode: FullDisk(fd))
    ali = trio.user("Ali")
    response = upload(trio, ali, b"q" * 5000, "q.bin")
    assert response.status_code == 507
    assert code(response) == "STORAGE_FULL"
    assert stored_files(trio) == []


def test_a_full_database_on_upload_is_507_and_removes_the_file(trio, monkeypatch):
    async def full(*args, **kwargs):
        raise StorageFullError

    monkeypatch.setattr(trio.client.app.state.db, "create_attachment", full)
    ali = trio.user("Ali")
    response = upload(trio, ali)
    assert response.status_code == 507
    assert code(response) == "STORAGE_FULL"
    assert stored_files(trio) == []


def test_a_full_database_on_message_send_is_an_error_frame(trio, monkeypatch):
    async def full(*args, **kwargs):
        raise StorageFullError

    ali = trio.user("Ali")
    monkeypatch.setattr(trio.client.app.state.db, "create_message", full)
    with trio.ws(ali) as sock:
        sock.send_json({"type": "message.send", "channel_id": 1, "content": "selam"})
        frame = sock.receive_json()
        assert frame["type"] == "error" and frame["code"] == "STORAGE_FULL"


def test_sqlite_disk_full_is_recognised():
    from trio_server.db import is_disk_full

    assert is_disk_full(sqlite3.OperationalError("database or disk is full"))
    assert not is_disk_full(sqlite3.OperationalError("no such table: x"))


# -- one upload in flight per user ------------------------------------------------


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_one_upload_at_a_time_per_user(tmp_path):
    app = create_app(
        Settings(
            invite_code=INVITE,
            db_path=str(tmp_path / "t.db"),
            upload_dir=str(tmp_path / "up"),
        )
    )
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as client:

            async def token(name: str) -> dict[str, str]:
                response = await client.post(
                    "/api/join", json={"invite_code": INVITE, "name": name}
                )
                return {"Authorization": f"Bearer {response.json()['token']}"}

            ali, berk = await token("Ali"), await token("Berk")
            release = asyncio.Event()
            boundary = "b"
            head = (
                f'--{boundary}\r\nContent-Disposition: form-data; name="file"; '
                'filename="slow.bin"\r\n\r\n'
            ).encode()

            async def slow_body():
                yield head + b"x" * 1000
                await release.wait()
                yield b"y" * 1000 + f"\r\n--{boundary}--\r\n".encode()

            headers = {"Content-Type": f"multipart/form-data; boundary={boundary}"}
            first = asyncio.create_task(
                client.post("/api/uploads", content=slow_body(), headers={**ali, **headers})
            )
            for _ in range(100):
                await asyncio.sleep(0.01)
                if app.state.uploading:
                    break

            files = {"file": ("b.png", PNG)}
            second = await client.post("/api/uploads", files=files, headers=ali)
            assert second.status_code == 429
            assert second.json()["error"]["code"] == "UPLOAD_IN_PROGRESS"
            # Somebody else is not blocked.
            other = await client.post("/api/uploads", files=files, headers=berk)
            assert other.status_code == 201
            release.set()
            assert (await first).status_code == 201
            # Done: the next one is fine.
            again = await client.post("/api/uploads", files=files, headers=ali)
            assert again.status_code == 201


# -- sweep on start --------------------------------------------------------------


def test_startup_sweep_deletes_day_old_orphans(tmp_path):
    from starlette.testclient import TestClient

    clock = {"t": 1_800_000_000.0}
    settings = Settings(
        invite_code=INVITE, db_path=str(tmp_path / "s.db"), upload_dir=str(tmp_path / "up")
    )
    with TestClient(create_app(settings, now=lambda: clock["t"])) as client:
        token = client.post("/api/join", json={"invite_code": INVITE, "name": "Ali"}).json()[
            "token"
        ]
        auth = {"Authorization": f"Bearer {token}"}
        orphan = client.post("/api/uploads", files={"file": ("o.txt", b"o")}, headers=auth).json()[
            "attachment"
        ]
    clock["t"] += 24 * 3600 + 1
    with TestClient(create_app(settings, now=lambda: clock["t"])) as client:
        # No upload happened; the start itself swept it.
        assert client.get(orphan["url"]).status_code == 404
        assert os.listdir(tmp_path / "up") == []


# -- sniffing by brand -------------------------------------------------------------


@pytest.mark.parametrize(
    ("head", "expected"),
    [
        (ftyp(b"isom", b"isom", b"avc1"), "video/mp4"),
        (ftyp(b"iso2"), "video/mp4"),
        (ftyp(b"mp41"), "video/mp4"),
        (ftyp(b"mp42", b"isom"), "video/mp4"),
        (ftyp(b"avc1"), "video/mp4"),
        (ftyp(b"dash", b"iso6"), "video/mp4"),
        (ftyp(b"M4V ", b"M4A ", b"mp42"), "video/mp4"),
        (ftyp(b"M4A ", b"mp42", b"isom"), "audio/mp4"),
        (ftyp(b"qt  ", b"qt  "), "video/quicktime"),
        (ftyp(b"heic", b"mif1", b"heic"), "image/heic"),
        (ftyp(b"heix"), "image/heic"),
        (ftyp(b"mif1", b"heic"), "image/heic"),
        (ftyp(b"msf1", b"hevc"), "image/heic"),
        (ftyp(b"avif", b"mif1", b"miaf"), "image/avif"),
        (ftyp(b"avis", b"msf1"), "image/avif"),
        (ftyp(b"mif1", b"avif", b"miaf"), "image/avif"),
        # An unknown major brand is decided by a compatible one ...
        (ftyp(b"XXXX", b"isom"), "video/mp4"),
        # ... and with none we know, by the extension allowlist (none for .mp4).
        (ftyp(b"crx ", b"isom"[:0]), "application/octet-stream"),
    ],
)
def test_ftyp_is_sniffed_by_brand(head, expected):
    assert sniff_content_type(head[:64], "a.mp4") == expected


def test_a_brand_outside_the_box_is_not_read():
    # Box of 16 bytes (no compatible brands); what follows is another box.
    head = (16).to_bytes(4, "big") + b"ftypXXXX\x00\x00\x00\x00" + b"\x00\x00\x00\x08isom"
    assert sniff_content_type(head, "a.bin") == "application/octet-stream"


@pytest.mark.parametrize(
    ("content", "filename", "content_type", "disposition"),
    [
        (ftyp(b"heic", b"mif1"), "IMG_0001.HEIC", "image/heic", "attachment"),
        (ftyp(b"qt  "), "clip.mov", "video/quicktime", "attachment"),
        (ftyp(b"avif", b"mif1"), "a.avif", "image/avif", "inline"),
        (ftyp(b"isom"), "a.mp4", "video/mp4", "inline"),
    ],
)
def test_heic_and_mov_download_and_avif_shows(trio, content, filename, content_type, disposition):
    ali = trio.user("Ali")
    attachment = upload(trio, ali, content, filename).json()["attachment"]
    assert attachment["content_type"] == content_type
    response = download(trio, attachment)
    assert response.headers["content-type"].split(";")[0] == content_type
    assert response.headers["content-disposition"].split(";")[0] == disposition
    assert (upload_dir(trio) / attachment["id"]).read_bytes() == content
