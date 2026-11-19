# Trio — contract, fourth layer (adds to v1–v3; where they differ, this wins)

Chosen from a four-lens product council (chat/social, voice/desktop,
mobile/ops, "only because it is ours"). Everything here is additive on the
wire: a client that predates it keeps working, and a new client must work
against a server that predates it for the length of one deploy.

Three parts, independent enough to be built in parallel:
**A** voice survives a signalling drop, versions, self-test, calling friends
into voice; **B** the message family (edit, delete, reactions, reply, pin);
**C** identity (avatars, server name).

---

## A1. A voice call survives a signalling drop

Media is peer to peer; the server only relays signalling. Today the client
closes every peer connection when the websocket drops, so each deploy cuts the
call. New rule:

- When the websocket drops while in voice, the client KEEPS its peer
  connections, tracks and audio elements, shows a thin banner
  ("Sunucuya yeniden bağlanılıyor… ses sürüyor"), and holds any action that
  needs signalling (camera, screen share, device changes that renegotiate,
  ICE restart) — the buttons show a waiting state and the action runs after
  resume, or is dropped with a notice after 30 s.
- On reconnect the client sends `voice.join {channel_id, muted, deafened,
  camera, screensharing, resume: true}`.
- Server: a `voice.join` with `resume: true` is an ordinary join (it has no
  memory of the call after a restart) and broadcasts `voice.joined` with
  `resumed: true`; `voice.peers` to the joiner carries `resumed: true` too.
- A client that receives `voice.joined {resumed: true}` for a peer it ALREADY
  has a live connection to (connectionState `connected` or `connecting`) keeps
  that connection and does not create a new one. The joiner, on `voice.peers
  {resumed: true}`, keeps live connections to listed peers, creates
  connections only to listed peers it has none for, and closes connections to
  peers not listed.
- Turn-taking state (CLAUDE.md, "never let an SDP rollback happen") is reset
  per kept peer on resume: no offer is in flight across a drop; a negotiation
  that was pending when the socket dropped is abandoned on both sides
  (rollback is NOT used — if a side is in `have-local-offer` when the socket
  comes back, that peer connection is closed and recreated; this is the one
  case where a kept connection is replaced).
- If the socket is not back within 30 s, the client falls back to today's
  behaviour (close everything, rejoin on reconnect).
- If only ONE side dropped (its network blipped; the server and the others
  stayed), the server has already broadcast `voice.left` for it: the others
  close that peer as today. The resuming side then joins normally. (Keeping
  the call through a one-sided blip would need the server to delay
  `voice.left`; add a 10 s grace: the server marks the member `reconnecting`
  — broadcast `voice.state {…, reconnecting: true}` — and only broadcasts
  `voice.left` if the user's voice-bound connection has not been replaced by a
  `voice.join {resume: true}` within 10 s. During the grace the others keep
  the peer connection and show the participant dimmed.)

### A1 on the wire, as the server implements it

    client → server   voice.join  {channel_id, muted?, deafened?, camera?, screensharing?, resume?}
    server → joiner   voice.peers {channel_id, peers: [user_id], reconnecting: [user_id], resumed}
    server → everyone voice.joined {channel_id, user_id, muted, deafened, screensharing, camera,
                                    reconnecting, resumed}
    server → everyone voice.state  {channel_id, user_id, muted, deafened, screensharing, camera,
                                    reconnecting}
    ready.voice["<channel id>"]: [{user_id, muted, deafened, screensharing, camera, reconnecting}]

- `screensharing`, `resume` on `voice.join` are booleans, default false; any
  other type is `error BAD_REQUEST`. `resumed` in `voice.peers`/`voice.joined`
  is exactly the request's `resume` (always present, false for an ordinary
  join). `reconnecting` is always present, false except during a grace.
- **The grace.** When the voice-bound connection of a member closes by itself
  (network, tab closed, server-side send queue overflow) the member stays in
  the room with `reconnecting: true`, announced by one `voice.state`; flags are
  kept. `voice.left` follows only when 10 s pass without the grace ending.
  A connection closed BY the server (logout `DELETE /api/session`, a revoked
  token, a removed user) gets no grace: `voice.left` at once.
