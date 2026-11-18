# Trio — contract between server, web client and deploy

A private Discord alternative for ~3 friends: text channels, voice rooms,
screen sharing. Self-hosted on one small VPS. This file is the single source
of truth; server and client are written in parallel against it. Do not change
it — if something is ambiguous or wrong, pick the smallest reasonable reading
and list it under "Deviations" in your final report.

## Layout

    trio/
      CONTRACT.md
      server/     Python 3.12+, FastAPI, uvicorn, aiosqlite (plain SQL, no ORM), pytest
      web/        Vite + React 18 + TypeScript (strict), no UI framework, plain CSS
      deploy/     Dockerfile, docker-compose.yml, Caddyfile, coturn config, .env.example
      README.md   (deploy agent writes it, in Turkish)

In production ONE container serves both: FastAPI serves `/api/*`, `/ws`, and
the built client (`web/dist`) as static files with SPA fallback to
`index.html`. The static directory is `TRIO_STATIC_DIR` (unset = serve no
static files). In development Vite runs on :5173 and proxies `/api` and `/ws`
(ws: true) to `http://localhost:8000`.

UI language is Turkish. Code, comments and identifiers are English.

## Server configuration (environment)

| variable | default | meaning |
|---|---|---|
| `TRIO_INVITE_CODE` | (required; server refuses to start without it) | shared secret friends type once to join |
| `TRIO_DB_PATH` | `./trio.db` | SQLite file |
| `TRIO_MAX_USERS` | `10` | joins beyond this are refused |
| `TRIO_STATIC_DIR` | unset | built client directory |
| `TRIO_TURN_HOST` | unset | public hostname of coturn, e.g. `chat.example.com` |
| `TRIO_TURN_SECRET` | unset | coturn `static-auth-secret` |
| `TRIO_STUN_URLS` | `stun:stun.l.google.com:19302` | comma-separated |

## Data

- user: `id` (int), `name` (1–32 chars after trim, unique case-insensitively), `created_at`
- token: random 32 bytes urlsafe; only its SHA-256 is stored; no expiry
- channel: `id` (int), `name` (1–32 chars), `kind` (`"text"` | `"voice"`), `created_at`.
  On first start seed: text `genel`, voice `Sohbet`.
- message: `id` (int, increasing), `channel_id`, `author_id`, `content` (1–4000 chars after trim), `created_at`

All timestamps are ISO-8601 UTC strings with `Z`.

## REST (JSON). Auth: `Authorization: Bearer <token>` on everything except join/health

Errors are `{"error": {"code": "<UPPER_SNAKE>", "message": "..."}}`.

    GET  /api/health                         → 200 {"ok": true}
    POST /api/join  {invite_code, name}      → 201 {"token", "user": {id, name}}
         403 INVALID_INVITE · 409 NAME_TAKEN · 409 SERVER_FULL · 422 INVALID_NAME
         (constant-time compare of the code; 10 attempts / 10 min per client address → 429 RATE_LIMITED)
    GET  /api/me                             → 200 {"user": {id, name}}          401 UNAUTHORIZED
    GET  /api/channels                       → 200 {"channels": [{id, name, kind}]}
    POST /api/channels {name, kind}          → 201 {"channel": {...}}            422 INVALID_CHANNEL
         (also broadcast `channel.new` on the websocket)
    GET  /api/channels/{id}/messages?before=<message id>&limit=<1..100, default 50>
         → 200 {"messages": [Message...], "has_more": bool}   oldest first within the page
         404 NOT_FOUND for a missing or voice channel
    GET  /api/ice                            → 200 {"iceServers": [RTCIceServer...]}

`Message` = `{id, channel_id, author: {id, name}, content, created_at}`.

`/api/ice`: always the STUN urls. When `TRIO_TURN_HOST` and
`TRIO_TURN_SECRET` are set, also a TURN entry using coturn's REST-API
(use-auth-secret) scheme, valid 12 hours:
`username = "<unix expiry>:<user id>"`,
`credential = base64(HMAC-SHA1(secret, username))`,
`urls = ["turn:<host>:3478?transport=udp", "turn:<host>:3478?transport=tcp", "turns:<host>:5349?transport=tcp"]`.

## WebSocket: `GET /ws?token=<token>`

Bad token → close with code 4401. JSON text frames, each an object with
`type`. Unknown or malformed frames get an `error` frame and the connection
stays open. A user may have several connections (tabs); text events go to all
of them.

