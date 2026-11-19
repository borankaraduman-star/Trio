# Trio end-to-end tests

Playwright tests that drive the real web client (`web/`, built) against the
real server (`server/`), with three independent browser contexts (Ayşe,
Mehmet, Zeynep) and real WebRTC media between them.

## Requirements

- `server/.venv` with the server installed (its `python` runs the server and the admin tool).
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
   `python -m trio_server` (the server's own entry point, with production's
   uvicorn options) on a free port, with a temporary
   `TRIO_DB_PATH`/`TRIO_UPLOAD_DIR`, `TRIO_INVITE_CODE=trio-e2e-davet`,
   `TRIO_STATIC_DIR=web/dist` and an empty `TRIO_STUN_URLS` (all peers are
   on this machine; host candidates are enough). Its port and pid are kept in
   `e2e/.state/server.json`, its output in `e2e/.state/server.log`.
2. Every test starts from a fresh server (empty database, fresh rate limits)
   on the same port; the resilience tests kill (`SIGKILL`) and restart it.
   Tests therefore run serially in one worker.
3. The global teardown stops the server.

A test can start its server with extra settings (`freshServer({TRIO_USER_QUOTA_MB: '1'})`);
`admin('revoke-tokens', 'Mehmet')` runs `python -m trio_server.admin` against
the current run's database, as an operator would against the live file.

