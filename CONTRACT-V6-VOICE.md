# Trio — contract, voice evenings (adds to v1–v5; where they differ, this wins)

Long evenings in a voice room: screen-share profiles, not encoding for
somebody who is not watching, per-person volume, an input gate, AFK, global
mute/deafen keys, and the room's people under the stage. Voice stays a full
mesh between three peers with no media server, so nearly all of it is
client-side. On the wire it is additive: a client or server that predates it
keeps working.

The rules of CLAUDE.md hold throughout and are what shaped the design:
**nothing here renegotiates** (profiles, pausing a viewer and the gate act on
sender parameters, the capture or the microphone graph — never on the session
description), **the sent microphone track never changes** (the gate is one
more node in the one graph), and the e2e specs (50–54) assert on media
statistics, not on elements.

---

## 1. Screen-share profiles

Chosen from the caret beside the share button (`btn-share-menu`) before or
during a share, or from the chip on one's own screen tile (`share-chip`).
Remembered (`localStorage` `trio.voice6`, `shareProfile` / `shareQuality`).

| profile | `contentHint` | capture (`applyConstraints`, as `max`) | `maxFramerate` | `degradationPreference` |
|---|---|---|---|---|
| Oyun | `motion` | 60 fps; 1920×1080 at Yüksek, else 1280×720 | 60 | `maintain-framerate` |
| Metin | `detail` | 15 fps; 3840×2160 (= the source's own size) | 15 | `maintain-resolution` |
| Film (default) | `motion` | 30 fps; 1920×1080 | 30 | `balanced` |

"Aktarım" sets `maxBitrate` PER VIEWER: Düşük 1.5 Mbps, Orta 3 Mbps (default),
Yüksek 6 Mbps. In a mesh each viewer is its own encode and upload, so the menu
shows `N izleyici × R ≈ total` (N = the people watching while sharing, else the
others in the room) and warns when the measured upload looks short: any
watching peer's selected candidate pair reports `availableOutgoingBitrate`
below the per-viewer rate, or (all reported) their sum is below the total.

- Metin's "full resolution" is an explicit 4K ceiling: with no width/height
  in the constraints Chromium kept the size an earlier profile had capped
  (measured: 1280×720 after Oyun/Orta on a 1920×1080 source).
- `setParameters` writes are queued per peer; a second write while one is in
  flight on the same sender is refused by Chromium (stale `getParameters`
  transaction), which left old values in place when two choices came quickly.
- Encodings that do not exist yet (before the first negotiation) are filled in
  when the connection is next `stable`.

## 2. "İzlemeyi bırak": not encoding for somebody who is not watching

A viewer hides a remote screen tile (`btn-unwatch-<id>`); it leaves the stage
and becomes a chip under it with "İzle" (`btn-watch-<id>`). The viewer tells
the sharer over the existing opaque `signal.data` relay, a new client-to-client
form:

    {"watch": {"stream": "<MediaStream id>" | "screen", "on": bool}}

- `stream` is the id from the sharer's `meta.screen` ("screen" when the viewer
  does not know it yet). A `watch` for another stream id (an older share) is
  ignored; a NEW share (new id) is watched by everybody again.
- Handled in the per-peer serial signal queue, like `meta`; it never touches
  the turn-taking, the `reset` forms or `meta`. Stamped with the pair epoch `g`
  like every signal. A client that predates it ignores it (it parses as none
  of the known forms).
- The sharer sets `encodings[*].active = false` on that peer's screen senders
  (video and, if shared, audio) and back to `true` on "İzle": the encoder
  restarts with a keyframe. Measured under the fake capture: bytes to the
  hidden viewer stop completely while the other's keep growing, and frames
  decode again ~0.2 s after "İzle".
- On a fresh connection (a reset) the viewer's hidden state is re-sent when
  the sharer's `meta` arrives.
- The sharer sees who watches: on the local tile (`local-watchers`) and in the
  menu (`share-watchers`).

## 3. Per-person volume

Right-click, long-press (the ending click is swallowed, `lib/pressEnd.ts`) or
Enter/the menu key on somebody's row in my voice room opens their sheet
(`volume-sheet`): "Ses" 0–200 % and, when their shared screen carries sound,
"Yayın sesi" 0–200 %; "Sıfırla" (this person) and "Herkes için sıfırla".
Local only, remembered per user id (`trio.voice6.volumes`).

