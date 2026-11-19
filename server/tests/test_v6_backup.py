"""CONTRACT-V6-OPS §3: the backup archive, its tickets, verify and restore."""

from __future__ import annotations

import asyncio
import io
import json
import sqlite3
import tarfile
import threading
from pathlib import Path

import pytest
from starlette.testclient import TestClient

from trio_server import Settings, backup, create_app

from .conftest import INVITE
from .imagegen import png
from .test_ws import expect

TEXT = 1


def code(response) -> str:
    return response.json()["error"]["code"]


@pytest.fixture
def filled(trio):
    """Ali (owner) and Berk; messages, attachments, an avatar, a server icon, a link code."""
    ali, berk = trio.user("Ali"), trio.user("Berk")
    files = {}
    for user, name, data in (
        (ali, "a.txt", b"alpha" * 100),
        (berk, "b.bin", bytes(range(256)) * 9),
    ):
        response = trio.client.post(
            "/api/uploads", files={"file": (name, data)}, headers=user["auth"]
        )
        files[name] = (response.json()["attachment"], data)
    avatar = png(8, 8)
    put = trio.client.put(
        "/api/me/avatar", files={"file": ("a.png", avatar, "image/png")}, headers=ali["auth"]
    )
    assert put.status_code == 200, put.text
    icon = trio.client.put(
        "/api/server/icon", files={"file": ("i.png", png(6, 6), "image/png")}, headers=ali["auth"]
    )
    assert icon.status_code == 200, icon.text
    with trio.ws(ali) as a:
        for i in range(3):
            a.send_json({"type": "message.send", "channel_id": TEXT, "content": f"mesaj {i}"})
            expect(a, "message.new")
        a.send_json(
            {
                "type": "message.send",
                "channel_id": TEXT,
                "content": "ekli",
                "attachment_ids": [files["a.txt"][0]["id"]],
            }
        )
        expect(a, "message.new")
    with trio.ws(berk) as b:
        b.send_json(
            {
                "type": "message.send",
                "channel_id": TEXT,
                "content": "",
                "attachment_ids": [files["b.bin"][0]["id"]],
            }
        )
        expect(b, "message.new")
    assert trio.client.post("/api/link-codes", headers=berk["auth"]).status_code == 201
    return {
        "ali": ali,
        "berk": berk,
        "files": files,
        "avatar": avatar,
        "avatar_url": put.json()["user"]["avatar_url"],
    }


def ticket(trio, user) -> str:
    response = trio.client.post("/api/owner/backup-tickets", headers=user["auth"])
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["url"] == f"/api/owner/backup?ticket={body['ticket']}"
    assert response.headers["cache-control"] == "no-store"
    return body["ticket"]


def download(trio, user, tmp_path: Path) -> Path:
    response = trio.client.get(f"/api/owner/backup?ticket={ticket(trio, user)}")
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "application/x-tar"
    assert int(response.headers["content-length"]) == len(response.content)
    disposition = response.headers["content-disposition"]
    assert disposition.startswith('attachment; filename="trio-yedek-') and disposition.endswith(
        '.tar"'
    )
    path = tmp_path / "yedek.tar"
    path.write_bytes(response.content)
    return path


def staging_dirs(trio) -> list[Path]:
    data_dir = Path(trio.client.app.state.settings.db_path).parent
    return [p for p in data_dir.iterdir() if p.name.startswith(backup.STAGING_PREFIX)]


# -- the archive ----------------------------------------------------------------------


