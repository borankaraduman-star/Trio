# Trio — contract V8: sharing music in a voice room

Owner decisions (19 Nov 2026): the sharer shares **the sound playing on their
computer** (Spotify app, a YouTube tab, anything); sharers use the **Windows
desktop app** or **Chrome/Edge**; everybody **in the voice room** hears it;
the **track title is shown** where it can be found.

This file is the agreement between the web/server part and the desktop part,
written before either. Refine it in the same commit as the code; where the
platform makes a rule impossible, say so here rather than quietly dropping it.

## 1. What it is

A third kind of outgoing media beside camera and screen: one **audio-only
stream ("music")** per person, sent to every peer in the room. No picture.
It can run together with a screen share or a camera. Several people may share
at once (the client does not forbid it; the UI shows each).

## 2. Wire

- `voice.state` (both directions), `voice.joined` and the `ready.voice`
  entries gain `music: bool` (missing = false) and
  `music_title: string | null`. The server validates: boolean; title at most
  120 characters after trimming, control and bidi-override characters
  removed, `null` when empty or when `music` is false. Relayed like the other
  flags. An old client ignores both keys.

  As built (server): a title is CLEANED, not refused — it comes from
  somebody else's player — controls, format (bidi, zero-width) and private-
  use characters removed, whitespace runs made one space, cut to 120
  characters. `music` that is not a boolean, or a `music_title` that is
  neither a string nor `null`, is `BAD_REQUEST`. A client sends both keys
  only while sharing; a frame without them (every older client) means "not
  sharing". Leaving clears them (the next join starts without). A resume
  (`voice.join {resume: true}`) carries them like the other flags.
- `signal.data.meta` gains `music: "<MediaStream id>" | null` next to
  `camera` and `screen`, sent BEFORE the track is added (CONTRACT-V2 §4). A
  remote audio track whose stream id equals `meta.music` is music, never the
  microphone. (An older client that does not read `meta.music` would take the
  music stream for the microphone: the three friends' web clients come from
  the same server, so this only matters for a tab left open across a
  release.)
- Starting and stopping music goes through the existing turn-taking
  negotiation (CLAUDE.md: never an SDP rollback). Stopping stops the
  transceiver (`stopSenders`), like camera and screen.
- As built: when a negotiation settles, a transceiver that NEITHER side sends
  on and that has no track is stopped (`stopIdleTransceivers` in voice.ts,
  applies to camera and screen too). `stopSenders` keeps a sendrecv
  transceiver receiving (the other side may still send on it); when two
  people turned music off together, the other side then stopped too and
  nobody stopped it, so each such cycle left one m-line (+1.2 KB, measured in
  e2e 72). Stopping is itself a negotiation, through the turn-taking.

## 3. Capture rules (the sharer)

- Constraints: `echoCancellation: false`, `noiseSuppression: false`,
  `autoGainControl: false`, stereo. The music never passes through RNNoise,
  the input gate, mute, push-to-talk or AFK: muting the microphone does not
  stop the music; "Müziği durdur" does. Hanging up stops it.