### Server → client

    ready        {user, users: [{id, name, online}], channels: [...],
                  voice: {"<channel id>": [{user_id, muted, deafened, screensharing}]}}
                 — first frame after connect
    presence     {user_id, online}            — online = at least one connection
    user.joined  {user: {id, name}}           — a new account was created
    channel.new  {channel}
    message.new  {message: Message, nonce?}   — nonce only on the sender's own connections
    typing       {channel_id, user_id}        — not echoed to the sender
    voice.peers  {channel_id, peers: [user_id...]}   — to the joiner only: who is already there
    voice.joined {channel_id, user_id, muted, deafened, screensharing}  — to everyone (incl. joiner)
    voice.left   {channel_id, user_id}        — to everyone
    voice.state  {channel_id, user_id, muted, deafened, screensharing}  — to everyone
    signal       {from: user_id, data}        — relayed verbatim
    pong         {}
    error        {code, message}

### Client → server

    message.send {channel_id, content, nonce}   — persisted, then message.new to everyone
    typing       {channel_id}
    voice.join   {channel_id, muted?, deafened?}
    voice.leave  {}
    voice.state  {muted, deafened, screensharing}
    signal       {to: user_id, data}
    ping         {}

### Voice rules (server)

- A user is in at most ONE voice channel, bound to the ONE connection that
  sent `voice.join`. Joining again (other channel or other tab) first leaves
  the old one (`voice.left`), then joins.
- That connection closing = `voice.left`.
- `signal` is relayed only when sender and `to` are in the same voice channel,
  and is delivered only to the target's voice-bound connection. Otherwise
  `error` code `NOT_IN_VOICE`. `data` is opaque, max 64 KiB per frame.
- `voice.join` on a text or missing channel → `error` `INVALID_CHANNEL`.

### Voice rules (client): full-mesh WebRTC, perfect negotiation

- On `voice.peers` the JOINER creates an `RTCPeerConnection` to each listed
  peer and adds its microphone track (which triggers the offer). Existing
  members create their `RTCPeerConnection` for the newcomer on `voice.joined`
  (for another user) and add their tracks too; glare is resolved by perfect
  negotiation.
- Perfect negotiation: the peer with the LARGER user id is polite.
- `signal.data` is `{"description": RTCSessionDescriptionInit}` or
  `{"candidate": RTCIceCandidateInit | null}`.
- Microphone: `getUserMedia({audio: {echoCancellation, noiseSuppression, autoGainControl all true}})`.
  Mute = `track.enabled = false` + `voice.state`. Deafen = mute remote audio
  elements (and implies muted) + `voice.state`.
- Screen share: `getDisplayMedia({video: true, audio: true})`; tracks are
  added to every peer connection (renegotiation), removed on stop or when the
  browser's own "stop sharing" fires (`track.onended`); `voice.state`
  `screensharing` follows. A remote video track is shown in a stage area above
  the chat; clicking it toggles fullscreen.
- `voice.left` for a peer or leaving: close that connection, drop its media.
- ICE servers from `GET /api/ice`, fetched at each voice join.
- Speaking indicator: local `AudioContext` + `AnalyserNode` per audio stream
  (own mic and each remote); purely client-side.

## Client behaviour

- No token → join screen: name + invite code. Token and user in `localStorage` (`trio.token`).
  A 401 from `/api/me` or close code 4401 clears it and shows the join screen.
- Layout (dark, Discord-like, responsive down to a phone width):
  left sidebar = text channels, voice channels with their participants
  (mute/deafen/screen icons, speaking ring) and a "+" to add a channel; at its
  bottom the user panel (name, mic toggle, deafen toggle, and — while in voice
  — screen-share toggle and hang-up). Centre = message list with infinite
  scroll upwards (`before=`), day separators, grouped consecutive messages by
  the same author, composer (Enter sends, Shift+Enter newline), typing line.
  Right = member list with online dots (hidden on narrow screens).
- URLs in messages are linkified (`target=_blank rel="noopener noreferrer"`);
  message content is rendered as TEXT, never as HTML.
- Optimistic send with `nonce`; reconciled on `message.new`.
- WebSocket auto-reconnect with backoff (1 s → 15 s cap) and a `ping` every
  25 s; after reconnect, state is rebuilt from `ready`, the open channel's
  latest page is refetched, and if the user was in voice the client rejoins.
- Unread dot on text channels with messages newer than last viewed (in memory
  + `localStorage`). Tab title shows `(n)` unread count. Optional browser
  Notification for messages while the tab is hidden (ask permission from a
  button in the user panel, never on load).
- Stable `data-testid`s for end-to-end tests:
  `join-name`, `join-code`, `join-submit`, `channel-<id>` (both kinds),
  `composer`, `message` (each message row), `voice-user-<user id>` (participant
  row under a voice channel), `btn-mute`, `btn-deafen`, `btn-screen`,
  `btn-hangup`, `remote-video` (a shared screen), `member-<user id>`.
- Every remote peer's audio plays through an `<audio autoplay>` element with
  `data-testid="remote-audio-<user id>"`.
