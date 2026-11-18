# Trio — contract, third layer: hardening (adds to CONTRACT.md and CONTRACT-V2.md; where they differ, this wins)

Everything here is additive: the existing web client keeps working unchanged
(same routes, same frames). New things a client MAY use are marked
**client:**. Error envelopes are as before: `{"error": {"code", "message"}}`
on REST, `{"type": "error", "code", "message"}` on the websocket.

## 1. Configuration (new and changed)

| variable | default | meaning |
|---|---|---|
| `TRIO_MAX_USERS` | **`5`** (was 10) | accounts beyond this are refused; set it to the real head count. Removed users (§3) do not count |
| `TRIO_USER_QUOTA_MB` | `1024` | bytes one user may have stored: the `SUM(size)` of all their uploads, on a message or not |
| `TRIO_DISK_RESERVE_MB` | `200` | free space the uploads volume must keep; an upload that would eat into it is refused (507) |
| `TRIO_TRUSTED_PROXY_HOPS` | `1` | reverse proxies in front of the app that append to `X-Forwarded-For`; the client address is the N-th entry from the right. `0` = ignore the header, use the socket peer |

The server is started with `python -m trio_server [--host H] [--port P] [--reload]`
(port default `$PORT`, else 8000; host default `127.0.0.1`, the image passes
`0.0.0.0`). That entry point holds every uvicorn option (§6). uvicorn no
longer rewrites the peer from proxy headers; the app reads `X-Forwarded-For`
itself.

## 2. Sessions and devices

    DELETE /api/session                       (Bearer auth)
      → 204, no body. The presented token stops working; every websocket that
        signed in with THAT token is closed with 4401. Other tokens of the same
        user (other devices) are untouched.
      401 UNAUTHORIZED (missing/invalid token, or already signed out)

    POST /api/link-codes                      (Bearer auth, no body)
      → 201 {"code": "K7QX3MZ9PA", "expires_at": "2026-11-18T21:43:26.540Z"}
      429 TOO_MANY_LINK_CODES   (5 unused, unexpired codes already exist for this user)

    POST /api/join  {"link_code": "<code>"}   (no auth; INSTEAD of {invite_code, name})
      → 200 {"token", "user": {id, name}}   — a NEW token for the EXISTING user;
        no account is created, no slot is used, no `user.joined` is broadcast
      403 INVALID_LINK_CODE   (unknown, expired, already used, or its user was removed)
      429 RATE_LIMITED        (same limiter as invite joins, §5)

- A link code: 10 characters from `23456789ABCDEFGHJKMNPQRSTUVWXYZ` (no 0/O,
  1/I/L). Valid 10 minutes, single use, at most 5 live per user. Only its
  SHA-256 is stored and it is looked up by that hash.
- Input is forgiving: case, spaces and dashes are ignored (`k7qx3-mz9pa` works),
  at most 64 characters as typed.
- When the body has a non-null `link_code`, it is the link path and
  `invite_code`/`name` are ignored. `"link_code": null` or absent = the old
  invite path (201, unchanged).
- A wrong link code counts as a failed join (§5) exactly like a wrong invite code.

**client:** logout should call `DELETE /api/session` before clearing
`localStorage` (ignore a 401). "Add a device": signed-in device calls
`POST /api/link-codes` and shows `code` and a countdown to `expires_at`; the
new device's join screen offers "I already have an account" with one field
that posts `{"link_code"}` and stores the returned token exactly like a join.

## 3. Admin tool and removed users

    python -m trio_server.admin [--db PATH] list-users
    python -m trio_server.admin [--db PATH] remove-user <name | #id>
    python -m trio_server.admin [--db PATH] revoke-tokens <name | #id>
    python -m trio_server.admin [--db PATH] new-link-code <name | #id>

`--db` defaults to `$TRIO_DB_PATH`, else `./trio.db`; the tool refuses a path
with no database. Names match as joins do (case-insensitive, Turkish I/ı).
Exit 0 ok, 1 error (message on stderr), 2 usage. Run as root against a file
owned by another user (the image), it switches to that user first, so it never
leaves root-owned `-wal`/`-shm` files the server cannot write.

