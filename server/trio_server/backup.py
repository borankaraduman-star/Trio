"""Backups: one tar archive of everything, its check, and restoring it (CONTRACT-V6-OPS §3).

The archive (uncompressed tar; uploads are mostly JPEG/PNG/MP4 and do not
shrink, and an uncompressed tar has a size known before the first byte, so
the browser shows real progress)::

    manifest.json        format, versions, counts, the snapshot's sha256
    trio.db              a consistent SQLite snapshot (journal_mode DELETE, one file)
    uploads/...          attachments, uploads/avatars/..., uploads/icons/...

The snapshot is taken with SQLite's backup API (never a copy of the live
file and its -wal), then link codes are deleted from it and it is vacuumed.
Token hashes are KEPT: a restored server keeps everybody signed in. The
upload files are hard-linked into a staging directory at the same moment
(under ``db.write_lock``, which every attachment write and delete holds), so
a file deleted while the archive streams is still sent and the archive
matches its snapshot. Where a hard link is impossible the file is kept open
instead. The staging directory is removed when the response ends, however
it ends.

    python -m trio_server.backup verify <archive>
    python -m trio_server.backup restore <archive|-> --data-dir /data [--force]
"""

# No ``from __future__ import annotations``: see message_routes.

import argparse
import asyncio
import contextlib
import hashlib
import json
import logging
import os
import re
import secrets
import shutil
import sqlite3
import sys
import tarfile
import tempfile
import time
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Annotated, Any, TextIO

from fastapi import Depends, FastAPI, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.types import Receive, Scope, Send

from trio_server.config import Settings
from trio_server.db import Database, hash_token, utc_iso
from trio_server.errors import ApiError
from trio_server.ops_schema import ensure_ops_schema, get_meta, set_meta_locked
from trio_server.version import VERSION

logger = logging.getLogger("trio")

FORMAT = "trio-backup"
FORMAT_VERSION = 1
CHUNK_BYTES = 256 * 1024
TICKET_SECONDS = 60
STAGING_PREFIX = ".trio-backup-"
RESTORE_PREFIX = ".trio-restore-"
DB_NAME = "trio.db"
UPLOADS = "uploads"
MANIFEST = "manifest.json"
LAST_BACKUP_KEY = "last_backup"
# Ignored when deciding whether a data directory is empty (ext4's own).
IGNORED_IN_DATA_DIR = frozenset({"lost+found"})

_SAFE_PART = re.compile(r"^[A-Za-z0-9._-]+$")


def is_staging_name(name: str) -> bool:
    return name.startswith((STAGING_PREFIX, RESTORE_PREFIX))


class BackupError(Exception):
    pass


# -- counting a database ------------------------------------------------------


def count_database(conn: sqlite3.Connection) -> dict[str, int]:
    def one(sql: str) -> int:
        return int(conn.execute(sql).fetchone()[0])

    return {
        "users": one("SELECT count(*) FROM users WHERE removed_at IS NULL"),
        "removed_users": one("SELECT count(*) FROM users WHERE removed_at IS NOT NULL"),
        "channels": one("SELECT count(*) FROM channels"),
        "messages": one("SELECT count(*) FROM messages"),
        "attachments": one("SELECT count(*) FROM attachments WHERE deleted_at IS NULL"),
        "attachment_bytes": one(
            "SELECT coalesce(sum(size), 0) FROM attachments WHERE deleted_at IS NULL"
        ),
        "tokens": one("SELECT count(*) FROM tokens"),
    }


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(CHUNK_BYTES), b""):
            digest.update(chunk)
    return digest.hexdigest()


# -- building an archive ------------------------------------------------------


@dataclass
class Member:
    """One file of the archive: its tar header, and where its bytes come from."""

    name: str
    size: int
    header: bytes
    path: Path | None = None  # a staged hard link
    fd: int | None = None  # an open file (no hard link possible)
    data: bytes | None = None  # in memory (the manifest)

    @property
    def padded(self) -> int:
        return len(self.header) + self.size + (-self.size % tarfile.BLOCKSIZE)