def test_the_archive_holds_a_snapshot_the_files_and_a_manifest(trio, filled, tmp_path):
    archive = download(trio, filled["ali"], tmp_path)
    with tarfile.open(archive) as tar:
        names = tar.getnames()
        manifest = json.load(tar.extractfile("manifest.json"))
        tar.extract("trio.db", tmp_path / "x", filter="data")
    assert names[:2] == ["manifest.json", "trio.db"]
    assert {f"uploads/{f[0]['id']}" for f in filled["files"].values()} <= set(names)
    assert any(n.startswith("uploads/avatars/") for n in names)
    assert any(n.startswith("uploads/icons/") for n in names)
    assert not any("-wal" in n or "-shm" in n or n.endswith(".part") for n in names)
    assert manifest["format"] == "trio-backup" and manifest["format_version"] == 1
    assert manifest["counts"]["users"] == 2
    assert manifest["counts"]["messages"] == 5
    assert manifest["counts"]["channels"] == 2
    assert manifest["counts"]["attachments"] == 2
    assert manifest["includes"] == {
        "token_hashes": True,
        "link_codes": False,
        "rate_limits": False,
        "client_errors": True,
    }
    snapshot = sqlite3.connect(tmp_path / "x" / "trio.db")
    assert snapshot.execute("PRAGMA journal_mode").fetchone()[0] == "delete"
    assert snapshot.execute("SELECT count(*) FROM link_codes").fetchone()[0] == 0
    assert snapshot.execute("SELECT count(*) FROM tokens").fetchone()[0] == 2
    # Nothing staged is left behind; the lock is free; the backup is remembered.
    assert staging_dirs(trio) == []
    overview = trio.client.get("/api/owner/overview", headers=filled["ali"]["auth"]).json()
    last = overview["backup"]["last"]
    assert last["counts"] == manifest["counts"]
    assert last["sha256"] == manifest["database"]["sha256"]
    assert last["upload_files"] == manifest["upload_files"] == len(names) - 2
    assert overview["backup"]["in_progress"] is None


def test_verify_passes_and_catches_tampering(trio, filled, tmp_path):
    archive = download(trio, filled["ali"], tmp_path)
    result = backup.verify_archive(archive)
    assert result.ok, result.problems
    assert result.counts["messages"] == 5
    out = io.StringIO()
    assert backup.main(["verify", str(archive)], out=out) == 0
    assert "5 messages" in out.getvalue() and "ok:" in out.getvalue()

    attachment_id = filled["files"]["a.txt"][0]["id"]
    tampered = tmp_path / "tampered.tar"
    with tarfile.open(archive) as src, tarfile.open(tampered, "w") as dst:
        for info in src.getmembers():
            data = src.extractfile(info).read()
            if info.name == f"uploads/{attachment_id}":
                data = data[:-1]
                info.size = len(data)
            dst.addfile(info, io.BytesIO(data))
    bad = backup.verify_archive(tampered)
    assert not bad.ok
    assert any(attachment_id in p for p in bad.problems)
    assert backup.main(["verify", str(tampered)], out=io.StringIO()) == 1
    junk = tmp_path / "junk.tar"
    junk.write_bytes(b"not a tar")
    assert backup.main(["verify", str(junk)], out=io.StringIO()) == 1


def test_verify_refuses_unsafe_members(tmp_path):
    archive = tmp_path / "evil.tar"
    with tarfile.open(archive, "w") as tar:
        for name in ("manifest.json", "../escape", "uploads/../../x"):
            info = tarfile.TarInfo(name)
            info.size = 2
            tar.addfile(info, io.BytesIO(b"{}"))
    with pytest.raises(backup.BackupError):
        backup.verify_archive(archive)
    assert not (tmp_path.parent / "escape").exists()


# -- restore ----------------------------------------------------------------------------


def test_restore_round_trip_boots_and_keeps_everybody_signed_in(trio, filled, tmp_path):
    archive = download(trio, filled["ali"], tmp_path)
    data_dir = tmp_path / "fresh"
    data_dir.mkdir()
    (data_dir / "lost+found").mkdir()  # a fresh ext4 volume has it: still "empty"
    out = io.StringIO()
    assert backup.main(["restore", str(archive), "--data-dir", str(data_dir)], out=out) == 0
    assert "restart the server" in out.getvalue()
    before = trio.client.get(f"/api/channels/{TEXT}/messages", headers=filled["ali"]["auth"]).json()

    app = create_app(
        Settings(
            invite_code=INVITE,
            db_path=str(data_dir / "trio.db"),
            upload_dir=str(data_dir / "uploads"),
        )
    )
    with TestClient(app) as restored:
        # An old token still signs in.
        me = restored.get("/api/me", headers=filled["berk"]["auth"])
        assert me.status_code == 200 and me.json()["user"]["name"] == "Berk"
        after = restored.get(f"/api/channels/{TEXT}/messages", headers=filled["ali"]["auth"]).json()
        assert after == before
        for attachment, data in filled["files"].values():
            response = restored.get(attachment["url"])
            assert response.status_code == 200 and response.content == data
        avatar = restored.get(filled["avatar_url"])
        assert avatar.status_code == 200 and avatar.content == filled["avatar"]
        # The startup sweeps removed nothing that the database names.
        assert sorted(p.name for p in (data_dir / "uploads").iterdir() if p.is_file()) == sorted(
            a["id"] for a, _ in filled["files"].values()
        )