- **0–100 %: the media element's own `volume`.** This is the path every remote
  microphone already took, and the one Chromium's echo canceller uses as its
  reference (Web Audio output is not echo-cancelled in Chromium), so a slider
  at or below 100 % changes nothing about echo for somebody on speakers.
- **Above 100 %: that one stream goes through Web Audio**, its element kept
  attached but muted (Chromium only lets a remote WebRTC stream into Web Audio
  while a media element plays it):
  `MediaStreamAudioSourceNode → GainNode (slider / 2) → WaveShaper → GainNode (0 when deafened) → out`.
  The WaveShaper is the soft limiter: identity up to −6 dBFS, then a tanh knee
  that never reaches full scale. **Deviation:** not a DynamicsCompressorNode —
  Chromium's applies an automatic makeup gain, so a quiet voice at "150 %" came
  out at ~200 % (measured); with the WaveShaper the measured ratio of output to
  stream is 1.50 at 150 % and 2.00 at 200 % below the knee, and a loud stream
  (peak 0.59) at 200 % peaks at 0.94 instead of clipping.
- **Output device. Deviation:** not `AudioContext.setSinkId`. A context moved to
  a non-default device got only zeros from MediaStreamAudioSourceNodes of
  REMOTE streams (an oscillator in the same context played; a fresh context
  created with that sinkId got zeros too; Chromium build 1243, fake devices).
  So the default device is the context's own destination, and any other is a
  MediaStreamAudioDestinationNode played by a detached `<audio>` with
  `HTMLMediaElement.setSinkId` — the existing element path.
- Deafen silences both paths. The speaking ring reads the remote stream itself
  (unscaled: it shows what they send, not my slider). Cue sounds have their own
  context and never pass through here.
