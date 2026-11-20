# Trio — contract V12: a shared screen's sound steps aside for speech ("ducking")

Owner's request (20 Nov 2026), part of "make life easier for someone watching
a friend's screen share while playing a game": when somebody SPEAKS, the sound
of a shared screen (the game's or the video's audio in the share) and of
shared music drops so the voice is clear, then comes back — like ducking in
voice apps. Client only: nothing on the wire, nothing on the server. Adds to
V6 (per-person volume, "Yayın sesi") and V8 (music volume); where they differ,
this wins.

## 1. What it does

- **Purely local.** It changes only what THIS listener hears from REMOTE
  shared screens and (optionally) REMOTE shared music. Never a voice, never
  the microphone graph (V2: the sent microphone track never changes), never
  what is sent, never anybody else.
- **When.** While anybody else in the room is speaking — the call's own
  speaking detector (`snapshot.speaking`, the one behind the ring) — and, with
  "Ben konuşurken de kıs", while I am (my microphone actually sent: muted or a
  closed push-to-talk is not speaking). Several speakers are one duck. The
  sharer talking over their own share ducks it for the listener (that is the
  point: the share is lowered under the voice that explains it).
- **How much.** The share's (and music's) gain is multiplied by `1 − amount`
  (default amount 60 %: to 40 %). Composition is multiplicative with
  everything already applied: the V6 "Yayın sesi" 0–200 %, the V8 music
  volume 0–100 % and its mute, deafen.
- **The envelope.** Speech seen → ramp down in **100 ms**. Speech gone → hold
  **250 ms** more (on top of the detector's own 300 ms hold, so ~550 ms after
  the last loud ~11 ms block; gaps between words do not pump the share) →
  ramp up in **650 ms**. Each ramp is a raised cosine (zero slope at both
  ends); a new target (speech again, the switch turned off, the amount moved)
  starts a new ramp from wherever the factor is, so nothing jumps: turning the
  setting off mid-duck is a 650 ms release, not a step.

## 2. Mechanism, per path

How each stream reaches the speakers today, and what ducks it:

| stream | path (unchanged) | ducked by |
|---|---|---|
| remote screen, "Yayın sesi" ≤ 100 % | the `<video>` element's own `volume` (on the chosen output with `setSinkId`) | its `volume` = slider × factor |
| remote screen, > 100 % | V6 boost route: source → gain (slider, halved) → WaveShaper limiter → gain (deafen) → out (context destination, or the fallback element on another output device) | the route's slider gain = slider × factor (`AudioParam.setTargetAtTime`, 10 ms) |
| remote music | its `<audio>` element's `volume` (never boosted, V8 §4) | its `volume` = music volume × factor |
| voices | element / boost route | **never** |

- **No stream changes path for a duck.** The boost route is chosen by the
  slider alone (`duckedPlayback`): 150 % ducked to 60 % stays on Web Audio,
  100 % ducked stays on the element. In particular an element-only stream is
  NOT routed through Web Audio to duck it: V6 records that the element path is
  what Chromium's echo canceller hears as the far-end reference (audio played
  through Web Audio is not), so moving a share there would put it back into
  the microphone of somebody on loudspeakers. The output-device routing is
  untouched for the same reason: a ducked stream is the same element on the
  same sink.
- **One scheduler.** `audio/ducking.ts` `Ducker`: the factor is a function of
  the clock (`performance.now()`), not of how many ticks ran; while a ramp or
  a hold is in progress an interval timer ticks every 10 ms and writes the
  factor to every registered stream; at rest nothing ticks. Not
  `requestAnimationFrame`: it stops in a hidden tab or a minimised window —
  exactly when the person is in their game. Timers keep running there, and a
  page PLAYING SOUND is exempt from Chromium's background-timer throttling —
  and a duck only matters while the share plays sound. Even throttled, a late
  tick lands on the right value (coarser, never wrong or lagging).
  **Measured** (e2e 96): ticks ≤ 22 ms apart visible; with the page told it is
  hidden, ≤ 12 ms, 101 ticks over the episode. **Not measured**: Chromium's
  real throttling of a hidden page — headless Chromium keeps every page
  `visible` whatever is done (measured: another tab in front, `window.open`, a
  minimised window, a tab opened over CDP, headed under Xvfb), so spec 96
  overrides `document.visibilityState`/`hidden` and fires `visibilitychange`.
