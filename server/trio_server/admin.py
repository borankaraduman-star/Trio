"""Admin tool: ``python -m trio_server.admin <command>`` (CONTRACT-V3 §3).

Works on the SQLite file directly (``--db``, else ``TRIO_DB_PATH``, else
``./trio.db``), so it runs next to a live server: SQLite's locking makes the
two safe together. The server notices a change on its next look at the
database: at once for REST requests, new websockets and joins (every token
and link-code lookup reads the file), within 30 seconds for websockets that
are already open (it re-checks their tokens periodically and closes revoked
ones with 4401).

    list-users                 everybody, with status, sessions and storage
    remove-user <name>         sign out everywhere, free the slot and the name;
                               their messages stay, under their name
    revoke-tokens <name>       sign out everywhere (the account stays)
    new-link-code <name>       a one-time code to sign a device in as <name>

``<name>`` is matched like a join is (case-insensitive, Turkish I/ı aware);
``#<id>`` picks a user by id instead.
"""

from __future__ import annotations

import argparse
import os
import sqlite3
import sys
import time
from collections.abc import Sequence
from pathlib import Path
from typing import TextIO

from trio_server import linkcodes
from trio_server.db import (
    SCHEMA,
    UPGRADE_COLUMNS,
    removed_name_key,
    upgrade_statements,
    utc_iso,
    utc_now,
)
from trio_server.validation import clean_name, name_key


class AdminError(Exception):
    pass


def _drop_to_owner(path: Path) -> None:
    """Run as the database file's owner when started as root.

    The image's server runs as an unprivileged user. `railway ssh` and
    `docker exec` give a root shell; SQLite run as root would create the
    -wal/-shm files owned by root, which the server then could not write.
    """
    if not hasattr(os, "geteuid") or os.geteuid() != 0:
        return
    st = path.stat()
    if st.st_uid == 0:
        return
    os.setgroups([])
    os.setgid(st.st_gid)
    os.setuid(st.st_uid)