def test_restore_refuses_a_non_empty_data_dir_without_force(trio, filled, tmp_path):
    archive = download(trio, filled["ali"], tmp_path)
    data_dir = tmp_path / "used"
    data_dir.mkdir()
    (data_dir / "trio.db").write_bytes(b"old database")
    assert (
        backup.main(["restore", str(archive), "--data-dir", str(data_dir)], out=io.StringIO()) == 1
    )
    assert (data_dir / "trio.db").read_bytes() == b"old database"
    assert (
        backup.main(
            ["restore", str(archive), "--data-dir", str(data_dir), "--force"], out=io.StringIO()
        )
        == 0
    )
    aside = [p for p in data_dir.iterdir() if p.name.startswith("before-restore-")]
    assert len(aside) == 1 and (aside[0] / "trio.db").read_bytes() == b"old database"
    assert (
        sqlite3.connect(data_dir / "trio.db").execute("SELECT count(*) FROM messages").fetchone()[0]
        == 5
    )
    assert not [p for p in data_dir.iterdir() if p.name.startswith(backup.RESTORE_PREFIX)]


def test_restore_does_not_write_a_failed_archive(tmp_path):
    archive = tmp_path / "empty.tar"
    with tarfile.open(archive, "w"):
        pass
    data_dir = tmp_path / "d"
    assert (
        backup.main(["restore", str(archive), "--data-dir", str(data_dir)], out=io.StringIO()) == 1
    )
    assert list(data_dir.iterdir()) == []


# -- tickets --------------------------------------------------------------------------


def test_tickets_are_single_use_and_expire(trio, filled):
    ali = filled["ali"]
    first = ticket(trio, ali)
    assert trio.client.get(f"/api/owner/backup?ticket={first}").status_code == 200
    reused = trio.client.get(f"/api/owner/backup?ticket={first}")
    assert reused.status_code == 403 and code(reused) == "INVALID_TICKET"
    late = ticket(trio, ali)
    trio.clock.value += backup.TICKET_SECONDS + 1
    assert code(trio.client.get(f"/api/owner/backup?ticket={late}")) == "INVALID_TICKET"
    assert code(trio.client.get("/api/owner/backup?ticket=made-up")) == "INVALID_TICKET"
    # No ticket: the bearer header, owner only.
    assert trio.client.get("/api/owner/backup", headers=ali["auth"]).status_code == 200
    assert trio.client.get("/api/owner/backup", headers=filled["berk"]["auth"]).status_code == 403
    assert trio.client.get("/api/owner/backup").status_code == 401
    # Only the hash of a ticket is kept.
    stored = trio.client.app.state.backups.tickets
    live = ticket(trio, ali)
    assert live not in stored and all(len(h) == 64 for h in stored)


def test_a_ticket_of_somebody_no_longer_the_owner_is_refused(make_trio):
    trio = make_trio()
    ali = trio.user("Ali")
    issued = ticket(trio, ali)
    trio.client.app.state.settings.__dict__["owner"] = "nobody"  # the rule changed meanwhile
    response = trio.client.get(f"/api/owner/backup?ticket={issued}")
    assert response.status_code == 403 and code(response) == "FORBIDDEN"


# -- one at a time, and cleaned up however it ends --------------------------------------