- The grace ends early:
  - `voice.join {channel_id: <the same channel>, resume: true}` from ANY
    connection of that user takes the membership over: no `voice.left`; the
    joiner gets `voice.peers {resumed: true}` and everyone `voice.joined
    {resumed: true, reconnecting: false}` with the flags from the new join.
  - Any other `voice.join` (another channel, or `resume` absent/false) is the
    ordinary rule: `voice.left` for the old membership, then the join.
  - `voice.leave` from any of the user's connections: `voice.left` at once.
- During the grace the member has no voice-bound connection, so they are
  unreachable: a `signal` to them is `error NOT_IN_VOICE` (as for somebody not
  in voice), `voice.state` from their other tabs is `NOT_IN_VOICE`, and they
  cannot `voice.ring`. They ARE still listed (`ready.voice`, and in
  `voice.peers.reconnecting` of a newcomer, not in `peers`): a newcomer must not
  connect to them; when they resume, the newcomer receives `voice.joined
  {resumed: true}` for a peer it has no connection to and connects as on any
  `voice.joined`.
- A resume after the grace ran out, after a server restart, or by a user who
  was never in voice is an ordinary join (with `resumed: true` echoed).
- Presence is independent: the last socket closing still broadcasts
  `presence {online: false}` while the member is in the grace.
- **`session`** (added with the client, round 3): `voice.join` may carry
  `session`, a string of 1–64 characters the client picks at random for one
  call and repeats on every resume of it (anything else → `BAD_REQUEST`). The
  server keeps it on the membership and shows it only to the member
  themselves: their own entry in `ready.voice` carries `session`. A `resume`
  whose `session` equals the current membership's takes that membership over
  like a resume inside the grace (no `voice.left`, `voice.joined {resumed:
  true}`) even if the old connection is still open — the client saw its socket
  die before the server did (a half-open TCP connection can look alive to the
  server for tens of seconds). The old connection closing later starts no
  grace. A resume with a different `session` (another tab or device of the
  same user took the place) stays an ordinary join. The client uses its own
  `ready.voice` entry to tell the two apart before it resumes: listed with
  another `session` and not `reconnecting` → the call moved elsewhere, and
  this tab stops without taking it back.

e2e: kill and restart the server with three people in voice — receiver stats
show audio never stopped on any pair (bytes keep increasing across the
restart), and afterwards camera/screen toggles work.

## A2. Versions

- Build: the web bundle embeds `__TRIO_VERSION__` (package.json version) and
  `__TRIO_BUILD__` (short commit or build time). `GET /api/health` gains
  `{"ok": true, "version": "<server version>"}`; `ready` gains
  `server_version`.
  *Server, as built:* the version is the `[project] version` of
  `server/pyproject.toml` (read from the installed package's metadata; from
  the file itself when run uninstalled from a source tree), e.g. `"0.2.0"`.
  When neither can be read it is the string `"unknown"`. It is a plain string:
  compare it for equality, do not parse it. `/api/health` needs no token.
- Settings footer shows "Trio <version> (<build>)".
- The reload-on-new-build check (already shipped) stays the mechanism that
  moves a stale tab; after such a reload — and on the first open after an
  update — a small "Yenilikler" card lists the entries of `web/src/changelog.ts`
  (Turkish, newest first, each with a version) newer than the version this
  device last acknowledged (`localStorage` `trio.seenVersion`).

## A3. Connection self-test (Ayarlar › Bağlantı testi)

All client-side. Shows: microphone level meter; "kendini duy" loopback toggle;
TURN status from a throwaway `RTCPeerConnection` built with `/api/ice`
(`relay candidate received` → "TURN çalışıyor"; none within 5 s →
"TURN yok veya ulaşılamıyor"; no TURN server in the list → "TURN
yapılandırılmamış"); while in voice, per peer: connection type (doğrudan /
aktarma) from the selected candidate pair, round-trip time, inbound packet
loss; a "Raporu kopyala" button producing plain text with no token, no IP
addresses and no names beyond the three display names. When the ICE list has
no TURN server, a quiet persistent hint appears in the voice panel for
everyone ("TURN ayarlı değil: bazı ağlarda ses bağlanmayabilir").

