# Trio — contract, second layer (adds to CONTRACT.md; where they differ, this wins)

Owner decisions: web + desktop app; attachments, camera, push-to-talk and
noise suppression in the first release; hosted on Railway.

## 1. Hosting on Railway (replaces the VPS as the primary path)

- A root `Dockerfile` (Railway auto-detects it) builds web + server into one
  image. It listens on `$PORT` (default 8000), single worker.
- One Railway volume mounted at `/data`: `TRIO_DB_PATH=/data/trio.db`,
  `TRIO_UPLOAD_DIR=/data/uploads`. A Railway volume is mounted root-owned, so
  the image must work with that (run as root, or document `RAILWAY_RUN_UID=0`
  — pick one, verify against Railway's docs, and say which in the README).
- No `railway.json` (Railway's config-as-code file is deprecated on
  2026-12-01); health check path `/api/health` and the volume are set in the
  dashboard, and the README says so step by step.
- Railway has no UDP, so no coturn there. TURN comes from Cloudflare Realtime
  TURN (free tier): see §3. The docker-compose + coturn files stay under
  `deploy/` as the documented alternative for a VPS.

## 2. Attachments

New env: `TRIO_UPLOAD_DIR` (default `./uploads`), `TRIO_MAX_UPLOAD_MB` (default 25).

    POST /api/uploads   multipart/form-data, one part `file`   (Bearer auth)
      → 201 {"attachment": Attachment}
      413 FILE_TOO_LARGE (counted while streaming, never buffered whole in memory)
      422 INVALID_UPLOAD (no file, empty file, empty filename)
    GET  /api/files/{id}/{filename}      NO auth — the id is the capability
      → the bytes. 404 for an unknown id.

`Attachment` = `{id, filename, content_type, size, url}`;
`url` = `/api/files/<id>/<url-encoded filename>`.

- `id` is 32 random bytes urlsafe. The stored file is named by id only; the
  client's filename is sanitised (basename, control chars removed, max 120
  chars) and never used as a path.
- `content_type` is decided by the SERVER from the leading bytes for
  png/jpeg/gif/webp/mp4/webm/pdf, else from the extension through a small
  allowlist, else `application/octet-stream`.
- Serving: `X-Content-Type-Options: nosniff`,
  `Content-Security-Policy: sandbox; default-src 'none'`,
  `Cache-Control: private, max-age=31536000, immutable`, Range requests
  supported. `Content-Disposition: inline` only for png, jpeg, gif, webp, mp4,
  webm, mp3/ogg/wav audio and pdf; `attachment` for everything else (html and
  svg are never inline).
- `message.send` gains `attachment_ids: [id...]` (0–10). `content` may be
  empty when there is at least one attachment. Each id must have been uploaded
  by the sender and not be on a message yet, else `error` `INVALID_ATTACHMENT`
  and nothing is stored.
- `Message` gains `attachments: [Attachment...]` (empty list when none), in
  REST and websocket alike.
- An upload not attached to a message within 24 hours is deleted (swept
  opportunistically on upload; no scheduler).

Client: paperclip button, paste from clipboard and drag-and-drop onto the
chat; pending attachments shown as chips above the composer with progress and
remove; images render inline (max 400×300 box, click opens a lightbox),
video/audio get a native player, anything else a file row with name, size and
download. test ids: `btn-attach`, `file-input` (the hidden input),
`pending-attachment`, `attachment-image`, `attachment-file`.

## 3. ICE: Cloudflare TURN

New env: `TRIO_CF_TURN_KEY_ID`, `TRIO_CF_TURN_API_TOKEN`. When both are set,
`GET /api/ice` asks Cloudflare's TURN credential API for short-lived
`iceServers` (ttl 24 h) and returns them (plus the STUN urls); the answer is
cached in memory for 1 hour; on any failure it logs a warning (never the
token) and returns STUN only — the endpoint never fails. Precedence:
Cloudflare, else coturn (`TRIO_TURN_HOST`/`TRIO_TURN_SECRET`), else STUN only.
Check the exact endpoint and response shape in Cloudflare's current docs
before coding; do not trust memory.

## 4. Voice additions

- **Camera.** `voice.state` and `voice.joined` and the `ready.voice` entries
  gain `camera: bool` (client → server `voice.state` too; missing = false).
  Camera: `getUserMedia({video: {width: {ideal: 1280}, height: {ideal: 720}}})`.
  A peer can now send two video streams, so each side tells the other which is
  which: `signal.data = {"meta": {"camera": "<MediaStream id>" | null, "screen": "<MediaStream id>" | null}}`,
  sent to a peer right after its connection is created and again whenever
  either changes, BEFORE the tracks are added. A remote stream whose id is in
  neither is treated as screen. Camera tiles show in the stage beside shared
  screens. test ids: `btn-camera`, `remote-camera-<user id>`, `local-camera`.
- **Settings dialog** (`btn-settings`, in the user panel): microphone device,
  output device (where `setSinkId` exists), camera device, noise suppression
  on/off (default on), input mode `activity` | `ptt` (default activity), PTT
  key (press-to-bind, default `Backquote`). Stored in `localStorage`
  (`trio.settings`); changes apply live, including while in voice.
- **Push-to-talk.** In `ptt` mode the outgoing mic track is enabled only while
  the key is held (not while typing in an input/textarea, in the browser).
  This gating is local: `voice.state.muted` still reflects only the mute
  button. Release adds a 150 ms tail. The speaking ring reflects what is
  actually sent.
- **Noise suppression.** RNNoise in an `AudioWorklet` between the microphone
  and the peer connections (an existing, maintained npm package with the wasm
  shipped locally in the bundle — no CDN at runtime). If the worklet or wasm
  fails to load, fall back to the raw microphone silently (console warning).
  Toggling swaps the sent track with `RTCRtpSender.replaceTrack`, no
  renegotiation.

## 5. Desktop app (`desktop/`, Electron)

Electron rather than Tauri: screen capture, WebRTC and a global key hook
behave the same on Windows, macOS and Linux only on Chromium.

- First run: a small local page asks for the server URL (e.g.
  `https://trio.up.railway.app`), checks `GET <url>/api/health`, stores it,
  then loads the web client from that URL. A menu item changes it later.
- The web client detects the desktop app through a preload bridge:

      window.trioDesktop = {
        isDesktop: true,
        setPttKey(code: string | null): void,   // KeyboardEvent.code, null = stop listening
        onPtt(cb: (down: boolean) => void): () => void,   // global, works unfocused
        pickScreenSource?: never                 // picker is handled in the main process
      }

  When `window.trioDesktop` exists the client uses it for PTT instead of its
  own key listeners.
- `getDisplayMedia` works through `session.setDisplayMediaRequestHandler`
  with an in-app source picker (screens and windows, thumbnails); system audio
  loopback where the platform allows it.
- Global PTT key through a key-hook library that reports both key down and
  key up (Electron's `globalShortcut` has no key-up).
- Hardened defaults: `contextIsolation: true`, `nodeIntegration: false`,
  `sandbox: true`; navigation limited to the configured origin, external links
  open in the system browser; permission handler grants microphone, camera,
  display capture and notifications only to that origin.
- Tray icon with show/quit; closing the window hides to tray; unread count on
  the taskbar/dock badge from the page title `(n)`.
- Packaging with electron-builder: Windows (nsis), macOS (dmg, with
  microphone/camera usage descriptions), Linux (AppImage). A GitHub Actions
  workflow builds all three on a `v*` tag and attaches them to a release.
  Builds are unsigned; the README says what the OS will warn about.
