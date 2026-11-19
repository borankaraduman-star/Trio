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

The v2 features are asserted the same way (`lib/media.ts`):

- a camera or screen tile must exist once, carry the right `data-kind` and
  caption, have `videoWidth > 0` and advancing frames;
- push-to-talk and noise suppression read the RECEIVING side: the growth of
  inbound-rtp `totalAudioEnergy` per second on the receiver of that speaker's
  track (silence below 1e-6). Those two specs replace the beep with a WAV
  file (`--use-file-for-fake-audio-capture`, written to `.state/`): a
  continuous voice-like signal for PTT, white noise for RNNoise;
- the page probe also records every camera and microphone track the page
  opened (`__trioCameraTracks`, `__trioMicTracks`), to check that turning
  the camera off really releases it and which device is live.

Chromium 153 facts the specs depend on, measured here:

- `--use-fake-device-for-media-stream=device-count=N` gives N fake cameras,
  but the second one (`fake_device_1`) shows in a `<video>` and gives a
  WebRTC encoder no frames at all (0 frames encoded, in a bare loopback too);
  the settings spec therefore uses three and switches to `fake_device_2`.
- device ids change on every page load (with permissions granted through
  Playwright, persistent context or not), as Chrome does after a one-time
  permission: the client finds a chosen device again by its name.
- Concurrent Playwright clicks on ONE page share its mouse and can land on the
  same element; "two things at the same instant on one page" is clicked from
  inside the page in one task.

| spec | covers |
|---|---|
| `09-attachments` | image + file for the others, the reserved 400×300 box, oversize refused client-side, paste, drag-and-drop, attachment-only message, lightbox, download as `attachment`, after reload and from an older page |
| `10-camera` | two cameras + a screen (one peer sending both), late joiner, camera off releases the device while the screen goes on, the glare case with audio checked on every pair |
| `11-push-to-talk` | silent unless held, the 150 ms tail, typing, blur, mute wins, `voice.state.muted` untouched |
| `12-noise-suppression` | RNNoise `active` in the built client with local assets, toggling keeps the call and the sent track, blocked wasm → `unavailable` and still heard |
| `13-settings` | live microphone/camera switch, output device, PTT key binding, persistence across a reload |
| `14-resilience-media` | server killed with cameras and a screen share on: everything comes back as it was left; a camera turned off meanwhile stays off |
| `15-mobile-media` | attachments, lightbox and the settings dialog at 390 px |
| `20-renegotiation-growth` | 30 camera and 15 screen-with-audio cycles on one connection: the SDP stays the same size, the last tiles decode, every pair hears; screen audio is off unless chosen |
| `21-refused-signal` | a description the server refuses (`TOO_LARGE`, forced by padding one frame in the page): the pair starts again on fresh connections, from either side, and gives up after three |
| `22-mic-lost` | the microphone track ends and cannot be reopened: the notice, nothing sent, recovery on `devicechange` and from the retry button |
| `23-ice-health` | ICE candidates dropped between two of three peers: reconnecting, then failed with the TURN hint, then healed when unblocked |

## Screenshots

`tests/08-screenshots.spec.ts` writes the release screenshots to
`e2e/screenshots/` (`01-join.png` … `08-settings.png`, device scale factor 2).
The chat history is typed through the UI and then re-dated in the SQLite
file (yesterday evening / the last minutes, Europe/Istanbul) so that a day
separator appears.