def connect(db_path: str) -> sqlite3.Connection:
    path = Path(db_path)
    if not path.is_file():
        raise AdminError(f"no database at {db_path} (set TRIO_DB_PATH or pass --db)")
    _drop_to_owner(path)
    conn = sqlite3.connect(path, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA foreign_keys=ON")
    # The same idempotent schema the server applies on boot, so the tool also
    # works on a database written by an older server.
    conn.executescript(SCHEMA)
    for table in UPGRADE_COLUMNS:
        columns = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
        for sql in upgrade_statements(table, columns):
            conn.execute(sql)
    return conn


def find_user(conn: sqlite3.Connection, who: str) -> sqlite3.Row:
    if who.startswith("#") and who[1:].isdigit():
        row = conn.execute(
            "SELECT * FROM users WHERE id = ? AND removed_at IS NULL", (int(who[1:]),)
        ).fetchone()
    else:
        name = clean_name(who)
        if name is None:
            raise AdminError("that is not a valid name")
        row = conn.execute(
            "SELECT * FROM users WHERE name_key = ? AND removed_at IS NULL", (name_key(name),)
        ).fetchone()
    if row is None:
        raise AdminError(f"no active user {who!r} (see list-users)")
    return row


def list_users(conn: sqlite3.Connection, out: TextIO) -> None:
    rows = conn.execute(
        "SELECT u.id, u.name, u.created_at, u.removed_at, "
        "(SELECT count(*) FROM tokens t WHERE t.user_id = u.id) AS sessions, "
        "(SELECT coalesce(sum(size), 0) FROM attachments a WHERE a.uploader_id = u.id) AS bytes "
        "FROM users u ORDER BY u.id"
    ).fetchall()
    out.write(f"{'id':>4}  {'name':<32}  {'status':<8}  {'sessions':>8}  {'storage':>10}  joined\n")
    for r in rows:
        status = "removed" if r["removed_at"] else "active"
        storage = f"{r['bytes'] / (1024 * 1024):.1f} MB"
        out.write(
            f"{r['id']:>4}  {r['name']:<32}  {status:<8}  {r['sessions']:>8}  "
            f"{storage:>10}  {r['created_at']}\n"
        )
    active = sum(1 for r in rows if not r["removed_at"])
    out.write(f"{active} active user(s)\n")


def _sign_out_everywhere(conn: sqlite3.Connection, user_id: int) -> int:
    count = conn.execute("DELETE FROM tokens WHERE user_id = ?", (user_id,)).rowcount
    conn.execute("DELETE FROM link_codes WHERE user_id = ?", (user_id,))
    return count


def remove_user(conn: sqlite3.Connection, who: str, out: TextIO) -> None:
    conn.execute("BEGIN IMMEDIATE")
    try:
        user = find_user(conn, who)
        # The row stays (messages point at it and show its name). Replacing
        # name_key frees the name; removed_at frees the slot.
        conn.execute(
            "UPDATE users SET removed_at = ?, name_key = ? WHERE id = ?",
            (utc_now(), removed_name_key(user["id"]), user["id"]),
        )
        sessions = _sign_out_everywhere(conn, user["id"])
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    out.write(
        f"removed {user['name']} (id {user['id']}); {sessions} session(s) ended. "
        "Their messages stay. Open connections close within 30 seconds.\n"
    )


def revoke_tokens(conn: sqlite3.Connection, who: str, out: TextIO) -> None:
    conn.execute("BEGIN IMMEDIATE")
    try:
        user = find_user(conn, who)
        sessions = _sign_out_everywhere(conn, user["id"])
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    out.write(
        f"{sessions} session(s) of {user['name']} ended; unused link codes deleted. "
        "Open connections close within 30 seconds.\n"
    )


def new_link_code(conn: sqlite3.Connection, who: str, out: TextIO, now: float | None = None) -> str:
    now = time.time() if now is None else now
    code = linkcodes.new_code()
    conn.execute("BEGIN IMMEDIATE")
    try:
        user = find_user(conn, who)
        conn.execute("DELETE FROM link_codes WHERE expires_ts <= ?", (now,))
        (live,) = conn.execute(
            "SELECT count(*) FROM link_codes WHERE user_id = ?", (user["id"],)
        ).fetchone()
        if live >= linkcodes.MAX_LIVE_PER_USER:
            raise AdminError(
                f"{user['name']} already has {live} unused codes; wait for one to expire"
            )
        expires = now + linkcodes.TTL_SECONDS
        conn.execute(
            "INSERT INTO link_codes (code_hash, user_id, created_ts, expires_ts) "
            "VALUES (?, ?, ?, ?)",
            (linkcodes.hash_code(code), user["id"], now, expires),
        )
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    out.write(
        f"link code for {user['name']}: {code}\n"
        f"single use, valid until {utc_iso(expires)} (10 minutes)\n"
    )
    return code


def main(argv: Sequence[str] | None = None, out: TextIO = sys.stdout) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m trio_server.admin", description="Manage Trio's users."
    )
    parser.add_argument(
        "--db",
        default=os.environ.get("TRIO_DB_PATH", "").strip() or "./trio.db",
        help="SQLite file (default: $TRIO_DB_PATH, else ./trio.db)",
    )
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("list-users", help="list users")
    for name, text in (
        ("remove-user", "remove a user: sign out everywhere, free the slot and the name"),
        ("revoke-tokens", "sign a user out everywhere"),
        ("new-link-code", "a one-time code that signs a device in as this user"),
    ):
        commands.add_parser(name, help=text).add_argument("name", help="user name, or #<id>")
    args = parser.parse_args(argv)

    try:
        conn = connect(args.db)
        try:
            if args.command == "list-users":
                list_users(conn, out)
            elif args.command == "remove-user":
                remove_user(conn, args.name, out)
            elif args.command == "revoke-tokens":
                revoke_tokens(conn, args.name, out)
            else:
                new_link_code(conn, args.name, out)
        finally:
            conn.close()
    except AdminError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