@dataclass
class Plan:
    staging: Path
    members: list[Member]
    manifest: dict[str, Any]
    total: int
    filename: str
    fds: list[int] = field(default_factory=list)

    def cleanup(self) -> None:
        for fd in self.fds:
            with contextlib.suppress(OSError):
                os.close(fd)
        self.fds.clear()
        shutil.rmtree(self.staging, ignore_errors=True)


def _header(name: str, size: int, mtime: float) -> bytes:
    info = tarfile.TarInfo(name)
    info.size = size
    info.mtime = int(mtime)
    info.mode = 0o644
    info.type = tarfile.REGTYPE
    return info.tobuf(format=tarfile.PAX_FORMAT)


def remove_stale_staging(data_dir: Path) -> None:
    """Staging left by a crash (only one backup runs at a time, so any is stale)."""
    with contextlib.suppress(OSError):
        for entry in data_dir.iterdir():
            if entry.name.startswith(STAGING_PREFIX) and entry.is_dir():
                shutil.rmtree(entry, ignore_errors=True)


def _upload_files(upload_dir: Path) -> list[tuple[str, Path]]:
    """(name in the archive, path) for every stored file, sorted."""
    found: list[tuple[str, Path]] = []
    for root, dirs, files in os.walk(upload_dir):
        dirs[:] = sorted(d for d in dirs if not is_staging_name(d))
        for name in sorted(files):
            if name.endswith(".part"):
                continue
            path = Path(root) / name
            if path.is_symlink() or not path.is_file():
                continue
            rel = path.relative_to(upload_dir).as_posix()
            found.append((f"{UPLOADS}/{rel}", path))
    return found


def build_plan(db_path: str, upload_dir: Path, created_at: float) -> Plan:
    """Snapshot the database and stage the files. Blocking; run it in a thread,
    under ``db.write_lock`` (so no attachment is written or deleted meanwhile)."""
    data_dir = Path(db_path).resolve().parent
    remove_stale_staging(data_dir)
    staging = data_dir / f"{STAGING_PREFIX}{secrets.token_hex(8)}"
    staging.mkdir(mode=0o700)
    plan = Plan(staging=staging, members=[], manifest={}, total=0, filename="")
    try:
        snapshot = staging / DB_NAME
        source = sqlite3.connect(db_path)
        try:
            target = sqlite3.connect(snapshot)
            try:
                source.backup(target)
            finally:
                target.close()
        finally:
            source.close()
        target = sqlite3.connect(snapshot, isolation_level=None)
        try:
            # One file, no -wal: the WAL flag is copied with the pages.
            target.execute("PRAGMA journal_mode=DELETE")
            # Not part of a backup: a code is a 10-minute capability.
            target.execute("DELETE FROM link_codes")
            # V11: move codes are 10-minute capabilities too (and carry preferences).
            target.execute("DELETE FROM move_codes")
            target.execute("VACUUM")
            (check,) = target.execute("PRAGMA integrity_check").fetchone()
            if check != "ok":
                raise BackupError(f"snapshot failed its integrity check: {check}")
            counts = count_database(target)
        finally:
            target.close()

        members: list[Member] = []
        upload_bytes = 0
        links = staging / UPLOADS
        for name, path in _upload_files(upload_dir):
            staged = links / name.removeprefix(f"{UPLOADS}/")
            staged.parent.mkdir(parents=True, exist_ok=True)
            member_path: Path | None = None
            fd: int | None = None
            try:
                os.link(path, staged)
                member_path = staged
                st = staged.stat()
            except FileNotFoundError:
                continue
            except OSError:
                # Another filesystem, or no hard links: hold the file open instead.
                try:
                    fd = os.open(path, os.O_RDONLY)
                except FileNotFoundError:
                    continue
                plan.fds.append(fd)
                st = os.fstat(fd)
            members.append(
                Member(
                    name=name,
                    size=st.st_size,
                    header=_header(name, st.st_size, st.st_mtime),
                    path=member_path,
                    fd=fd,
                )
            )
            upload_bytes += st.st_size

        db_size = snapshot.stat().st_size
        manifest = {
            "format": FORMAT,
            "format_version": FORMAT_VERSION,
            "server_version": VERSION,
            "created_at": utc_iso(created_at),
            "counts": counts,
            "upload_files": len(members),
            "upload_bytes": upload_bytes,
            "database": {"name": DB_NAME, "size": db_size, "sha256": _sha256_file(snapshot)},
            "includes": {
                "token_hashes": True,
                "link_codes": False,
                "rate_limits": False,
                "client_errors": True,
            },
            "note": (
                "Token hashes are kept so that a restored server keeps everybody signed in; "
                "treat this archive like the server's disk. Link codes and rate-limit state "
                "are not included."
            ),
        }
        data = json.dumps(manifest, indent=2, ensure_ascii=False).encode("utf-8")
        head = [
            Member(
                name=MANIFEST,
                size=len(data),
                header=_header(MANIFEST, len(data), created_at),
                data=data,
            ),
            Member(
                name=DB_NAME,
                size=db_size,
                header=_header(DB_NAME, db_size, created_at),
                path=snapshot,
            ),
        ]
        plan.members = head + members
        plan.manifest = manifest
        plan.total = sum(m.padded for m in plan.members) + 2 * tarfile.BLOCKSIZE
        stamp = time.strftime("%Y-%m-%d-%H%M", time.gmtime(created_at))
        plan.filename = f"trio-yedek-{stamp}.tar"
        return plan
    except BaseException:
        plan.cleanup()
        raise