## A4. Calling friends into voice

    client → server   voice.ring {channel_id}
    server → others   voice.ring {channel_id, from: user_id}

- Only from a user who is in that voice channel; at most one per user per
  30 s (`error` `RATE_LIMITED` otherwise); delivered to every online user not
  already in that channel.
  *Server, as built:* `channel_id` missing, not an integer, unknown or a text
  channel → `error INVALID_CHANNEL`; the user not in THAT voice channel (or in
  its reconnect grace) → `error NOT_IN_VOICE`; any of the ringer's connections
  may send it. Over the limit → `error RATE_LIMITED` (a refused ring does not
  restart the 30 s). Delivered to every connection of every online user not
  listed in the channel (members in their grace count as listed); never to the
  ringer; nothing is sent back on success and nothing is kept for offline
  users.
  *Added with the client (round 3):* every error answering a `voice.ring`
  carries `request: "voice.ring"` (a `NOT_IN_VOICE` may otherwise answer a
  signal sent to a member in their grace, and the client must not show the
  ring's wording for that).
- Receiver: a ringtone (short, looped up to 20 s), a band "X seni <kanal>
  odasına çağırıyor — Katıl / Kapat", and a browser Notification when the page
  is not being viewed. Deafened or "rahatsız etme" (a new local setting) →
  band only, no sound.
- Cue sounds (local, small bundled files, one master "Sesler" volume + off
  switch in settings): self mute/unmute, self deafen/undeafen, someone joined
  my room, someone left my room, ring. No sound for my own join echo.
- "X ses odasına girdi": when a room goes from empty to one person, users who
  are online but not viewing the app get a Notification (same permission as
  messages); no sound if "rahatsız etme".

---

## B. The message family

One broadcast for every later change to a message:

    server → everyone   message.updated {message: Message}
    server → everyone   message.deleted {channel_id, message_id}

`Message` gains (all optional/empty by default so old clients ignore them):
`edited_at` (ISO or null), `reply_to` (`{id, author: {id, name}, excerpt}` or
null — excerpt = first 140 chars of the target's content, or
"📎 <filename>" for an attachment-only message, resolved by the server at
read time; if the target was deleted: `{id, deleted: true}`),
`reactions` (`[{key, count, user_ids}]`, ordered by first use),
`pinned_at`, `pinned_by` (or null).

    PATCH  /api/messages/{id}        {content}          author only, any age
           → 200 {message}   422 INVALID_MESSAGE   403 FORBIDDEN   404
           (attachments cannot be changed; content may become empty only if
            attachments remain)
    DELETE /api/messages/{id}                            author only
           → 204; the row is removed, its attachments' files are deleted from
           disk and the bytes return to the uploader's quota; reactions and
           pin go with it; replies to it show "silinmiş mesaj".
    PUT    /api/messages/{id}/reactions/{key}            anyone → 200 {message}
    DELETE /api/messages/{id}/reactions/{key}            own reaction → 200 {message}
    PUT    /api/messages/{id}/pin                        anyone → 200 {message}
    DELETE /api/messages/{id}/pin                        anyone → 200 {message}
    GET    /api/channels/{id}/pins                       → 200 {messages: [...]} newest pin first

- A reaction `key` is a free string, 1–64 bytes, URL-encoded in the path:
  either one emoji grapheme cluster or `:name:` (reserved for custom emoji,
  a later layer — the server stores any key matching `^:[a-z0-9_]{1,32}:$`
  without knowing the emoji). At most 20 distinct keys per message
  (`409 REACTION_LIMIT`). Idempotent.
- Reply: `message.send` gains `reply_to: <message id>` (must be in the same
  channel, else `error` `INVALID_REPLY`).
- At most 50 pins per channel (`409 PIN_LIMIT`).
- Rate limits per user: 30 edits/deletes and 120 reaction changes per minute
  (`429 RATE_LIMITED`).
- Schema: new tables/columns created on startup; a database from v3 upgrades
  on boot (test from the previous shape — CLAUDE.md).
- History pages include all the new fields.

### B on the wire, as the server implements it

`Message` (REST pages, `GET /pins`, `message.new`, `message.updated`, every
REST answer below) is now:

    {id, channel_id, author: {id, name, avatar_url}, content, created_at,
     attachments: [Attachment], edited_at, reply_to, reactions, pinned_at,
     pinned_by, rev}

- `edited_at`: ISO time of the last edit that changed the content, else null.
- `reply_to`: null, or `{id, author: {id, name}, excerpt}`, or `{id, deleted:
  true}` when the target no longer exists. `excerpt` is the target's CURRENT
  content cut to its first 140 code points (not graphemes, not bytes); when
  the content is empty, `"📎 " + <first attachment's filename>`. It is resolved
  whenever a message is serialised; the server sends NO `message.updated` for
  replies when their target is edited or deleted — a client updates the quotes
  it shows from the `message.updated`/`message.deleted` of the target itself.
- `reactions`: `[{key, count, user_ids}]`; `count == len(user_ids)`; keys are
  ordered by each key's earliest REMAINING reaction (so a key whose first
  reactor takes theirs back may move behind a later key), `user_ids` by when
  each reacted.
