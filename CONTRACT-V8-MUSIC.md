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
- Desktop bridge (optional members; an older desktop app has none):

      window.trioDesktop.onNowPlaying?(cb: (info: NowPlaying | null) => void): () => void
      type NowPlaying = { title: string; artist?: string; app?: string }

  The desktop part reports what Windows knows about the playing media
  (system media session) or, failing that, the title of the shared
  window/app; `null` when nothing is known. It only listens while a music
  share is on (`window.trioDesktop.setNowPlayingWatch?(on: boolean)`).
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