def _read_member(member: Member, offset: int) -> bytes:
    if member.fd is not None:
        return os.pread(member.fd, CHUNK_BYTES, offset)
    assert member.path is not None  # noqa: S101
    with member.path.open("rb") as handle:
        handle.seek(offset)
        return handle.read(CHUNK_BYTES)


async def stream_plan(plan: Plan) -> AsyncIterator[bytes]:
    """The archive's bytes; file reads happen in a thread, never on the loop."""
    for member in plan.members:
        yield member.header
        if member.data is not None:
            yield member.data
        else:
            sent = 0
            while sent < member.size:
                chunk = await asyncio.to_thread(_read_member, member, sent)
                if not chunk:
                    break
                chunk = chunk[: member.size - sent]
                yield chunk
                sent += len(chunk)
            if sent < member.size:
                # Cannot happen with a hard link; keeps the length promised.
                logger.error("backup.short_file %s", member.name)
                yield bytes(member.size - sent)
        pad = -member.size % tarfile.BLOCKSIZE
        if pad:
            yield bytes(pad)
    yield bytes(2 * tarfile.BLOCKSIZE)


class CleanupStreamingResponse(StreamingResponse):
    """A streaming response that runs ``on_end`` however the response ends:
    finished, the client gone (Starlette's disconnect or a failing send),
    or the request task cancelled."""

    def __init__(self, *args: Any, on_end: Callable[[], Awaitable[None]], **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._on_end = on_end

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            with contextlib.suppress(Exception):
                close = getattr(self.body_iterator, "aclose", None)
                if close is not None:
                    await close()
            await asyncio.shield(self._on_end())


# -- the REST side ------------------------------------------------------------


class Backups:
    """Tickets, the one-at-a-time lock and the last backup, for one app."""

    def __init__(self, db: Database, now: Callable[[], float]) -> None:
        self._db = db
        self._now = now
        # sha256(ticket) -> (user id, expiry); single use.
        self.tickets: dict[str, tuple[int, float]] = {}
        self.running: dict[str, int] | None = None

    def issue(self, user_id: int) -> tuple[str, float]:
        clock = self._now()
        self.tickets = {h: t for h, t in self.tickets.items() if t[1] > clock}
        ticket = secrets.token_urlsafe(32)
        expires = clock + TICKET_SECONDS
        self.tickets[hash_token(ticket)] = (user_id, expires)
        return ticket, expires

    def redeem(self, ticket: str) -> int | None:
        found = self.tickets.pop(hash_token(ticket), None)
        if found is None or found[1] <= self._now():
            return None
        return found[0]

    async def status(self) -> dict[str, Any]:
        last = await get_meta(self._db, LAST_BACKUP_KEY)
        return {
            "last": last,
            "in_progress": None if self.running is None else dict(self.running),
        }


def register_backup_routes(
    app: FastAPI,
    *,
    db: Database,
    settings: Settings,
    now: Callable[[], float],
    upload_dir: Path,
    owner_user: Callable[..., Awaitable[dict[str, Any]]],
    resolve_owner: Callable[[], Awaitable[int | None]],
) -> Backups:
    Owner = Annotated[dict[str, Any], Depends(owner_user)]
    backups = Backups(db, now)
    app.state.backups = backups

    @app.post("/api/owner/backup-tickets", status_code=201)
    async def new_ticket(user: Owner) -> Any:
        ticket, expires = backups.issue(user["id"])
        return JSONResponse(
            {
                "ticket": ticket,
                "expires_at": utc_iso(expires),
                "url": f"/api/owner/backup?ticket={ticket}",
            },
            status_code=201,
            headers={"Cache-Control": "no-store"},
        )

    async def who(request: Request, ticket: str | None) -> int:
        if ticket:
            user_id = backups.redeem(ticket)
            if user_id is None:
                raise ApiError(403, "INVALID_TICKET", "the download link is used or expired")
        else:
            user_id = (await owner_user(await app.state.current_user(request)))["id"]
        if await resolve_owner() != user_id:
            raise ApiError(403, "FORBIDDEN", "only the server's owner may do that")
        return user_id

    @app.get("/api/owner/backup")
    async def download(
        request: Request, ticket: Annotated[str | None, Query(max_length=128)] = None
    ) -> Any:
        user_id = await who(request, ticket)
        if backups.running is not None:
            raise ApiError(409, "BACKUP_IN_PROGRESS", "a backup is already being downloaded")
        progress = {"sent": 0, "total": 0}
        backups.running = progress
        try:
            await ensure_ops_schema(db)
            async with db.write_lock:
                plan = await asyncio.to_thread(build_plan, settings.db_path, upload_dir, now())
        except BaseException:
            backups.running = None
            raise
        progress["total"] = plan.total
        state = {"done": False}
        logger.info("backup.started user=%s bytes=%s", user_id, plan.total)

        async def body() -> AsyncIterator[bytes]:
            async for chunk in stream_plan(plan):
                progress["sent"] += len(chunk)
                yield chunk
            # Only reached after the last chunk was handed to the server.
            state["done"] = True
            record = {
                "at": utc_iso(now()),
                "counts": plan.manifest["counts"],
                "upload_files": plan.manifest["upload_files"],
                "bytes": plan.total,
                "sha256": plan.manifest["database"]["sha256"],
            }
            async with db.write_lock:
                await set_meta_locked(db, LAST_BACKUP_KEY, record)

        async def on_end() -> None:
            plan.cleanup()
            backups.running = None
            logger.info("backup.%s user=%s", "finished" if state["done"] else "aborted", user_id)

        return CleanupStreamingResponse(
            body(),
            media_type="application/x-tar",
            on_end=on_end,
            headers={
                "Content-Length": str(plan.total),
                "Content-Disposition": f'attachment; filename="{plan.filename}"',
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
            },
        )

    return backups


# -- verify -------------------------------------------------------------------


@dataclass
class Verified:
    manifest: dict[str, Any]
    counts: dict[str, int]
    problems: list[str]

    @property
    def ok(self) -> bool:
        return not self.problems


def _safe_name(name: str) -> bool:
    if name in (MANIFEST, DB_NAME):
        return True
    path = PurePosixPath(name)
    parts = path.parts
    return (
        not path.is_absolute()
        and len(parts) >= 2
        and parts[0] == UPLOADS
        and all(_SAFE_PART.match(p) and p not in (".", "..") for p in parts[1:])
    )


def _open_archive(source: Path) -> tarfile.TarFile:
    try:
        return tarfile.open(source, mode="r:*")
    except (tarfile.TarError, OSError) as exc:
        raise BackupError(f"not a readable tar archive: {exc}") from None


def verify_archive(source: Path, *, extract_to: Path | None = None) -> Verified:
    """Open, check every member, integrity-check and recount the snapshot.

    ``extract_to``: also leave the files there (``trio.db``, ``uploads/...``),
    which is what ``restore`` does after a clean check.
    """
    problems: list[str] = []
    with tempfile.TemporaryDirectory(prefix=RESTORE_PREFIX) as tmp:
        target = extract_to or Path(tmp)
        sizes: dict[str, int] = {}
        manifest: dict[str, Any] | None = None
        with _open_archive(source) as archive:
            for info in archive:
                if not info.isfile() or not _safe_name(info.name):
                    problems.append(f"unexpected member {info.name!r}")
                    continue
                if info.name in sizes:
                    problems.append(f"duplicate member {info.name!r}")
                    continue
                sizes[info.name] = info.size
                handle = archive.extractfile(info)
                assert handle is not None  # noqa: S101 - a regular file
                if info.name == MANIFEST:
                    try:
                        manifest = json.loads(handle.read(1024 * 1024))
                    except ValueError:
                        problems.append("manifest.json is not JSON")
                    continue
                out = target / info.name
                out.parent.mkdir(parents=True, exist_ok=True)
                with out.open("wb") as dest:
                    shutil.copyfileobj(handle, dest, CHUNK_BYTES)
        if not isinstance(manifest, dict):
            raise BackupError("the archive has no manifest.json; is it a Trio backup?")
        if manifest.get("format") != FORMAT or manifest.get("format_version") != FORMAT_VERSION:
            raise BackupError("unknown backup format")
        snapshot = target / DB_NAME
        if not snapshot.is_file():
            raise BackupError("the archive has no trio.db")
        expected = manifest.get("database", {})
        if _sha256_file(snapshot) != expected.get("sha256"):
            problems.append("trio.db does not match the manifest's sha256")
        conn = sqlite3.connect(f"file:{snapshot}?mode=ro", uri=True)
        try:
            (check,) = conn.execute("PRAGMA integrity_check").fetchone()
            if check != "ok":
                problems.append(f"integrity_check: {check}")
            counts = count_database(conn)
            for key, value in manifest.get("counts", {}).items():
                if counts.get(key) != value:
                    problems.append(f"{key}: manifest says {value}, database has {counts.get(key)}")
            rows = conn.execute(
                "SELECT id, size FROM attachments WHERE deleted_at IS NULL"
            ).fetchall()
            for attachment_id, size in rows:
                name = f"{UPLOADS}/{attachment_id}"
                if sizes.get(name) != size:
                    problems.append(f"attachment {attachment_id} missing or the wrong size")
            for user_id, avatar in conn.execute(
                "SELECT id, avatar FROM users WHERE avatar IS NOT NULL"
            ):
                if f"{UPLOADS}/avatars/{user_id}-{avatar}" not in sizes:
                    problems.append(f"avatar of user {user_id} missing")
            (icon,) = conn.execute("SELECT icon FROM server_profile WHERE id = 1").fetchone()
            if icon is not None and f"{UPLOADS}/icons/{icon}" not in sizes:
                problems.append("server icon missing")
        finally:
            conn.close()
        upload_names = [n for n in sizes if n.startswith(f"{UPLOADS}/")]
        if len(upload_names) != manifest.get("upload_files"):
            problems.append(
                f"upload files: manifest says {manifest.get('upload_files')}, "
                f"archive has {len(upload_names)}"
            )
        return Verified(manifest=manifest, counts=counts, problems=problems)


# -- restore ------------------------------------------------------------------


def _drop_to_owner(path: Path) -> None:
    # The admin tool's rule: as root, write as the data directory's owner.
    from trio_server.admin import _drop_to_owner as drop

    drop(path)


def _occupied(data_dir: Path) -> list[Path]:
    return [
        p
        for p in data_dir.iterdir()
        if p.name not in IGNORED_IN_DATA_DIR and not is_staging_name(p.name)
    ]


def restore_archive(source: Path, data_dir: Path, *, force: bool = False) -> Verified:
    """Restore into ``data_dir`` (``trio.db`` and ``uploads/``). Refuses a
    non-empty directory unless ``force``; then what was there is MOVED to
    ``before-restore-<time>/`` inside it, not deleted."""
    data_dir.mkdir(parents=True, exist_ok=True)
    occupied = _occupied(data_dir)
    if occupied and not force:
        raise BackupError(
            f"{data_dir} is not empty ({', '.join(sorted(p.name for p in occupied))}); "
            "pass --force to move its contents aside"
        )
    staging = data_dir / f"{RESTORE_PREFIX}{secrets.token_hex(8)}"
    staging.mkdir(mode=0o700)
    try:
        result = verify_archive(source, extract_to=staging)
        if not result.ok:
            raise BackupError("the archive failed its check: " + "; ".join(result.problems))
        occupied = _occupied(data_dir)
        if occupied:
            aside = data_dir / time.strftime("before-restore-%Y%m%d-%H%M%S", time.gmtime())
            aside.mkdir()
            for path in occupied:
                path.rename(aside / path.name)
        (staging / DB_NAME).rename(data_dir / DB_NAME)
        uploads = staging / UPLOADS
        if uploads.is_dir():
            uploads.rename(data_dir / UPLOADS)
        else:
            (data_dir / UPLOADS).mkdir()
        return result
    finally:
        shutil.rmtree(staging, ignore_errors=True)


# -- the command line ---------------------------------------------------------


def _describe(result: Verified, out: TextIO) -> None:
    m = result.manifest
    c = result.counts
    out.write(
        f"backup of {m.get('created_at')} (server {m.get('server_version')}): "
        f"{c['users']} users, {c['channels']} channels, {c['messages']} messages, "
        f"{c['attachments']} attachments ({c['attachment_bytes']} bytes), "
        f"{m.get('upload_files')} files\n"
    )


def main(argv: Sequence[str] | None = None, out: TextIO = sys.stdout) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m trio_server.backup", description="Check or restore a Trio backup."
    )
    commands = parser.add_subparsers(dest="command", required=True)
    verify = commands.add_parser("verify", help="check an archive (nothing is written)")
    verify.add_argument("archive")
    restore = commands.add_parser("restore", help="restore an archive into a data directory")
    restore.add_argument("archive", help="the .tar file, or - to read it from stdin")
    restore.add_argument("--data-dir", required=True, help="e.g. /data")
    restore.add_argument(
        "--force", action="store_true", help="move what is in the data directory aside first"
    )
    args = parser.parse_args(argv)
    try:
        if args.command == "verify":
            result = verify_archive(Path(args.archive))
            _describe(result, out)
            for problem in result.problems:
                print(f"problem: {problem}", file=sys.stderr)
            if not result.ok:
                return 1
            out.write("ok: integrity_check passed and the counts match the manifest\n")
            return 0
        data_dir = Path(args.data_dir)
        if data_dir.is_dir():
            _drop_to_owner(data_dir)
        if args.archive == "-":
            data_dir.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(
                dir=data_dir, prefix=RESTORE_PREFIX, suffix=".tar", delete=False
            ) as tmp:
                shutil.copyfileobj(sys.stdin.buffer, tmp, CHUNK_BYTES)
                source = Path(tmp.name)
            try:
                result = restore_archive(source, data_dir, force=args.force)
            finally:
                source.unlink(missing_ok=True)
        else:
            result = restore_archive(Path(args.archive), data_dir, force=args.force)
        _describe(result, out)
        out.write(f"restored into {data_dir}; restart the server now\n")
        return 0
    except BackupError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