class StuckDownload:
    """Drives the app over raw ASGI and stops after the first body chunk until released;
    then the client "goes away" (the next send fails, as uvicorn's does)."""

    def __init__(self, trio, path: str) -> None:
        self.trio = trio
        self.path, _, self.query = path.partition("?")
        self.paused = threading.Event()
        self.chunks = 0
        self.gate: asyncio.Event | None = None

    async def run(self) -> None:
        self.gate = asyncio.Event()

        async def receive():
            await self.gate.wait()
            return {"type": "http.disconnect"}

        async def send(message):
            if message["type"] == "http.response.body":
                self.chunks += 1
                if self.chunks == 1:
                    self.paused.set()
                    await self.gate.wait()
                    raise OSError("client went away")

        scope = {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": "2.4"},
            "http_version": "1.1",
            "method": "GET",
            "scheme": "http",
            "path": self.path,
            "raw_path": self.path.encode(),
            "query_string": self.query.encode(),
            "root_path": "",
            "headers": [(b"host", b"testserver")],
            "client": ("203.0.113.1", 1234),
            "server": ("testserver", 80),
        }
        try:
            await self.trio.client.app(scope, receive, send)
        except Exception:  # noqa: BLE001, S110 - the disconnect surfaces as an error
            pass

    def release(self) -> None:
        self.trio.client.portal.call(self._release)

    async def _release(self) -> None:
        assert self.gate is not None
        self.gate.set()


def while_stuck(trio, ali, filled) -> None:
    assert len(staging_dirs(trio)) == 1
    busy = trio.client.get(f"/api/owner/backup?ticket={ticket(trio, ali)}")
    assert busy.status_code == 409 and code(busy) == "BACKUP_IN_PROGRESS"
    progress = trio.client.get("/api/owner/overview", headers=ali["auth"]).json()["backup"]
    assert progress["in_progress"]["total"] > progress["in_progress"]["sent"] > 0
    # Meanwhile the hub keeps serving: a message goes through.
    with trio.ws(filled["berk"]) as b:
        b.send_json({"type": "message.send", "channel_id": TEXT, "content": "hala buradayım"})
        expect(b, "message.new")


def test_one_backup_at_a_time_and_cleanup_on_disconnect(trio, filled):
    ali = filled["ali"]
    stuck = StuckDownload(trio, f"/api/owner/backup?ticket={ticket(trio, ali)}")
    future = trio.client.portal.start_task_soon(stuck.run)
    try:
        assert stuck.paused.wait(10)
        while_stuck(trio, ali, filled)
    finally:
        stuck.release()
    future.result(10)
    assert staging_dirs(trio) == []
    assert trio.client.app.state.backups.running is None
    # An aborted download is not a backup.
    overview = trio.client.get("/api/owner/overview", headers=ali["auth"]).json()
    assert overview["backup"]["last"] is None
    assert trio.client.get(f"/api/owner/backup?ticket={ticket(trio, ali)}").status_code == 200


def test_stale_staging_from_a_crash_is_removed(trio, filled):
    data_dir = Path(trio.client.app.state.settings.db_path).parent
    stale = data_dir / f"{backup.STAGING_PREFIX}deadbeef"
    (stale / "uploads").mkdir(parents=True)
    (stale / "trio.db").write_bytes(b"x")
    assert trio.client.get("/api/owner/backup", headers=filled["ali"]["auth"]).status_code == 200
    assert not stale.exists()


def test_files_are_held_open_where_hard_links_are_impossible(trio, filled, tmp_path, monkeypatch):
    import errno
    import os

    def no_links(src, dst):
        raise OSError(errno.EXDEV, "cross-device link")

    monkeypatch.setattr(os, "link", no_links)
    archive = download(trio, filled["ali"], tmp_path)
    assert backup.verify_archive(archive).ok
    assert staging_dirs(trio) == []


def test_restore_reads_an_archive_from_stdin(trio, filled, tmp_path, monkeypatch):
    archive = download(trio, filled["ali"], tmp_path)

    class Stdin:
        buffer = io.BytesIO(archive.read_bytes())

    monkeypatch.setattr("sys.stdin", Stdin)
    data_dir = tmp_path / "piped"
    assert backup.main(["restore", "-", "--data-dir", str(data_dir)], out=io.StringIO()) == 0
    assert sorted(p.name for p in data_dir.iterdir()) == ["trio.db", "uploads"]