- **Steps.** On the element path the volume moves in 10 ms steps; the largest
  measured step in e2e 96 was 0.099 of full scale (the cosine's steepest point
  at amount 60 %: 0.6 × π/2 × 10/100 = 0.094, plus timer jitter). On the boost
  path the AudioParam smooths each step with a 10 ms time constant.

## 3. Detection

- The detector is the existing one (voice.ts): every microphone read over the
  WHOLE interval between two 100 ms polls (`audio/speaking.ts`), so a short
  word is not missed between reads, with a 300 ms hold so it does not flap. No
  second analyser. It never reads a screen's or music's stream (V8 §4), so a
  share cannot duck itself and music is never "speech".
- Others vs me: `snapshot.speaking` ids that have a remote microphone are
  others; the rest is me, counted only while `transmitting`.

## 4. Settings ("Ayarlar › Ses", section "Yayın sesi")

| test id | text | default |
|---|---|---|
| `settings-duck` | Biri konuşunca yayın sesini kıs | **on** |
| `settings-duck-amount` (`-value` shows `%60`) | Ne kadar (0–100 %, step 5) | **60 %** |
| `settings-duck-music` | Paylaşılan müziği de kıs | **off** |
| `settings-duck-self` | Ben konuşurken de kıs | **on** |

The three below are disabled while the first is off. Per device:
`localStorage["trio.duck12"] = {"enabled", "amount", "music", "self"}`
(`DUCK_PREFS_KEY`), repaired field by field, never throws, private mode keeps
it for the tab.

Why these defaults:

- **On for screens, at 60 %.** A shared game or video arrives at full scale
  ("Yayın sesi" 100 %) and is the one thing that masks a voice; the owner asked
  for it. 60 % (−8 dB) leaves the game audible under the voice — it is a duck,
  not a mute — and the release is slow enough not to pump in a lively chat.
- **Off for music.** Shared music already plays at 50 % by default (V8 §4)
  and is a backdrop people chose to talk over; in a talkative room a ducked
  music share would spend most of the evening at 20 % and pump. One tick turns
  it on.
- **"Ben konuşurken de kıs" on.** When I speak I want to hear myself over the
  share as much as anybody, and the people I am talking to are not affected
  either way (it is local).

## 5. Test hooks

- Each screen element carries `data-duck` (the factor now) beside V6's
  `data-volume` (the slider, unchanged) and `data-route`; the music element
  carries `data-duck` beside V8's `data-volume`.
- `window.__trioDuckProbe = true` before load exposes `window.__trioDuck`
  (`share`, `music`, `ticks`, `maxGapMs`, `hiddenTicks`, `hiddenMaxGapMs`,
  `speech`).

## 6. Verified, and not

- Unit (`web/src/__tests__/ducking.test.ts`): attack/hold/release with a fake
  clock, smooth monotone ramps, no pumping between words, several speakers,
  self on/off, music on/off, off mid-duck returns smoothly, a late tick lands
  on the right value, composition with volume/deafen and the unchanged route,
  the prefs and their key.
- e2e 96 (three browsers, fake media; the share's sound is a steady 0.2 tone,
  the speaker a continuous speech-like file): from the speaker's ring on the
  listener's row to the ducked level **88–95 ms**; from her unmute click
  **~250–400 ms** (network, jitter buffer, detector poll, attack); ducked level
  0.40–0.414 while she speaks; back to full **840 ms** after her ring goes off
  (250 + 650 = 900 ms nominal from the ducker's own view); the boost route's
  OUTPUT, read on its analyser after the gain, 0.31 → 0.12 (ratio 0.39) and
  back to 0.31; a boosted voice keeps its exact 150 % meanwhile; voices'
  elements never move; off changes nothing; music ducks 0.5 → 0.2 only with
  its box ticked.
- **Not verified**: real speech (the ring's threshold on real voices, so how
  often a cough or a laugh ducks), how a duck SOUNDS on a real game (whether
  60 %/650 ms is pleasant, any audible stepping on the element path in a real
  output device), real hidden-tab/minimised-window throttling in Chrome and in
  the desktop app (Electron's `backgroundThrottling`), Safari and Firefox.
