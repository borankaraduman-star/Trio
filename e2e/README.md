# Trio end-to-end tests

Playwright tests that drive the real web client (`web/`, built) against the
real server (`server/`), with three independent browser contexts (Ayşe,
Mehmet, Zeynep) and real WebRTC media between them.

## Requirements

- `server/.venv` with the server installed (`uvicorn` is taken from there).
- `web/node_modules` installed (`npm ci` in `web/`).
- Chromium for Playwright 1.63 (`PLAYWRIGHT_BROWSERS_PATH` pointing at it;
  this project does not download browsers).

## Running

```bash
cd e2e
npm ci
npm test                 # = playwright test --trace off
npm run typecheck        # tsc over the tests themselves
```

What happens:

1. The global setup runs `npm run build` in `web/` and starts
   `uvicorn trio_server.main:app` on a free port, with a temporary
   `TRIO_DB_PATH`/`TRIO_UPLOAD_DIR`, `TRIO_INVITE_CODE=trio-e2e-davet`,
   `TRIO_STATIC_DIR=web/dist` and an empty `TRIO_STUN_URLS` (all peers are
   on this machine; host candidates are enough). Its port and pid are kept in
   `e2e/.state/server.json`, its output in `e2e/.state/server.log`.
2. Every test starts from a fresh server (empty database, fresh rate limits)
   on the same port; the resilience tests kill (`SIGKILL`) and restart it.
   Tests therefore run serially in one worker.
3. The global teardown stops the server.

Useful variables:

| variable | effect |
|---|---|
| `TRIO_E2E_SERVER_DIR` | run the `trio_server` package found in this directory instead of `server/` (e.g. a frozen copy while `server/` is being edited) |
| `TRIO_E2E_SKIP_BUILD=1` | do not rebuild `web/` (use the existing `web/dist`) |
| `TRIO_E2E_CONSOLE=1` | print the pages' console warnings and errors |

## Media

Chromium runs with `--use-fake-ui-for-media-stream` and
`--use-fake-device-for-media-stream`: a beeping fake microphone and a test
pattern camera. In the Chromium shipped with Playwright 1.63 (153) the
fake-UI flag also makes `getDisplayMedia` return a fake screen (1280×720
with an audio track) without any picker, so no
`--auto-select-desktop-capture-source` flag is needed (verified; adding it
changes nothing).

Audio is asserted on what is really received: for each
`remote-audio-<id>` element the test reads `getStats()` of the receiver
whose track the element plays (inbound-rtp packets and bytes must grow) and
measures the level of that stream with an `AnalyserNode` (must be above
silence). A shared screen must have `videoWidth > 0` and an advancing
`currentTime` and frame count. A page-level wrapper of
`RTCPeerConnection` (added with `addInitScript`) only records the
connections so the tests can call `getStats()`.

## Screenshots

`tests/08-screenshots.spec.ts` writes the release screenshots to
`e2e/screenshots/` (`01-join.png` … `05-mobile.png`, device scale factor 2).
The chat history is typed through the UI and then re-dated in the SQLite
file (yesterday evening / the last minutes, Europe/Istanbul) so that a day
separator appears.
