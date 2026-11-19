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
- `signal.data.meta` gains `music: "<MediaStream id>" | null` next to
  `camera` and `screen`, sent BEFORE the track is added (CONTRACT-V2 §4). A
  remote audio track whose stream id equals `meta.music` is music, never the
  microphone.
- Starting and stopping music goes through the existing turn-taking
  negotiation (CLAUDE.md: never an SDP rollback). Stopping stops the
  transceiver (`stopSenders`), like camera and screen.

## 3. Capture rules (the sharer)

- Constraints: `echoCancellation: false`, `noiseSuppression: false`,
  `autoGainControl: false`, stereo. The music never passes through RNNoise,
  the input gate, mute, push-to-talk or AFK: muting the microphone does not
  stop the music; "Müziği durdur" does. Hanging up stops it.
- Sent as Opus music: stereo, a target of ~128 kbit/s (state in this file what
  was actually needed — sender `maxBitrate`, fmtp `stereo=1`, and how it was
  measured from `outbound-rtp`). If stereo needs SDP changes, they are made
  without ever causing a rollback and are covered by a test that counts
  offers and signalling states.
- **The sharer's own Trio sound must not be in it.** If the captured sound
  included the voices of the room, everybody would hear themselves back.
  - Browser: the picker asks for a **tab** (or, on Windows, system audio) via
    `getDisplayMedia`; the picture track is stopped and never sent. Trio's own
    tab is excluded from the picker where the browser allows
    (`selfBrowserSurface: "exclude"`), and system audio is offered only if
    the browser can keep Trio's own playback out of it; otherwise only tabs.
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
- Shown as text only (never HTML), at most one line, with the sharer's name.

## 6. Controls and test ids

`btn-music` (user panel while in voice, and the phone call bar; hidden where
`getDisplayMedia` does not exist), `music-title-toggle`, `music-title-input`,
`music-now-playing-<user id>`, `music-volume-<user id>`,
`music-mute-<user id>`, `remote-music-<user id>`.

## 7. Not in this version

Listening without joining the room; a synchronized YouTube player; sharing
from phones; macOS system audio.