- Sent as Opus music: stereo, a target of ~128 kbit/s.

  **Measured (web part, 19 Nov 2026, Chromium 153 of the e2e suite)** with a
  stereo source (440 Hz at 0.5 on the left, silence on the right) between two
  connections, reading `outbound-rtp`/`inbound-rtp` bytes over 3 s, the
  `codec` stats and each decoded channel's peak:

  | SDP munging | maxBitrate | out kbit/s | decoded L / R |
  |---|---|---|---|
  | none | — | 32 | 0.25 / 0.25 (downmixed) |
  | none | 128 000 | 128 | 0.25 / 0.25 |
  | `stereo=1` only in the answer the SENDER applies | — | 64 | 0.25 / 0.25 |
  | the same, and in the offer the receiver applies | 128 000 | 128 | 0.25 / 0.25 |
  | `stereo=1;sprop-stereo=1` in the RECEIVER's own (local) answer | — | 64 | 0.50 / 0 |
  | the same | 128 000 | 128 | 0.50 / 0 |

  So what is needed: (1) `stereo=1` in the **receiver's own description** of
  the m-line — its decoder takes the channel count from its local fmtp, and
  the sender's encoder reads the same line from the remote description it
  receives; munging only what one side receives gives mono; (2) the
  sender's `maxBitrate: 128000` (`setParameters`, not in the SDP, no
  renegotiation; stereo=1 alone gives 64 kbit/s). `contentHint = "music"`
  changed nothing measurable here; it is set anyway (it is the documented
  hint for an encoder). Sender-side `sprop-stereo` changed nothing either.

  As built (`web/src/music/opusStereo.ts`): every local description, offer or
  answer, gets `stereo=1;sprop-stereo=1` on the Opus payload of the m-lines
  that carry music in either direction (found by `a=msid` = the peer's
  `meta.music` in the remote description, or by the transceivers of my own
  music sender and of the peer's music receiver), and on no other m-line —
  the microphone stays mono at 32 kbit/s (e2e 71 checks its fmtp). While no
  music m-line exists the description is set exactly as before
  (`setLocalDescription()` with no argument); with one, it is
  `createOffer`/`createAnswer`, munged, then `setLocalDescription`. No
  rollback: e2e 72 counts explicit and implicit rollbacks (a remote offer
  applied in `have-local-offer`) over 15 on/off cycles, every fifth by both
  people at once — 0 — and every signalling state seen is `stable`,
  `have-local-offer` or `have-remote-offer`. Received in e2e 71/73/74: ~128
  kbit/s, left ≈ 0.50, right 0.
- **The sharer's own Trio sound must not be in it.** If the captured sound
  included the voices of the room, everybody would hear themselves back.
  - Browser: the picker asks for a **tab** (or, on Windows, system audio) via
    `getDisplayMedia`; the picture track is stopped and never sent. Trio's own
    tab is excluded from the picker where the browser allows
    (`selfBrowserSurface: "exclude"`), and system audio is offered only if
    the browser can keep Trio's own playback out of it; otherwise only tabs.

    As built (`web/src/music/capture.ts`; option names checked by web search
    on 19 Nov 2026 against Chrome's docs and blink-dev intents, the pages
    themselves were not reachable from the build machine):
    `{video: true, audio: {echoCancellation: false, noiseSuppression: false,
    autoGainControl: false, channelCount: 2, restrictOwnAudio: true¹,
    suppressLocalAudioPlayback: false²}, selfBrowserSurface: "exclude",
    preferCurrentTab: false, surfaceSwitching: "exclude", systemAudio,
    windowAudio, monitorTypeSurfaces}` where the last three are
    `"include"`/`"window"`/`"include"` when `getSupportedConstraints()` lists
    `restrictOwnAudio` (¹ only then), else `"exclude"` — tabs only.
    ² only where listed; the sharer keeps hearing the tab. Because a listed
    constraint is not a working one (Linux Chromium lists `restrictOwnAudio`
    and a capture reports `false`), the capture is checked AFTER the picker:
    kept if the picture's `displaySurface` is `"browser"` (another tab: none
    of Trio's sound) or the audio track reports `restrictOwnAudio: true`;
    otherwise every track is stopped and the sharer reads "Trio kendi sesini
    bu paylaşımdan ayıramıyor… Müziğin çaldığı sekmeyi seç…". No audio track
    (the "share tab audio" box not ticked) is "Ses gelmedi: paylaşırken
    seçicide bir sekme seç ve “Sekme sesini de paylaş” seçeneğini işaretle."
    Closing the picker says nothing. Measured: stopping the picture track
    of a tab capture leaves its sound flowing; headless Chromium captures a
    tab's sound as silence (e2e 73 runs a headed browser on its own Xvfb).
    The screen share already sends `restrictOwnAudio: true` where listed
    (`audio/screenAudio.ts`, since V6); unchanged.
  - Windows desktop app: system sound **without Trio's own output**. The
    desktop part decides how (Chromium's own-audio restriction, a per-process
    loopback, or routing) and proves it with a test or a documented manual
    check. If it cannot be done on some Windows version, the app offers what
    it can do safely and says why; it never silently shares the room back
    into the room.

    **Decided (desktop part, 19 Nov 2026): Chromium's own-audio restriction,
    Windows 11 only.** Read in the sources of the Electron in use (45.3.4,
    Chromium 156): when a getDisplayMedia request carries the audio
    constraint `restrictOwnAudio: true` and the app's handler answers
    `audio: "loopback"`, Electron (since v44,
    `shell/browser/electron_browser_context.cc`) opens the device
    `loopbackWithoutChrome`, which Chromium's WASAPI capture
    (`media/audio/win/audio_low_latency_input_win.cc`) opens as a process
    loopback with `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE` on the
    audio service's own process: everything Windows plays except what Trio
    plays (every remote voice, every Trio sound). Chromium declares this
    supported only on Windows 11 (`IsWindowsProcessLoopbackCaptureSupported`:
    build 22000+), and `getSettings().restrictOwnAudio` is `true` only
    there. So: Windows 11 → system sound without Trio; Windows 10, macOS,
    Linux → the app refuses with a Turkish sentence that points to Chrome's
    tab share. Not done: per-application capture (Chromium has an
    `applicationLoopback` device, also Windows 11 only, and Electron's
    handler offers no supported way to name one) and a native helper (it
    would call the same Windows process-loopback activation, which Microsoft
    lists for build 20348 and later — no Windows 10 desktop release has that
    build — so it would add a native build and still not help Windows 10;
    not re-checked against learn.microsoft.com, unreachable from the build
    machine). Proven by unit tests with fakes (the
    handler's decisions) and by reading the sources; the sound itself only by
    the manual check `docs/muzik-paylasimi-kontrol.md`.

    The web client, in the app, does exactly this (bridge in §5):

    1. `prepareMusicCapture` missing (an older app): do **not** start a music
       share in the app — the older app's screen picker with "sistem sesi"
       would share the room back. Say: "Müzik paylaşmak için masaüstü
       uygulamasını güncelle ya da Trio'yu Chrome'da açıp sekmeyi paylaş."
    2. In the click handler: `const r = await trioDesktop.prepareMusicCapture()`.
       `r` null or `r.ok === false`: show `r.message` (Turkish, ready to
       show) and stop; nothing is captured.
    3. Straight after (the arm lives 15 s and is spent by the very next
       getDisplayMedia, whatever it is):
       `getDisplayMedia({video: true, audio: {restrictOwnAudio: true,
       echoCancellation: false, noiseSuppression: false,
       autoGainControl: false, channelCount: 2}, systemAudio: "include"})`.
       No picker opens; the video is the primary screen (Chromium grants no
       audio-only display capture). Stop every video track at once; it is
       never added to a connection.
    4. Accept the audio track only if
       `track.getSettings().restrictOwnAudio === true`. Otherwise stop every
       track and show the refusal text of `musicCaptureSupport()` (or
       "Bu bilgisayarda Trio kendi sesini paylaşılan sesten ayıramıyor.");
       never send it.
    5. `musicCaptureSupport()` (no side effect) may be called earlier to
       explain the button before it is pressed.

    Screen sharing with the existing in-app picker is unchanged (a request
    without a prepared arm goes to the picker; "sistem sesi" there is plain
    loopback, Trio's voices included, as before). Adding
    `restrictOwnAudio: true` to the screen share's audio constraints would
    give it the same exclusion on Windows 11 with no desktop change; that
    is the web client's call.
- The sharer does not hear their shared music twice: nothing is played
  locally by Trio.
- A capture that ends by itself (tab closed, "stop sharing" in the browser
  bar, device gone) ends the share and clears `music`.

## 4. Listening

- Each remote music stream plays in its own element,
  `data-testid="remote-music-<user id>"`, separate from
  `remote-audio-<user id>`.
- Per listener and per sharer: a music volume (0–100 %, default 50 %) and a
  mute for the music, remembered on the device; separate from that person's
  voice volume. Deafen silences music too. The output device setting applies.

  As built: `localStorage` `trio.music8` (`{volumes: {"<id>": {volume,
  muted}}, showTitle}`), apart from the V6 volumes (`trio.voice6`). The
  music volume is the element's own `volume` and never above 100 %, so music
  NEVER goes through the V6 boost path (Web Audio gain + limiter) — a
  person's voice boost does not touch their music and their music cannot be
  boosted; the element is muted by deafen or the music mute. The element
  follows the output device with `setSinkId` like a microphone's element
  (e2e 74). Shown in the existing volume sheet (right-click / long-press on
  the sharer's row) under the voice sliders, only while they share.
- Music never drives the speaking ring, the AFK speech detector or the voice
  activity of anyone.
- While somebody shares, the room shows it: a note mark on the sharer's row
  (`data-music`), and a "now playing" line with the title when there is one.

## 5. Title ("Şu an çalıyor")

- Sent only while sharing, only if the sharer leaves "Şarkı adını göster" on
  (default on, in the share control). Never read or sent when not sharing.
- Desktop bridge (optional members; an older desktop app has none; types in
  `desktop/src/shared/bridge.ts`):

      window.trioDesktop.musicCaptureSupport?(): Promise<MusicSupport | null>
      window.trioDesktop.prepareMusicCapture?(): Promise<PrepareResult | null>
      window.trioDesktop.setNowPlayingWatch?(on: boolean): void
      window.trioDesktop.onNowPlaying?(cb: (info: NowPlaying | null) => void): () => void

      type MusicRefusal = "windows-version" | "unsupported-platform" | "busy" | "not-allowed"
      type MusicSupport = { systemAudio: true }
                        | { systemAudio: false; reason: MusicRefusal; message: string }
      type PrepareResult = { ok: true } | { ok: false; reason: MusicRefusal; message: string }
      type NowPlaying = { title: string; artist?: string; app?: string }

  `null` from the two promises means the main process did not accept the
  caller (not the main window's top frame on the configured server). `busy`:
  the screen-share picker is open. `message` is Turkish and shown as text.
  How the two capture calls are used: §3, "Windows desktop app".

  Now playing: `setNowPlayingWatch(true)` when the music share has started
  and the title toggle is on, `false` when either ends (the app also stops
  it by itself when the page navigates or reloads). While off, nothing is
  read and nothing is sent. While on, `onNowPlaying` callbacks get a value
  only when it CHANGES: a `NowPlaying` when something is known, `null` when
  it stops being known. The page starts from `null` (no value is sent at
  watch start until something is known). Strings are already cleaned
  (controls and bidi characters removed, whitespace collapsed) and capped:
  title 120, artist 120, app 40 characters; `app` is a short friendly name
  ("Spotify", "Chrome", "Edge", "Firefox", …), never a path.

  Source on Windows: the system media session
  (`GlobalSystemMediaTransportControlsSessionManager`; the first session
  that is Playing, the current one first), else Spotify's main window title
  ("Artist - Song"), read every 3 s by one hidden Windows PowerShell process
  that exists only while the watch is on. macOS and Linux: no source; the
  callback is never called. The desktop app does NOT know which app is being
  shared (it captures all system sound), so the title is "what Windows says
  is playing", which may be something other than what is heard.
- Browser: best effort from the captured tab (its title, where the platform
  exposes it); otherwise an editable text the sharer may type. No title is
  not an error.

  As built: no browser gives the capturer the tab's title — Chrome's track
  label is `web-contents-media-stream://<id>` (measured), a window's
  `window:<id>:0` — so the browser case is the editable text alone
  (`music-title-input`, empty at the start, sent 400 ms after typing stops).
  In the app with `onNowPlaying`, the title is what the bridge reports
  (`"Artist — Title"`, or the title alone when it already contains the
  artist), read-only in the panel; without `onNowPlaying`, the text field.
  "Şarkı adını göster" is remembered on the device (`trio.music8`) and only
  shown while sharing.
- Shown as text only (never HTML), at most one line, with the sharer's name.

## 6. Controls and test ids

`btn-music` (the user panel at the bottom of the sidebar, while in voice),
`call-bar-music` (the phone call bar — **changed from `btn-music`**: on a
phone both are in the page at once, the drawer's and the bar's, as with
`btn-screen`/`call-bar-screen`); both hidden where `getDisplayMedia` does not
exist; `music-panel` (while I share), `music-title-toggle`, `music-title-input`,
`music-now-playing-<user id>`, `music-volume-<user id>`,
`music-mute-<user id>`, `remote-music-<user id>`.

## 7. Not in this version

Listening without joining the room; a synchronized YouTube player; sharing
from phones; macOS system audio.
