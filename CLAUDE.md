# Trio

A private Discord alternative for three friends: text channels, voice rooms
(full-mesh WebRTC), screen sharing, camera, attachments. Self-hosted on
Railway. UI text is Turkish; code, comments and commit messages are English.

## Layout

| path | what | stack |
|---|---|---|
| `server/` | REST + WebSocket hub, SQLite, uploads | Python 3.12, FastAPI, aiosqlite (plain SQL) |
| `web/` | the client | Vite, React 18, TypeScript strict, plain CSS |
| `desktop/` | Electron shell that loads the client from the server's URL | Electron, electron-builder |
| `e2e/` | Playwright suite: three browsers against the real server | @playwright/test |
| `addon/` | TrioDurum, the WoW addon behind the game status (CONTRACT-V5) | Lua 5.1, no libraries |
| `deploy/` | VPS alternative (docker compose + coturn + Caddy) | |
| `design/` | brief for generated artwork | |

The wire protocol and every behaviour rule are in `CONTRACT.md` (v1),
`CONTRACT-V2.md` (attachments, camera, settings, push-to-talk, noise
suppression, desktop bridge), `CONTRACT-V3.md` (quotas, sessions, device
linking, limits), `CONTRACT-V4.md` (calls that survive a restart, ring,
connection test, messages family, identity), `CONTRACT-V5.md` (game status) and
`CONTRACT-V6-OPS.md` (the owner, backups, deleting files, the client error log),
`CONTRACT-V6-PUSH.md` (Web Push, notification preferences, the service worker), `CONTRACT-V6-MEDIA.md` (previews, gallery, voice messages, drafts), `CONTRACT-V6-VOICE.md` (share profiles, watch, volumes, gate, AFK, hotkeys, desktop version), `CONTRACT-V6-DOWNLOAD.md` (the /indir page, release checksums, signing), `CONTRACT-V7-PHONE.md` (the phone call bar, presence, the collapsible stage, settings in sections), `CONTRACT-V7-READING.md` (read state across devices, the new-messages line, Enter on touch, channel rename/delete, the device-code QR) and `CONTRACT-V8-MUSIC.md` (sharing computer sound in a voice room: the music stream, stereo Opus, capture without Trio's own sound, the title). Read the relevant one before changing either side; change
the contract in the same commit as the code.

## Production is live and auto-deploys from `main`

Railway builds the root `Dockerfile` on every push to `main` and restarts the
one container. A restart drops every voice call (presence and voice state
are in memory; clients reconnect and rejoin by themselves) — so **do not push
to `main` while people are using it without being asked to**. Work lands on
`dev`; `main` only moves at a release.

- One process, one worker, by design: the hub is in memory.
- Data lives on the Railway volume at `/data` (`trio.db`, `uploads/`).
- TURN comes from Cloudflare Realtime TURN (`TRIO_CF_TURN_KEY_ID`,
  `TRIO_CF_TURN_API_TOKEN`); without it only STUN is offered and two people
  behind strict NATs get no audio.
- The schema is created on startup with `CREATE TABLE IF NOT EXISTS`; there is
  no migration tool. A schema change must upgrade an existing database on
  boot, and needs a test that starts from the previous shape.

## Commands

```bash
# server
cd server && uv venv .venv && uv pip install -e '.[dev]'
TRIO_INVITE_CODE=test .venv/bin/python -m trio_server      # :8000
.venv/bin/pytest -q && .venv/bin/ruff check . && .venv/bin/ruff format --check .

# web (Vite on :5173, proxies /api and /ws to :8000)
cd web && npm ci && npm run dev
npm run build && npm test

# desktop
cd desktop && npm ci && npm run typecheck && xvfb-run -a npm test

# WoW addon (syntax + harness with stubbed WoW globals)
luac5.1 -p addon/TrioDurum/TrioDurum.lua && lua5.1 addon/test/harness.lua

# end to end (builds web, starts the real server itself)
cd e2e && npm ci && npm test
npx playwright test --shard=2/4     # one of CI's four shards (each spec file must pass alone)
TRIO_E2E_CI_FONTS=1 TRIO_E2E_CPU_THROTTLE=4 taskset -c 0,1 npx playwright test --shard=2/4   # like a CI runner
```

Before calling a change done: the checks of every package it touches, plus
the e2e suite when the change touches the protocol, voice or the client.
Say what they reported.

## Releasing

`.github/workflows/release.yml` is started by hand with a version; it builds
the desktop installers on Windows, macOS and Linux and creates the tag and
the GitHub release itself. Tags are not pushed from a developer machine.

```bash
gh workflow run release.yml --ref main -f version=0.2.0 -f ref=main
```

Order: merge to `dev` → CI green on `dev` → fast-forward `main` to it (this is
the deploy) → dispatch the release.

## Things that were expensive to learn

- **Never let an SDP rollback happen in Chromium.** After a rollback the
  rolled-back side never gathers ICE candidates on a new connection, and on
  an established one the remote microphone decodes but delivers silence;
  `restartIce` does not recover either. So peers take turns offering
  (`web/src/voice.ts`: the higher user id asks with `{negotiate: "request"}`
  and waits for a grant; signals from one peer are handled strictly one at a
  time). Any new reason to renegotiate must go through that same path.
- **A stopped camera or screen stops its transceiver** (`stopSenders` in
  `voice.ts`), not just `removeTrack`: otherwise every on/off cycle adds
  m-lines and the offer outgrows the server's 64 KiB signal cap after ~12. A
  negotiation the server refuses can never complete; the pair then starts
  again on fresh connections ("fresh connections" in `voice.ts`).
- **Assert on media, not on elements.** An `<audio>` element existing proves
  nothing; the e2e helpers check receiver stats and signal level.
- **The sent microphone track never changes.** Mute, push-to-talk, noise
  suppression and device switches all act on one audio graph behind a stable
  track, so none of them renegotiates.
- **The join rate limit has a global ceiling on failures** with a slow trickle
  that still reaches the code check; do not replace it with a plain global
  counter (that would be a lock-out switch for anyone who floods it).
- **A meter or detector that samples a level must cover the time between
  samples.** The speaking ring read an 11 ms analyser window every 100 ms, so
  ~88 % of the audio was never looked at; Chromium's fake microphone (a 20 ms
  beep every 500 ms) then fell between reads at most phases, for a whole test,
  and the ring of somebody plainly heard never lit (an "order-dependent" e2e
  failure that was only phase). `audio/speaking.ts` sizes the window to the
  interval. The same goes for a test that polls an instantaneous level: read
  a peak (`data-peak`), not the current frame.