- `pinned_at`: ISO or null; `pinned_by`: the pinner's user **id** (an int, as
  in `user_ids`), or null.
- `rev`: an integer, 0 at creation, +1 on every change (edit that changed the
  content, reaction added/removed, pin/unpin). A client keeps, per message,
  the copy with the highest `rev` and drops anything older, whichever way it
  arrived. A no-op (same content, a reaction or pin already there or not
  there) changes nothing: same `rev`, no broadcast, 200 with the current
  message.

Ordering: each change is committed and its `message.updated` /
`message.deleted` is queued to EVERY socket — the actor's own included, with
no nonce — before the HTTP response is written. Changes to messages leave on
the websocket in the order they were made. The HTTP response and the
broadcast may reach the actor's client in either order (different
connections): use `rev`, or ignore the REST body and wait for the broadcast.
For a delete, the 204 carries no body; `message.deleted` is the only signal.

Requests and errors (all REST errors are the usual envelope):

    PATCH  /api/messages/{id} {content}
           422 INVALID_MESSAGE   content not a string, contains NUL, over 4000
                                 characters after trim, or empty after trim while
                                 the message has no attachments
           422 INVALID_REQUEST   body not a JSON object, or contains a lone surrogate
           413 PAYLOAD_TOO_LARGE body over 64 KiB
    DELETE /api/messages/{id}
    PUT|DELETE /api/messages/{id}/reactions/{key}
           422 INVALID_REACTION  key is not one emoji and not :name: (see below)
           409 REACTION_LIMIT    adding a 21st distinct key (an existing key may
                                 still gain people)
    PUT|DELETE /api/messages/{id}/pin
           409 PIN_LIMIT         a 51st pin in the channel
    GET    /api/channels/{id}/pins  → {messages} (newest pin first, ≤ 50)
           404 NOT_FOUND for a missing or voice channel
    every route: 401 UNAUTHORIZED; 404 NOT_FOUND for an unknown message id;
           403 FORBIDDEN for edit/delete by somebody else; 422 INVALID_REQUEST
           for an id that is not 1..2^63-1; 429 RATE_LIMITED; 507 STORAGE_FULL
           when the database cannot be written.

- Rate limits are per user per sliding 60 s, checked before anything else
  (a refused, invalid or no-op request still counts): **30** edits, deletes,
  pins and unpins together; **120** reaction adds and removes together. Over
  it: `429 RATE_LIMITED` (no Retry-After).