- `revoke-tokens`: deletes all of the user's tokens and unused link codes
  ("sign out everywhere"). The account stays.
- `new-link-code`: prints a §2 link code for the user (same rules, 5 live max).
  For somebody who lost every device.
- `remove-user`: sets `users.removed_at`, replaces `users.name_key` with
  `#removed:<id>` (frees the name), deletes tokens and link codes. The row and
  its `name` stay: **old messages keep `author: {id: <old id>, name: <old name>}`**.
  A removed user does not count towards `TRIO_MAX_USERS`, is not in
  `ready.users`, cannot sign in, and cannot be "un-removed" by the tool.
  If somebody new joins with the same name later, they are a different user
  (a new id) and the client will show two authors with the same name, told
  apart only by id. That is the honest outcome; a client may mark authors whose
  id is not in `ready.users` as removed.

When the server notices: every REST request, new websocket and join reads the
database, so at once. An already-open websocket authenticated once, at
connect; the server re-checks the tokens of all open sockets every 30
seconds and closes revoked ones with **4401**, and then broadcasts:

    user.removed {user_id}            — server → client, new frame

for every user who has disappeared from the database's list (removed with the
tool while the server ran). **client:** drop them from the member list; their
messages stay.

## 4. Attachments (adds to V2 §2)

    POST /api/uploads
      413 QUOTA_EXCEEDED       the user's stored bytes + this file > TRIO_USER_QUOTA_MB
                               (decided up front from Content-Length when present, else while streaming)
      429 UPLOAD_IN_PROGRESS   this user already has an upload being received (one at a time per user)
      507 STORAGE_FULL         the volume's free space minus this upload would drop below
                               TRIO_DISK_RESERVE_MB, or the disk filled up during the write.
                               Never a 500; the partial file is removed.

- Files on a message count towards the quota too; there is no deletion, so the
  quota is a lifetime figure per user.
- The 24-hour orphan sweep also runs at server start.
- `message.send` may answer `error` `STORAGE_FULL` when the database cannot be
  written because the disk is full.

**client:** upload files one after another (not in parallel); word
`QUOTA_EXCEEDED`, `UPLOAD_IN_PROGRESS`, `STORAGE_FULL`.

### Content types decided by brand (replaces "mp4" in V2's sniff list)

A file starting with an ISO-BMFF `ftyp` box is typed by its major brand (then
its compatible brands):

| brands | content_type | disposition |
|---|---|---|
| `isom`, `iso2`–`iso6`, `mp41`, `mp42`, `avc1`, `dash`, `M4V `, `MSNV`, `mmp4` | `video/mp4` | inline |
| `M4A `, `M4B ` | `audio/mp4` | attachment (unchanged) |
| `qt  ` | `video/quicktime` | attachment |
| `heic`, `heix`, `heim`, `heis`, `hevc`, `hevx`, and `mif1`/`msf1` without an AVIF brand | `image/heic` | attachment |
| `avif`, `avis`, and `mif1`/`msf1` with `avif`/`avis` compatible | **`image/avif`** | **inline** |
| anything else | from the extension allowlist, else `application/octet-stream` | attachment |

**client:** render `image/avif` as an image (like png/jpeg/gif/webp).
`video/quicktime` and `image/heic` arrive as `attachment` and should be shown
as a file row, not a player or an image.

## 5. Join limits

- Per client address: 10 attempts per 10 minutes, right or wrong (unchanged).
  The address is the `TRIO_TRUSTED_PROXY_HOPS`-th entry from the right of ALL
  `X-Forwarded-For` header lines joined (a header may repeat); with fewer
  entries than that, or not an IP, the socket peer. `host:port` and `[v6]:port`
  forms are accepted; IPv6 is counted per /64.