- **A long-press sheet opens under the finger.** Lifting it ends the touch
  with a click on whatever sheet item is there; `lib/pressEnd.ts` swallows
  that one click. Anything new that opens on a long-press needs the same, and
  so does anything a press puts in place under the finger: the voice-message
  bar's ✕ cancelled every tap on the microphone on CI, whose fonts (no Inter,
  like a real phone's) put it there. Run the e2e suite with
  `TRIO_E2E_CI_FONTS=1` to see the layout a runner sees.
- **Uploaded files are served from the app's own origin**, so every file
  response carries `Content-Security-Policy: sandbox` and html/svg are
  download-only. The client keeps its token in `localStorage`; an XSS on the
  origin would be a permanent takeover.

## Not verified yet

Web Push (CONTRACT-V6-PUSH) has never received a real push: the e2e suite
uses a fake push service and CDP-delivered pushes; FCM, Mozilla, WNS and
Apple's service, and an iPhone home-screen app, are untested. Real microphones/cameras and the sound of noise suppression on speech, and
the speaking ring's threshold on real speech; Safari and Firefox; the desktop
installers actually running on Windows and macOS and their global
push-to-talk hook; the Cloudflare TURN call against real keys. Game status:
process detection only against fakes (no real Windows/macOS process list), the
TrioDurum addon only in the Lua harness with stubbed WoW globals (never in a
WoW client — whether the whisper-to-self reaches the chat log is the open
question in `addon/README.md`). The long-press click fix on real iOS/Android
touch (only Chromium's emulated touch here).
