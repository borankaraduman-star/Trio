# Trio — contract, owner / operations layer (adds to CONTRACT.md … CONTRACT-V5.md)

Everything here is additive: a client that knows none of it keeps working,
except that a message's `attachments` may now contain a tombstone (§4) and the
owner's `ready.user` / `GET /api/me` carry one more key (§1). Error envelopes
are as before: `{"error": {"code", "message"}}`.

## 1. The owner

| variable | default | meaning |
|---|---|---|
| `TRIO_OWNER` | unset | the owner's user name, matched like a join (case-insensitive, Turkish I/ı aware). Unset: the active (not removed) user with the **lowest id**. Set to a name nobody has: **nobody** is the owner (never a silent fallback) |

Nothing is stored: the rule is applied on every request. Removing the owner
with the admin tool passes the role to the next lowest id (when unset).

- `GET /api/me` and `ready.user` carry `"is_owner": true` for the owner only;
  for everybody else the key is absent. `ready.users`, `user.joined` and
  `user.updated` never carry it.
- Every route under `/api/owner/` answers **403 `FORBIDDEN`** to a signed-in
  user who is not the owner, **401 `UNAUTHORIZED`** without a valid token (a
  removed user's tokens are gone, so 401).

### The confirm code

Destructive owner actions (§2: revoke tokens, remove a user, a link code for a
user) need the **invite code** again in the JSON body, `confirm_code`. The
client keeps its token in `localStorage`; a stolen token alone must not be
enough. It is compared in constant time and spends the join limiter
(CONTRACT-V3 §5) exactly like a join: every attempt counts against the
address's 10 per 10 minutes, a wrong code is a failed join (also towards the
global failure ceiling).

    403 INVALID_CONFIRM_CODE   missing or wrong
    429 RATE_LIMITED           the join limiter refused (Retry-After)

Restore is NOT a REST action (it replaces the database under a running
server); it is a command (§3).

## 2. Owner REST

    GET  /api/owner/overview
      → 200 {
          users: [{id, name, created_at, removed, is_owner, online, connections,
                   sessions, last_seen_at, stored_bytes, file_count}],
          counts: {messages, channels, attachments},
          storage: {uploads_bytes, upload_files, db_bytes, disk_free_bytes,
                    disk_total_bytes, user_quota_bytes, disk_reserve_bytes, max_upload_bytes},
          server: {version, started_at, uptime_seconds, python, owner_rule: "TRIO_OWNER"|"lowest_id"},
          turn: {provider: "cloudflare"|"coturn"|"none", stun: [url],
                 last_call: null | {ok, at, age_seconds, detail}},
          limits: {max_users, user_quota_bytes, disk_reserve_bytes, max_upload_bytes,
                   max_connections_per_user, trusted_proxy_hops, join_attempts_per_address,
                   join_window_seconds, join_global_failures, message_edits_per_minute,
                   reactions_per_minute},
          backup: {last: null | {at, counts, upload_files, bytes, sha256},
                   in_progress: null | {sent, total}}
        }

- `users` includes removed users (`removed: true`). `last_seen_at`: now while
  online; else when their last socket closed **since this process started**
  (null after a restart until they come and go). `stored_bytes`/`file_count`
  count only files not deleted.
- `turn` never carries a secret. `last_call` is the last Cloudflare credential
  request of this process (`detail`: the error's type and HTTP status only).
- `uploads_bytes` walks the upload directory (avatars and icons included);
  `db_bytes` is the database plus its `-wal`/`-shm`.

```
POST /api/owner/users/{id}/revoke-tokens   {"confirm_code"}
  → 200 {"user": {id, name}, "sessions_ended": n}
POST /api/owner/users/{id}/remove          {"confirm_code"}
  → 200 {"user": {id, name}, "sessions_ended": n}
  409 CANNOT_REMOVE_OWNER (the owner's own id)
POST /api/owner/users/{id}/link-code       {"confirm_code"}
  → 201 {"user": {id, name}, "code", "expires_at"}
  429 TOO_MANY_LINK_CODES
all: 404 NOT_FOUND (no such active user), 403 INVALID_CONFIRM_CODE, 429 RATE_LIMITED,
     422 INVALID_REQUEST (id out of range)
```

These run the admin tool's own functions (`admin.do_revoke_tokens`,
`do_remove_user`, `do_new_link_code`; CONTRACT-V3 §3), so their effects are
identical. Unlike the tool, the server applies them to open sockets **at once**:
revoked tokens' sockets close with **4401**, and a removed user is broadcast as
`user.removed`.