- Above 100 % the sheet says the boost can echo on speakers (it bypasses the
  echo canceller's reference).

## 4. Input sensitivity gate and AFK

**Gate** (Ayarlar › Giriş hassasiyeti): "Otomatik" (default) = no gate, the v2
behaviour, nothing added to the path. Otherwise a live level bar (peak dBFS
after RNNoise, before the gate and the mute) with a draggable threshold,
−80…−10 dB. In the one microphone graph:

    microphone ──► [RNNoise] ──► [gate] ──► mute·PTT gain ──► sent track
                                 └► level tap (meter, AFK speech)

- An AudioWorklet whose module is built at runtime from the same function the
  unit tests run (`audio/gateCore.ts`) and loaded from a `blob:` URL, which the
  CSP allows (`script-src 'self' blob:`); e2e 53 runs it in the built client
  with the CSP guard on. If it cannot be made, the microphone is sent ungated
  (`unavailable`, said in the settings).
- Look-ahead 10 ms: the output is delayed 10 ms and the detector reads the
  undelayed input, so a word's onset opens the gate (1 ms ramp) before it
  reaches the output — no clipped onsets. Closes 250 ms after the last sample
  over the threshold has left the delay line, with a 20 ms ramp. The gate adds
  10 ms of latency while on, none while "Otomatik".
- The speaking ring keeps reading the sent stream (after the gate): it shows
  what is actually sent.

**AFK**: after 10 minutes with no speech (level tap over max(−26 dBFS, the
gate's threshold), muted or not), no input event in the page (pointer, key,
wheel, touch), no push-to-talk press, and — in the desktop app — a system idle
time (`getSystemIdleTime`) of 30 s or more, I am AFK: `afk: true` on
`voice.state`, an "AFK" mark on my row for everybody, and auto-mute if I was not
muted, remembered as automatic. The first activity ends AFK and unmutes only if
the mute was automatic and still in place; a mute I chose (before, or by
clicking during AFK) stays. A setting turns auto-AFK off (default on).

### On the wire

    client → server  voice.join  {…, afk?: bool}      default false
    client → server  voice.state {…, afk?: bool}      default false (absent = not AFK)
    server → all     voice.joined / voice.state {…, afk}
    ready.voice[…]   {…, afk}

`afk` must be a boolean (`BAD_REQUEST` otherwise); it is always present in the
server's frames. Clients that predate it ignore it; a server that predates it
ignores the key.

## 5. Global mute/deafen keys (desktop) and shortcuts (browser)

**Desktop bridge additions** (all optional; a page checks for them):

    window.trioDesktop.setHotkeys({mute?: code | null, deafen?: code | null}): void
    window.trioDesktop.onHotkey(cb: (action: 'mute' | 'deafen') => void): () => void
    window.trioDesktop.setVoiceState({inVoice, muted, deafened}): void   // the tray icon
    window.trioDesktop.getSystemIdleTime(): Promise<number | null>      // seconds

- Codes are `KeyboardEvent.code`, single keys (the hook knows keys, not chords).
  The main process uses the ONE uiohook instance push-to-talk already runs; it
  runs while a PTT key or any hotkey is set. A hotkey equal to the PTT key is
  not registered (PTT wins); the settings refuse it with a sentence. Mute and
  deafen cannot share a key. A held key fires once.
- IPC: `trio:set-hotkeys`, `trio:hotkey` (main → page), `trio:voice-state`,
  `trio:system-idle` (invoke), each checked against the server page's origin.
  A navigation clears the hotkeys and the tray mark.
- The tray icon gets a mark drawn into its bitmap at runtime (no new asset): a
  #E4777F disc with a white bar (muted) or a white ring (deafened); the tooltip
  says it too.
- A hotkey toggles through the same path as a click, cue sound included.

**Browser**: in-page chords while the tab is focused, default Ctrl+Shift+M
(mute) and Ctrl+Shift+D (deafen), rebindable (a chord needs Ctrl, Alt or Meta;
the two cannot be the same). Not used in the desktop app, which has the global
keys. Settings: Ayarlar › Kısayollar, press-to-bind.

## 6. The room's people under the stage

When the stage is visible (somebody shares a screen or has a camera on), the
room's people without a camera tile appear under it as small avatar tiles
(`stage-person-<id>`: avatar with the speaking ring, name, muted/deafened/AFK
marks), and a screen I stopped watching as a chip with "İzle". An audio-only
room has no stage and no strip.

## 7. Desktop version (owner request, same round)

- `window.trioDesktop.appVersion: string` — Electron's `app.getVersion()`. The
  sandboxed preload cannot ask for it, so the main process puts
  `--trio-app-version=<v>` on the renderer's argv (`additionalArguments`) and
  the preload exposes it (validated as a semver-shaped string; absent in
  builds before this). The tray menu and the app menu show a disabled
  "Trio <version>" item; the connect page shows it under the form.
- Ayarlar's footer, in the desktop app only, adds "Masaüstü uygulaması
  <appVersion>" (`desktop-version`), or "Masaüstü uygulaması (eski sürüm)" when
  the bridge has no `appVersion`.
- Update notice: desktop and server are released with one version, so when
  `appVersion` is lower (semver, `lib/desktopVersion.ts`) than
  `ready.server_version` — or this web build's own version when the server
  does not say — or is missing, a band (`desktop-update`, dismissable per
  version: `localStorage` `trio.desktopUpdateDismissed`) and a line in the
  settings footer (`desktop-update-line`) say "Masaüstü uygulamasının yeni
  sürümü var (<server version>). İndir". "İndir" is a `target="_blank"` link to
  https://github.com/borankaraduman-star/Trio/releases/latest: the desktop
  app's window-open handler denies the window and opens https links with
  `shell.openExternal` (the system browser). Never shown in a plain browser.
  No auto-updater (the builds are unsigned).

## Test ids

`btn-share-menu`, `share-chip`, `share-menu`, `share-profile-{game,text,film}`,
`share-quality-{low,mid,high}`, `share-estimate`, `share-warning`,
`share-watchers`, `local-watchers`, `btn-unwatch-<id>`, `btn-watch-<id>`,
`hidden-screen-<id>`, `stage-people`, `stage-person-<id>`, `volume-sheet`,
`volume-voice`, `volume-stream`, `volume-*-value`, `volume-reset`,
`volume-reset-all`, `gate-auto`, `gate-meter` (`data-level-db`,
`data-gate-state`, `data-gate-open`), `gate-threshold`, `gate-meter-test`,
`afk-enabled`, `afk-<id>`, `settings-shortcuts`, `shortcut-{mute,deafen}`,
`shortcut-*-bind`, `shortcut-*-clear`, `shortcut-conflict`, `desktop-version`,
`desktop-update`, `desktop-update-line`, `desktop-update-download`,
`desktop-update-dismiss`. Remote audio
elements carry `data-volume` and `data-route` (`element` | `webaudio`).

## Not verified

Real games, GPUs and upload links (only Chromium's fake screen capture: what
the encoder did with each profile is recorded in e2e 50's output, the BWE
ramp-up limited Oyun to 640×360 at ~20 fps for the first seconds);
`contentHint`'s effect on a real encoder; real microphones and the gate on real
speech; Windows/macOS global hotkeys and the tray mark; Safari and Firefox;
`AudioContext.setSinkId` with remote streams on real devices.