- **Global**: at most 30 FAILED joins (wrong invite code or wrong link code,
  together) per 10 minutes across all clients. Past that, one request per 10
  seconds is still let through to the constant-time check, and only from an
  address with no failure of its own in the window. Brute force is therefore
  bounded at 30 + 60 checked guesses per 10 minutes whatever the addresses
  look like, and a friend with the correct code gets in within ~10 s during a
  flood (Retry-After says when) unless the flooder has a fresh clean address for
  every slot. Successful joins, link-code redemptions and 422 INVALID_NAME (the
  code was right) never count as failures.
- Both answer `429 RATE_LIMITED` with `Retry-After` (seconds), as before.
- The limiter's memory is bounded (10 000 addresses) and pruning is O(1) amortised.

## 6. Websocket limits

- uvicorn holds at most **133 120 bytes** (2 × the app's 66 560-byte frame
  cap) of one incoming message. A frame between the two still gets
  `error TOO_LARGE` and the socket stays open; a larger one is closed by
  uvicorn with **1009** (message too big).
- At most **10 open sockets per user**. An 11th is accepted and immediately
  closed with **4429** ("too many connections"); the existing ones (and the
  voice-bound one) are never touched. **client:** treat 4429 like any other
  drop (reconnect with backoff); stale sockets are reaped by the server's
  20 s ping within ~40 s, after which a reconnect succeeds.
- Revoked tokens close with 4401 (§2, §3).

## 7. Validation

- Any id in a query, path or frame outside SQLite's signed 64-bit range is
  refused cleanly: `GET .../messages?before=` ≥ 2^63 → `422 INVALID_REQUEST`;
  huge `channel_id`/`to` in frames → `INVALID_CHANNEL` / `BAD_REQUEST`;
  numbers with more than 4300 digits in a frame → `BAD_REQUEST`.
- A frame containing a lone surrogate anywhere (JSON `"\ud800"`), in content,
  nonce, signal data or any other string → `error BAD_REQUEST` ("frame contains
  invalid text"), nothing stored or relayed. A valid surrogate PAIR is fine.
- A REST JSON body with a lone surrogate → `422 INVALID_REQUEST`.
- None of these is a 500 / `INTERNAL` any more.

## 8. App shell headers

`index.html` (as `/`, `/index.html` and the SPA fallback) carries:

    Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval' blob:;
      worker-src 'self' blob:; connect-src 'self' ws://<host> wss://<host>;
      img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self' 'unsafe-inline';
      object-src 'none'; base-uri 'none'; frame-ancestors 'none'
    Referrer-Policy: no-referrer
    X-Content-Type-Options: nosniff
    X-Frame-Options: DENY
    Permissions-Policy: camera=(self), microphone=(self), display-capture=(self)
    Cache-Control: no-cache

`<host>` is the request's `Host` when it is a plain `host[:port]` (otherwise
only `'self'`). CSP Level 3 makes `'self'` match same-host ws/wss, but older
engines (Safari before 15.4) do not, so the own host is named explicitly —
tighter than `ws: wss:` (any host). The client must therefore load no script,
style, font or connection from another origin, use no inline `<script>`, no
`eval`; AudioWorklet modules and wasm must be same-origin files (or blob:).
Hashed assets under `/assets/` keep their own headers.

## 9. Image

- Dependencies are installed from `server/requirements.lock` (every package
  pinned with hashes, `pip install --require-hashes`), then the package with
  `--no-deps --no-build-isolation`. Regenerate with the command in the lock's
  header after changing `pyproject.toml`; a test fails when a runtime
  dependency is missing from the lock.
- The container starts as root only long enough for `trio-entrypoint` to make
  the data directories (`dirname $TRIO_DB_PATH`, `$TRIO_UPLOAD_DIR`) belong to
  the `trio` user (uid 10001), then drops to it with `setpriv` (no
  capabilities, no-new-privs). `/app` (code and client) is root's and not
  writable by the server. Started as a non-root user already, it changes
  nothing. If the volume cannot be made writable for `trio`, it logs that and
  runs as root rather than not at all.