## 3. Backups

    POST /api/owner/backup-tickets
      → 201 {"ticket", "expires_at", "url": "/api/owner/backup?ticket=<ticket>"}
    GET  /api/owner/backup?ticket=<ticket>     (or with the owner's Bearer header)
      → 200 application/x-tar, Content-Length, Content-Disposition:
            attachment; filename="trio-yedek-YYYY-MM-DD-HHMM.tar"
      403 INVALID_TICKET      unknown, used or expired ticket
      403 FORBIDDEN           the ticket's user is no longer the owner
      409 BACKUP_IN_PROGRESS  another backup is being downloaded

**Tickets** let a plain browser download (`<a download>`, which cannot send a
header) fetch the archive: 32 random bytes (urlsafe), **single use**, valid
**60 seconds**, kept only as their SHA-256 in process memory (a restart forgets
them). `ticket=` values are redacted from every log line, as `token=` is.

**The archive** is an uncompressed tar (uploads are mostly already-compressed
images and video; uncompressed, its exact size is known before the first byte,
so the browser shows real progress):

    manifest.json   {"format": "trio-backup", "format_version": 1, "server_version",
                     "created_at", "counts": {users, removed_users, channels, messages,
                     attachments, attachment_bytes, tokens}, "upload_files", "upload_bytes",
                     "database": {"name", "size", "sha256"},
                     "includes": {"token_hashes": true, "link_codes": false,
                                  "rate_limits": false, "client_errors": true}, "note"}
    trio.db         a consistent snapshot (SQLite backup API; journal_mode DELETE;
                    link codes deleted; vacuumed; integrity-checked)
    uploads/...     every stored file: attachments, uploads/avatars/, uploads/icons/

- **Token hashes are kept**: a restored server keeps everybody signed in. The
  archive is therefore as sensitive as the server's disk. Link codes and
  rate-limit state are not included.
- The snapshot and the hard-linking of the upload files into a staging
  directory under the data directory happen under the database write lock
  (writes wait for a moment; reads and the hub do not), so the files match the
  snapshot even if one is deleted while the archive streams. Where a hard link
  is impossible the file is held open instead. File reads run in a thread.
- The staging directory is removed when the response ends — finished, client
  gone, or cancelled — and any staging left by a crash is removed by the next
  backup.
- When the last byte has been handed to the server, `meta.last_backup` is
  recorded (`{at, counts, upload_files, bytes, sha256}`); an aborted download
  records nothing. `overview.backup` reports it, and `in_progress` while one
  streams.

**Commands** (on the server, e.g. `railway ssh`; `docs/yedek.md` has the
owner's steps):

    python -m trio_server.backup verify <archive>
        exit 0: integrity_check ok, every count matches the manifest, every
        attachment and avatar present with the right size; 1: a problem (on stderr)
    python -m trio_server.backup restore <archive | -> --data-dir /data [--force]
        verifies first, then writes <data-dir>/trio.db and <data-dir>/uploads/.
        Refuses a data directory that is not empty (lost+found ignored) unless
        --force, which MOVES what is there into <data-dir>/before-restore-<time>/.
        Run as root, it writes as the data directory's owner. Restart the server after.

## 4. Storage and deleting a file (everybody)

    GET /api/me/storage?limit=1..100 (50)&offset=0..
      → 200 {used_bytes, quota_bytes, file_count,
             attachments: [{id, filename, content_type, size, created_at, url,
                            message: null | {id, channel_id, excerpt}}],   largest first
             has_more}

    DELETE /api/attachments/{id}
      → 200 {"storage": {used_bytes, quota_bytes, file_count}, "message": Message | null}
      403 FORBIDDEN    not the uploader
      404 NOT_FOUND    unknown, malformed or already deleted
      429 RATE_LIMITED 30 deletions per user per minute
      507 STORAGE_FULL

- The file leaves the disk and its bytes leave the quota at once
  (`attachments.deleted_at`; the V3 quota counts only files not deleted).
- A file **on a message** leaves a tombstone: in that message's `attachments`,
  at its position, `{"id", "filename", "deleted": true}` — no `content_type`,
  `size` or `url`. The message's `rev` goes up and `message.updated` is
  broadcast to everyone. A message left with no content and only tombstones
  stays. An edit to empty content is refused as before (`INVALID_MESSAGE`): a
  tombstone is not a file. A reply's excerpt no longer names a deleted file.
  `GET /api/files/{id}/…` of a deleted file is 404.
- A file **not on a message yet** goes entirely (no tombstone).

**client:** treat an attachment with `deleted: true` as "dosya silindi"; never
read its other fields.

## 5. The client error log

    POST /api/client-errors     (Bearer)  {"message", "stack"?, "version"?, "build"?,
                                           "context"?, "browser"?}   → 204
      413 PAYLOAD_TOO_LARGE (body over 4096 bytes), 422 INVALID_REQUEST (message missing
      or not a string), 429 RATE_LIMITED (10 per user per hour)
    GET    /api/owner/errors    → 200 {"errors": [{id, message, stack, context, browser,
                                   versions: ["0.4.0 (build)"…], count, first_at, last_at,
                                   user: {id, name} | null}], "distinct", "total"}   newest 50
    DELETE /api/owner/errors    → 204 (all rows)

- Deduplicated by SHA-256 of message + the top stack frame: a repeat adds to
  `count`, updates `last_at`, the reporter and the version list (at most 5).
- At most 200 rows; the least recently seen go first.
- Stored text is cleaned again on the server: URLs lose their query and
  fragment (a frame's `:line:col` is kept), `token=`/`ticket=`/`code=`/`key=`/
  `password=` values are redacted, fields are cut (message 500, stack 2048).

**client:** reports `window.onerror` and `unhandledrejection` while signed in:
the error's message and stack (≤ 2 KB), the client version and build, the
path (no query, no fragment), a browser family. Never message contents, tokens
or URLs with fragments. One report per distinct error per page load, at most
10 per load; an error raised while reporting is dropped, a failed request is
swallowed.

## 6. Tables (created lazily, `CREATE TABLE IF NOT EXISTS`)

    meta (key TEXT PRIMARY KEY, value TEXT)                -- JSON values: last_backup
    client_errors (...)                                    -- §5
    attachments.deleted_at TEXT                            -- added on boot (UPGRADE_COLUMNS)

## 7. Is the data on persistent storage?

On Railway a service without a volume writes to the container's own disk,
which every deploy throws away. At startup the server decides, for the
directory holding `TRIO_DB_PATH` (`trio_server/persistence.py`):

| signal (in order) | verdict |
|---|---|
| `TRIO_PERSISTENT_OVERRIDE` = `true` / `false` / `unknown` — **for tests only** (the e2e suite uses it to force the case below) | as given |
| `RAILWAY_VOLUME_MOUNT_PATH` covers the data directory | `true` |
| the data directory is on another device than `/` (`st_dev`) | `true` |
| a `/proc/self/mountinfo` mount point (not `/`) covers it | `true` |
| none of these, and `RAILWAY_ENVIRONMENT` (or `_NAME`) is set | `false` |
| none of these, not on Railway | `null` (unknown: nothing is shown) |

It never refuses to start; `false` is logged at ERROR. It also records in
`meta` the database's first-open time (`first_open_at`, kept for ever) and a
boot counter (`boot_count`, +1 per start).

    GET /api/health   → {"ok", "version", "persistent": true|false|null, "data_since": ISO|null}
    ready             + "persistent": true|false|null
    overview.server   + "persistent", "data_since", "boot_count"

`data_since` is public (health is unauthenticated) so that a signed-out client
can tell a server whose data was just created.

**client:** when `persistent === false`, a red band that cannot be closed, for
everybody and on the join screen: "Kalıcı disk bağlı değil: bir sonraki
güncellemede her şey silinir." Yönetim shows how to attach a volume. When a
session ends (401 / 4401) and `data_since` is under 15 minutes old, the join
screen says "Sunucu sıfırlandı, herkes yeniden katılmalı." instead of the
device-code hint. Yönetim also warns when `TRIO_OWNER` is unset (the owner is
the first to join) and when seats are free (`max_users` above the user count).