- A deleted message: its row, reactions, pin and attachment rows go in one
  transaction; the files are then unlinked; at start-up the server removes any
  file in the upload directory whose attachment row is gone (what a crash
  between the two leaves). The bytes stop counting towards the uploader's
  quota at once (V3 §4's quota is no longer a lifetime figure). Any message id
  may be deleted by its author, at any age.
- Reaction keys: either `:name:` with 1-32 of `a-z 0-9 _` (exactly; no
  uppercase, no newline), or ONE emoji: a pictographic character (Unicode
  `Extended_Pictographic`, including not-yet-assigned code points there) with
  optional VS15/VS16 and one optional skin-tone modifier; up to 10 such
  elements joined by ZWJ; a pair of regional indicators (a flag); a keycap
  (`0-9 # *`, optional VS16, U+20E3); or a tag-sequence flag (🏴 + tags +
  CANCEL TAG). At most 64 UTF-8 bytes. Keys are compared byte for byte, no
  normalisation: `❤` and `❤️` are two keys — **send the fully qualified form
  (with VS16) your picker shows.** In the URL the key is percent-encoded UTF-8
  (`encodeURIComponent`).
- `message.send {…, reply_to: <message id> | null}`: absent or null = not a
  reply; not an integer → `error BAD_REQUEST`; no such message, or one in
  another channel → `error INVALID_REPLY`, nothing stored. A deleted message
  cannot be replied to (it no longer exists).
- Nonce retries (V3 §10, `message.send` de-duplication): a retry answers the
  sender with the message as it is NOW (re-read by id, so with its edits,
  reactions and pin), not as first stored; if it has been deleted meanwhile,
  the sender's connections get `message.deleted {channel_id, message_id,
  nonce}` instead. `reply_to` of a retry is ignored like the rest of the
  frame.

Client: hover/long-press actions on a message (tepki, yanıtla, düzenle, sil,
sabitle); edit in place (Esc cancels, Enter saves, "düzenlendi" mark); delete
asks once; a small emoji picker (a built-in set of ~80 common emoji grouped,
recent first — no third-party picker service); reaction chips under the
message, mine highlighted, tooltip lists names; quoted reply preview above the
message, click scrolls to the original (loading older pages if needed);
"Sabitlenenler" panel from the channel header. Up-arrow in an empty composer
edits my last message. Works at 390 px (long-press sheet). The message row
must not re-layout the scroll position when reactions arrive.

---

## C. Identity

- `User` gains `avatar_url` (or null). `PUT /api/me/avatar` multipart `file`
  (png/jpeg/webp, ≤ 2 MB; the CLIENT crops to a square and scales to 256 px
  before upload; the server verifies type and dimensions ≤ 512 px and
  re-serves it from `/api/avatars/<user id>/<hash>.<ext>`, no auth, immutable
  caching, `Content-Security-Policy: sandbox`) → 200 `{user}`;
  `DELETE /api/me/avatar` → 200 `{user}`. Avatars do not count toward the
  upload quota. Broadcast `user.updated {user}` to everyone; `ready.users` and
  message authors carry `avatar_url`.
- `PATCH /api/me {name}` renames (same validation and uniqueness as join;
  30 days of old messages need no rewrite — authors are joined by id) →
  `user.updated`.
- Server profile: `GET /api/server` → `{name, icon_url}`; `PATCH /api/server
  {name}` and `PUT /api/server/icon` by any member (three friends; no roles) →
  broadcast `server.updated {server}`; `ready` gains `server`. The name shows
  in the sidebar header next to the brand mark and in the page title.
- Client: avatars wherever initials are shown today (messages, members, voice
  participants with the speaking ring around the avatar, stage tiles when the
  camera is off); initials remain the fallback.

### C on the wire, as the server implements it

`User` is `{id, name, avatar_url}` everywhere a user is sent: `POST /api/join`,
`GET /api/me`, `ready.user`, `ready.users[]` (plus `online`), `user.joined`,
`user.updated`, message `author`. (`reply_to.author` stays `{id, name}`.)
`avatar_url` is null or `/api/avatars/<user id>/<32 hex>.<png|jpg|webp>`; the
hex is the start of the file's SHA-256, so a URL is never reused for other
bytes. A removed user's messages keep their author's `avatar_url`.

    PUT    /api/me/avatar     multipart, one part `file`  → 200 {user}
    DELETE /api/me/avatar                                  → 200 {user}  (also with none set)
    PATCH  /api/me            {name}                       → 200 {user}
    GET    /api/server                                     → 200 {server: {name, icon_url}}
    PATCH  /api/server        {name}                       → 200 {server}
    PUT    /api/server/icon   multipart, one part `file`  → 200 {server}
    DELETE /api/server/icon                                → 200 {server}
    GET    /api/avatars/<user id>/<hash>.<ext>             no auth
    GET    /api/server/icon/<hash>.<ext>                   no auth

Note `GET /api/server` answers `{server: {...}}` (an envelope like `{user}`),
needs a token like everything but join/health, and the default name is
`"Trio"`. `icon_url` is null or `/api/server/icon/<32 hex>.<ext>`.

- Image rules (avatar and icon alike): at most 2 MiB (`413 FILE_TOO_LARGE`,
  counted while streaming); the server reads the bytes, never the part's
  filename or Content-Type: a well-formed PNG, baseline/progressive JPEG or
  still WebP (VP8, VP8L, or VP8X without animation), each side 1–512 px, else
  `422 INVALID_IMAGE`. Not square is accepted (the client crops). The bytes
  are served exactly as uploaded (no re-encoding, so no metadata is removed:
  the client's canvas re-encode is what strips EXIF). Missing `file` part /
  not multipart: `422 INVALID_UPLOAD`; disk full: `507 STORAGE_FULL`.
- Serving: `Content-Type` from the verified type, `Content-Disposition:
  inline`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy:
  sandbox; default-src 'none'`, `Cache-Control: public, max-age=31536000,
  immutable`. Any other path, an old (replaced) file, or another user's id
  with somebody's hash: `404 NOT_FOUND`.