**No CSP violations, anywhere.** The app shell carries a Content-Security-Policy
(CONTRACT-V3 §8). Every page of every test reports `securitypolicyviolation`
events and CSP console errors, and the automatic `cspGuard` fixture
(`lib/trio.ts`) fails the test on any of them — the noise-suppression
worklet and wasm, blob: and object URLs and the websocket all run under it.

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
| `16-store-review` | a lost echo shows once; an unsent message in another channel (with its attachment) survives a reconnect; a reader up in history keeps their place and is offered the newest after a long drop; a visible but unfocused window counts unread and notifies; a long paste is counted like the server and refused, never cut |
| `17-devices` | a device code from Ayarlar › Hesap signs a fourth browser in as the same user (history, both devices get messages, no new member); used, expired (moved into the past in the database: the server's clock cannot be moved) and malformed codes; five live codes; signing out (confirmation, 204, the token's REST and other sockets end with 4401, the other device stays, the name stays hers, the code made first brings her back); a 401 on sign-out still clears the device |
| `18-remote-signout` | `revoke-tokens` and `remove-user` with everybody connected: REST refused at once, open pages on the join screen with the notice within the 30 s re-check, the removed user gone from members and voice, their messages kept under their name, `new-link-code` brings the revoked user back |
| `19-uploads-v3` | files of one message upload one at a time (at most one request in flight; a queued file cancelled), another device's upload in progress (429 → wait → retry), quota exceeded and a full disk (the message waits), avif inline, heic and quicktime as file rows |
| `20-limits` | the per-address and the global join limits worded with `Retry-After` and counted down, 4429 with ten sockets open, the desktop app's join screen |
| `21-invite-link` | `/#davet=<code>`: only a name to type, the fragment gone at once, the link in Ayarlar › Hesap, a wrong code from a link, the name remembered |
| `22-identity` | an avatar picked as a 1600 px JPEG with EXIF GPS, cropped in the app, stored as a 256 px WebP with no EXIF and decoded by all three in the member list, on old and new messages and in the voice room (ring around the picture); removed for everyone; HEIC, a text file and broken bytes refused in Turkish; rename live on old messages, `NAME_TAKEN` and `INVALID_NAME` worded as on joining, the left name free again; server name and icon live for all three, after a reload, with the `(n) ` title; the versions footer against `/api/health`; Yenilikler only after an update and held while a dialog is open; the cropper by touch (CDP pinch and drag) and the sections at 390 px |
| `23-identity-screenshots` | `13-avatars.png`, `14-profile-settings.png`, `14b-avatar-cropper.png` |
| `24-renegotiation-growth` | 30 camera and 15 screen-with-audio cycles on one connection: the SDP stays the same size, the last tiles decode, every pair hears; screen audio is off unless chosen |
| `25-refused-signal` | a description the server refuses (`TOO_LARGE`, forced by padding one frame in the page): the pair starts again on fresh connections, from either side, and gives up after three |
| `26-mic-lost` | the microphone track ends and cannot be reopened: the notice, nothing sent, recovery on `devicechange` and from the retry button |
| `27-ice-health` | ICE candidates dropped between two of three peers: reconnecting, then failed with the TURN hint, then healed when unblocked |
| `28-call-survives` | V4 A1: the server killed and restarted with three in voice — inbound audio bytes keep growing on every pair before, during and after, on the same RTCPeerConnection objects, then camera and screen work; a one-sided blip under 10 s (others show `reconnecting`, audio never stops); over 10 s (`voice.left`, normal rejoin); a camera held while down applies after resume; past 30 s the fallback; the banner and a reconnecting row at desktop and 390 px |
| `29-ring` | V4 A4: Çağır, the band, ringtone and notification (asserted on the WebAudio graph and a stand-in Notification), Katıl, "rahatsız etme", the ringer leaving, the server's 30 s limit, not to those already in the room; cue sounds for mute/deafen/join/leave, deafened and switched off; 390 px |
| `30-connection-test` | V4 A3: Ayarlar › Bağlantı testi with no TURN (`yapılandırılmamış`, the voice panel hint) and with a TURN entry that answers nothing (`yok veya ulaşılamıyor`), per-peer path and RTT, the microphone meter, the copied report has no token/IP/ids; 390 px. "TURN çalışıyor" needs a real TURN server: not verified here |
| `31-voice-ui-screenshots` | the voice review's peer-health dot, lost-microphone notice and "Ekran sesini de paylaş", and the V4 settings sections, with the theme at desktop and 390 px (screenshots; no overflow) |
| `32-messages` | CONTRACT-V4 B for all three: edit in place (Enter/Esc, the "(düzenlendi)" mark, up-arrow edits the last message, only the author may edit or delete); delete (gone for everybody, its file 404s, the quota comes back); reactions aggregated and toggled, names in the tooltip, a reaction re-renders only its own row, the 20-key limit as a quiet notice, a reaction far up does not move a reader; a reply's quote for everybody, a jump to an older page, the quote following the target's edit and deletion; pins newest first, jump and unpin, the 50-pin limit; a reconnect in the middle converging; the long-press sheet and picker at 390 px |
| `33-message-screenshots` | `11-reactions-reply.png`, `12-pins.png`, `15-mobile-sheet.png` (with the three avatars) |
| `34-scroll-anchor` | a scroll followed by a render in the same task (before the browser's scroll event) keeps the reader where they scrolled, at the bottom and up in history; two people reacting in bursts above, in and below the view while the reader's avatar pictures arrive late, under 6x CPU throttling, at 1280 and 390 px, move the row being read by 0 px |
| `35-message-voice-interplay` | the message family with the voice work on one screen: with the server killed and the call kept ("ses sürüyor"), a reaction and an edit fail with the family's notice (the edit rolled back) while audio keeps flowing, and both land after the resume; at 390 px the Yenilikler card stays in the top half and steps aside while a ring band is up, a long-press on a row low on the screen does not pick the sheet item under the finger, and the band, the notice and the sheet do not cover each other (`16-ring-over-sheet-390.png`, `16b-ring-band-notice-390.png`) |

## Screenshots

`tests/08-screenshots.spec.ts` writes the release screenshots to
`e2e/screenshots/` (`01-join.png` … `10-join-with-code.png`, device scale factor 2;
`09-add-device.png` is a device code in Ayarlar › Hesap, `10-join-with-code.png`
the join screen's "Zaten hesabım var"); `23-identity-screenshots` writes 13–14b
and `33-message-screenshots` 11, 12 and 15.
The chat history is typed through the UI and then re-dated in the SQLite
file (yesterday evening / the last minutes, Europe/Istanbul) so that a day
separator appears.