- Uploading the identical file again changes nothing and broadcasts nothing;
  a different file replaces the old one (the old URL 404s at once). Avatars
  and the icon do not count towards `TRIO_USER_QUOTA_MB`.
- Names: `PATCH /api/me` and `PATCH /api/server` use the join's rules
  (`clean_name`: 1–32 characters after trim, no control/format characters):
  `422 INVALID_NAME`; a user name held by another user (case-insensitive, the
  Turkish I/ı rule) → `409 NAME_TAKEN`; changing the case of one's own name is
  allowed. The name a user leaves becomes free for a newcomer. An unchanged
  name: 200, no broadcast.
- Broadcasts (to every socket, the actor's included, queued before the
  response): `user.updated {user}` after a rename or avatar change;
  `server.updated {server}` after a name or icon change. `ready` gains
  `server: {name, icon_url}`.
- Rate limit: 10 profile changes (rename, avatar put/delete, server name,
  icon put/delete together) per user per sliding minute → `429 RATE_LIMITED`.

### New error codes and limits (server)

| where | code | when |
|---|---|---|
| ws `voice.join` | `BAD_REQUEST` | `resume` / `screensharing` not a boolean |
| ws `voice.ring` | `INVALID_CHANNEL`, `NOT_IN_VOICE`, `RATE_LIMITED` | see A4 |
| ws `message.send` | `INVALID_REPLY`; `BAD_REQUEST` for a non-integer `reply_to` | see B |
| REST message family | `403 FORBIDDEN`, `404 NOT_FOUND`, `409 REACTION_LIMIT`, `409 PIN_LIMIT`, `422 INVALID_MESSAGE`, `422 INVALID_REACTION`, `429 RATE_LIMITED` | see B |
| REST identity | `409 NAME_TAKEN`, `413 FILE_TOO_LARGE`, `422 INVALID_IMAGE`, `422 INVALID_NAME`, `422 INVALID_UPLOAD`, `429 RATE_LIMITED`, `507 STORAGE_FULL` | see C |

| limit | value |
|---|---|
| reconnect grace | 10 s |
| `voice.ring` | 1 per user per 30 s |
| edits + deletes + pins/unpins | 30 per user per minute |
| reaction adds + removes | 120 per user per minute |
| distinct reaction keys per message | 20 |
| reaction key | 1–64 UTF-8 bytes; ZWJ sequences of at most 10 elements |
| pins per channel | 50 |
| reply excerpt | 140 code points |
| edit body | 64 KiB |
| avatar / icon file | 2 MiB, 1–512 px a side |
| profile changes | 10 per user per minute |
