# Trio — contract V12: several people sharing, and watching them (adds to v1–v11; where they differ, this wins)

The owner (20 Nov 2026): "Two or more people from the team must be able to
share their screens at the same time" — and, told it already worked: "look
whether there is room for iteration". Then: "the person WATCHING must be able
to watch it picture-in-picture style and in a cinema mode … everything that
makes the viewer's life easier while they are playing a game."

So this file is two things: what was true about several shares at once
(measured, §2) and what was built on it — for the viewer (§3–§8) and for the
sharer (§9–§10). The desktop shell's half of the mini player (the window, its
rules, the global keys) is **CONTRACT-V12-MINI-DESKTOP.md**; "Biri konuşunca
yayın sesini kıs" (ducking) is its own branch and contract. On the wire this
is additive: a client or server that predates it keeps working.

The rules of CLAUDE.md hold throughout and shaped it: **nothing here
renegotiates** (every per-viewer change is a sender parameter, `setParameters`,
on the existing per-peer queue), the sent microphone track is untouched, and
the e2e specs (91–95) assert on media statistics.

---

## 1. What already worked, and the finding

Several people could always share at once: each share is one more video
stream on the existing connections, and e2e 05 had a test "two people sharing
at once both arrive". The owner did not know. That is a finding in itself: the
share button said "Ekran paylaş" to somebody whose friend was already sharing,
which reads as "take over the screen". §9 fixes the words.

## 2. Measured (this machine, 20 Nov 2026)

4 CPUs, the e2e suite's Chromium, every person a context of ONE browser with
the fake devices (the fake screen is a 1920×1080 moving pattern), loopback,
host candidates only. Spec 91 prints `[91] …`, 95 prints `[95] …`.

**The protocol held everywhere.** In every room size and number of shares
(rooms of 3, 5, 8; 1–4 shares; one after another and all starting within the
same second): **0 rollbacks** (explicit or an offer applied in
`have-local-offer`), **0 fresh connections**, one video m-line per connection
whatever the number of shares (a share reuses the transceiver the other side's
share created), and the largest description **7.4 KB**, far under the 64 KiB
signal cap. Starting a share costs one offer per connection of the sharer
(n−1); four people starting within the same second in a room of five: 17
offers in all, every viewer decoding every share. No bug was found in the
negotiation.

**Time to the first decoded frame and what it does to the others**
(baseline, before §3; median over the viewers):

| room | share 1 | share 2 | share 3 | share 4 | all at once |
|---|---|---|---|---|---|
| 3 | 0.49 s | 0.46 s | 0.68 s | — | 3 at once: 0.73 s (max 0.94) |
| 5 | 0.93 s | 1.03 s | 2.3 s | 5.9 s | 4 at once: 4.0 s (max 8.0) |
| 8 | (see below) | 4.3 s | 8.5 s | 22 s | — |

| room, shares | per sharer up (to n−1) | frames/s to each viewer | encoder ms/frame | limited by |
|---|---|---|---|---|
| 3, 1 | 790 kbit/s | 20 | 5 | bandwidth estimate ramping |
| 3, 3 | 540–1190 | 11–16 | 59–87 | — |
| 5, 1 | 1.3 Mbit/s | 10–20 | 21 | bandwidth |
| 5, 2 | 1.0–1.6 | 9–16 | 95–101 | bandwidth |
| 5, 4 | 270–335 | 1–3 | 230–490 | **cpu** |
| 8, 2 | 600–650 | 0–7 | 210–260 | **cpu** |
| 8, 4 | 300–390 | 0–3 | 300–520 | **cpu**; some viewers got no frame for 30 s |

What that says. **Every share is encoded once per viewer**: a sharer in a room
of n runs n−1 encoders, whatever the others do; with a 1080p source each
encode is the full picture. On one 4-core machine running every person, the
encoders starve from the second share in a room of five; that is this test,
not eight laptops — but it is also the shape of the real cost: a sharer in a
room of eight runs seven 1080p encoders (≈ a laptop's CPU), and each viewer
decodes every share at full size whether it is shown large or as a thumbnail.
**The first share is not frozen by a second one** through the network (their
bandwidth estimates are separate connections); it slows only by CPU, here.

**What "only pay for what you watch" (§3) saves** — spec 95, four shares in a
room of five, each viewer's own layout: see `[95]` lines in §11 (filled from
the run).

## 3. Each viewer is sent the size it shows ("only pay for what you watch")

Every place that shows a remote screen reports how large it shows it, in
device pixels (`web/src/watching/useShareSize.ts`): its stage tile (resized,
scrolled away, folded behind "+N", collapsed on a phone), the theatre, a mini
window, the browser's picture-in-picture, fullscreen. The largest wins; the
viewer's choice for that share caps it (§6); the result is told to the sharer:

    {"watch": {"stream": "<MediaStream id>", "on": true, "size": "full" | "mid" | "thumb" | "audio"}}

the V6 `watch` form with one more key (CONTRACT-V6-VOICE §2). `size` only
with `on: true`; absent = unchanged (a new share starts at `full`); an unknown
value is ignored. A sharer that predates it ignores the key (and sends full);
a viewer that predates it never sends one. In the per-peer signal queue, like
the rest of `watch`. Re-sent when the sharer's `meta` names a new share or
the pair has a fresh connection.

| size | when | the sharer's encoding for THIS viewer (`setParameters`) |
|---|---|---|
| `full` | ≥ 600 device px of picture height (focused, fullscreen, theatre, a big tile on a HiDPI screen) | the profile as chosen (V6 §1) |
| `mid` | 250–599 px (a grid cell) | at most 720 lines (`scaleResolutionDownBy`), half the bitrate |
| `thumb` | < 250 px, or mounted but not on screen (strip, "+N", collapsed, scrolled away), or "Hafif izleme" | at most 360 lines, ≤ 300 kbit/s, ≤ 8 frames/s |
| `audio` | "Sadece ses", or the share shown nowhere (the page hidden and no mini window) | video encodings `active: false`; the share's sound still sent |

Growing is told at once (60 ms); shrinking after it held 700 ms
(`VIEW_SIZE_SETTLE_MS`), so a window being resized sends one signal, not a
burst of keyframes. The engine keeps the size per viewer (`peer.viewSize`)
and writes it on the same chain as the profile, the V10 camera encoding and
music (`shareParamsChain`); the key includes the size, so a write that
changes nothing is skipped.

**Watching is still the V6 accounting.** A viewer at `thumb` is watching; at
`audio` it is still counted as watching (it hears the share) and the sharer's
menu says so ("sadece ses"); "İzlemeyi bırak" stays the one way to receive
nothing. Collapsing the stage on a phone stays layout (CONTRACT-V7-PHONE §3):
it now asks `thumb`, never off; the sound goes on.

## 4. The stage with two or more screens: "Yan yana" and "Odak"

`web/src/components/CallStage.tsx` (`MultiStage`). With one screen the stage
is as before (V2/V10).

- **Yan yana** (default): the screens in an equal grid whose arrangement makes
  each as large as the window allows for their shape (`sideBySide`: the
  largest tiles, and of arrangements within 15 % of it the one with fewer rows,
  so two 16:9 screens on a wide window sit side by side and leave the chat its
  room; two ultrawide ones stack; two portrait ones sit side by side). The
  aspect is read from the pictures (`videoWidth/videoHeight`). Cameras go to a
  strip under the screens. Up to ~62 % of the window's height (50 % on a
  phone, where the screens stack at full width and scroll).
- **Odak**: one screen large (the chosen one, else the pinned one, else the
  first), every other tile in the strip — where each is sent small (§3).
  ← / → move the focus, 1–9 pick a screen (on the stage), a click on a strip
  tile focuses it.
- The choice is remembered per device (`localStorage["trio.v12.watch"]`), the
  switch (`stage-mode-side`, `stage-mode-focus`) shows from two screens.
- A double click on any tile is the real fullscreen (on the monitor the window
  is on); the V2 button and F stay.
- Over the stage, while anybody shares: **"Ayşe ve Mehmet ekran paylaşıyor"**
  (`stage-sharing-line`, "Sen" for me). On a phone the call bar's second line
  says the same while nobody is talking (`call-bar-talking[data-sharing]`).
- Labels: every tile already said "Ayşe · ekran". Which window or app the
  sharer chose is NOT shown (rejected: the browser does not tell it, and a
  window title can say more than the sharer meant to).

## 5. Sinema modu (theatre)

`components/watch/Theatre.tsx`. One share fills the Trio window (the sidebar,
the member list and the chat are covered; a fixed layer over the app), from
the tile menu, a hotkey, or the mini player.

- Controls at the top fade after 3 s without the pointer (`data-controls`);
  the pointer brings them back; on a phone a tap does.
- A slim line at the bottom: **who is speaking**, and **the newest chat line**
  of the open text channel, fading in and out over 6 s (`theatre-chat`, can be
  turned off in the theatre).
- Esc (or the theatre key) leaves; F or a double click is the real fullscreen
  (a phone also tries `screen.orientation.lock('landscape')`).
- With 2+ shares: ← / →, 1–9, buttons per share; **"Yan yana"** shows two at
  once (stacked on a portrait phone).
- Picture only: the share's sound keeps playing from its stage tile, which
  stays mounted under the theatre. It reports `full`.

## 6. The mini player ("Mini oynatıcı")

**The seam** (fixed by the orchestrator): a same-origin child window,
`window.open('/mini.html?m=<id>', 'trio-mini-<id>', 'popup,width=480,height=270')`,
`id = share-<sharer user id>` (the shell remembers a place per id class:
every share's mini shares one). `web/mini.html` is a third Vite entry; the
server serves it with the app shell's headers (CSP and friends).
`web/src/mini/controller.ts` is the interface between the two windows.

- **The opener owns everything** (`web/src/watching/mini.ts`): it attaches
  the MediaStream to the mini's `<video data-mini-video>` (always muted: the
  share's sound plays once, in the Trio window, at the V6 "Yayın sesi"),
  re-attaches it when the engine hands over a new stream (a renegotiation, a
  fresh connection), reports the mini's size for §3, and closes the mini when
  the share ends ("Ayşe paylaşımı bitirdi.", then closed). The mini window has
  no `trioDesktop` bridge (the shell gives it `trioMiniWindow` only): every
  control calls the opener's controller, which calls the shell.
- **Where it opens**: in the desktop app a child window the shell makes
  frameless, always on top (above borderless games), aspect-locked,
  remembered per monitor, with opacity and click-through
  (CONTRACT-V12-MINI-DESKTOP); in Chromium with Document Picture-in-Picture,
  that window (always on top; one per page), with the same UI rendered into
  it; otherwise, or for a second mini, an ordinary popup whose ⧉ button puts
  its picture in the browser's classic picture-in-picture (always on top). A
  blocked popup is reported, never silent.
- **Controls** (drawn while the pointer is over it, `mini-*`): the sharer's
  name and who is speaking, ✕, the share's sound (mute, 0–200 %), ⇄ the next
  share, Hafif, Ses (audio only), ↩ back to Trio; in the desktop app also
  "Geçir" (click-through) and the opacity; in a browser ⧉. The top strip is
  the window's drag region (`-webkit-app-region: drag`, buttons `no-drag`).
- **From the stage**: ⧉ on every remote screen tile (`tile-mini-button-<id>`,
  one click), or the tile menu.
- **Automatic** ("Trio arka plandayken paylaşılan ekranı mini oynatıcıda
  göster", off by default): desktop app — the shell's `onWindowState` says the
  main window is minimised or in the tray → the share being watched opens in
  a mini; Trio focused again → that automatic mini closes. Browser —
  `mediaSession.setActionHandler('enterpictureinpicture')` (Chromium may call
  it when a tab using the microphone is left) opens Document PiP; returning to
  the tab closes it. The shell never sets `fullscreenAppInFront`.
- **Kendi paylaşımımda gizle** (desktop app, off by default):
  `contentProtection` on the mini window — my own screen share does not show
  my friends their own stream in a corner. The shell's notes on its cost apply.

## 7. Watching keys

Seven actions: `toggleMini`, `nextShare`, `clickThrough`, `muteShare`,
`shareVolumeUp`, `shareVolumeDown` (±10 %), `theatre`
(`web/src/watching/actions.ts`). "The share" an action means: the one in the
theatre, else in a mini window, else in focus, else the pinned one, else the
first.

- **Desktop app**: global keys through `trioDesktop.setWatchHotkeys` /
  `onWatchHotkey` (the shell's hook; a key or a chord such as `Ctrl+Shift+F9`).
  **None bound by default** (games use most keys); the settings suggest
  Ctrl+Shift with F9/F10/F11 and warn against Ctrl+Alt letters (AltGr on a
  Turkish keyboard). `clickThrough` is toggled BY THE SHELL; the page only
  shows the result (`onState`).
- **Browser**: in-page chords (`Ctrl`/`Alt`/`Meta` + a key) while the tab is
  focused; no click-through.
- Ayarlar › Ses › Kısayollar › **İzlerken**: one binder per action; a key that
  is the PTT, mute or deafen key (its physical key, chord or not), or another
  watching action's, is refused with the shell's sentences (`WATCH_REASONS`).
  Bindings are remembered in `trio.v12.watch` (`desktopKeys`, `pageKeys`).
  While a key is being bound, actions are ignored.

## 8. Light on the machine and the line; the tile menu

Per share, remembered per sharer (`choices` in `trio.v12.watch`):

- **Hafif izleme** — caps that share at `thumb` (360 lines, ≤ 300 kbit/s,
  ≤ 8 frames/s) wherever it is shown; a "Hafif" mark on the tile.
- **Sadece ses** — `audio`: the picture stops for me (the sharer's encoder for
  me is inactive), the share's sound goes on; the tile says "sadece ses" with
  "Görüntüyü aç" (frames again ~0.2 s after, a keyframe).
- **Oyun açıkken hafif izle** (setting, off by default): while my own game
  status (CONTRACT-V5) says I am playing, every share is Hafif.
- **Bağlantı bilgisini göster** (setting / menu): over each remote screen,
  "1280×720 · 30 kare/sn · 2,4 Mbps · çözme 3,1 ms · büyük" (the receiver's
  statistics every 2 s and the size asked for).
- **Bu paylaşımı sabitle** — first in every order, the large one in Odak.
- **The tile menu** (⋯, `tile-menu-<id>`): Mini oynatıcıda aç, Resim içinde
  resim (classic PiP of the tile itself, sound and all, where the browser has
  it), Sinema modu, Tam ekran, Hafif izleme, Sadece ses, Sabitle, Bağlantı
  bilgisi, the share's sound (mute and 0–200 %), İzlemeyi bırak. Every option
  two clicks away.
- **A share that starts while Trio is in the background** ("Biri paylaşmaya
  başlayınca bildir", off by default): one silent system notification, never
  under "Rahatsız etme".
- Hardware decoding: the browser picks it; the receiving line names nothing
  of it (Chromium reports `decoderImplementation` only to some pages), so no
  switch is offered.

## 9. The sharer: discoverability

- While somebody else in my room shares and I do not, the share button
  (sidebar `btn-screen`, `stage-share-too` over the stage) says **"Sen de
  paylaş"**, its tooltip "aynı anda birden fazla kişi ekran paylaşabilir,
  kimsenin paylaşımı durmaz" (`data-share-too`).
- Once per device, the first time somebody else shares: "Aynı anda birden
  fazla kişi ekran paylaşabilir: sen de paylaşırsan Ayşe paylaşmayı
  sürdürür." with "Anladım" (`multishare-tip`, `trio.v12.multishareTip`).
- The share menu says what each viewer is sent (`share-sending`): "3 izleyici
  ≈ en çok 3,6 Mbps: Ayşe büyük, Mehmet küçük, Zeynep sadece ses" — the V6
  estimate (`N × R`) stays as the ceiling before sharing.
- **One person sharing two things at once (two windows or monitors): not
  supported, and not half-built.** `meta.screen` names ONE stream per person,
  the engine keeps one `screenStream`, `watch` addresses a share by that id.
  Supporting it means `meta.screens: [...]`, one sender set per share, a
  `watch` per stream id and the cap counting shares rather than people. That
  is the next step if asked; today a second share replaces nothing because the
  button is "Paylaşımı durdur" while sharing.
- The desktop picker (shell) is per click and per machine; another person's
  share changes nothing in it.

## 10. The cap: `TRIO_SCREEN_SHARES_MAX`

| variable | default | meaning |
|---|---|---|
| `TRIO_SCREEN_SHARES_MAX` | **`4`** (1–16, else the server refuses to start) | people sharing a screen at once in ONE voice room |

Why 4: a sharer's cost does not depend on how many others share (n−1 encodes
either way); every VIEWER's does — it receives and decodes every share. Four
is a 2×2 grid, and §2 shows four shares already starving one machine in a
room of five at full size. With §3 most of those four arrive as thumbnails in
Odak; past four the stage stops being followable anyway.

    client → server   voice.state {screensharing: true, …}
    server → client   error {code: "SCREEN_SHARES_FULL", message, request: "voice.state",
                             channel_id, limit, sharers: [user ids, sorted]}
                      — nothing of that frame is applied, nothing broadcast
    ready             {…, screen_shares_max: 4}
    GET /api/server   {…, "screen_shares_max": 4}
    GET /api/owner/overview  limits.screen_shares_max

- Somebody already sharing is never refused (a repeated state). A member who
  came back with a resume in the 120 s after a start (a deploy) shares again
  past the cap (V10's rule). A `voice.join` carrying `screensharing: true`
  past the cap joins without the share.
- **The client asks first and negotiates after.** A captured share sends
  `voice.state {screensharing: true}` and waits for the server's echo of my
  state (yes) or `SCREEN_SHARES_FULL` (no) before any `meta` or track goes to
  anybody, so a refused share never starts a negotiation (e2e 93 counts the
  offers). Waited at most 4 s (then it goes ahead; the next state would be
  refused and the share stopped); while signalling is down (V4 A1) it goes
  ahead at once. Cost: one round trip before the first frame.
- **The UI says it before the click**: at the cap the button reads
  "Ekran paylaşımı dolu (4/4)" (`data-full`); a click opens no picker and says
  "Bu odada aynı anda en çok 4 kişi ekran paylaşabilir. Şu an paylaşanlar:
  Ayşe, Mehmet +2. Biri durdurunca paylaşabilirsin." Two people racing for the
  last place: the server decides, the other reads the same sentence.
- A server that predates it (no `screen_shares_max`) shows no cap.

**Recommendation for the public site** (not edited here): "Bir ses odasında
aynı anda 4 kişiye kadar ekran paylaşabilir (sunucu sahibi değiştirebilir).
İzleyen herkes paylaşımları yan yana, büyük–küçük, sinema modunda ya da oyun
oynarken köşede küçük bir pencerede izler; küçük gösterdiği paylaşım ona
küçük gönderilir."

## 11. Measurements of what was built

(filled from spec 92/95 runs)

## 12. Mode × platform

| | desktop app (Windows) | desktop app (macOS) | desktop app (Linux) | Chrome/Edge | Firefox | Safari | phone browser |
|---|---|---|---|---|---|---|---|
| Yan yana / Odak | works | works | works | works | expected | expected | works (stacked) |
| per-viewer sizes (§3) | works | works | works | works | sharer side: `scaleResolutionDownBy` expected | expected | works |
| Sinema modu | works | works | works | works | expected | expected | works; landscape lock where the browser allows |
| mini player above other apps | **works over borderless games, not over exclusive fullscreen** (read, not measured) | works (panel; fullscreen Spaces read, not measured) | WM-dependent; Wayland no | Document PiP (Chromium 116+): always on top, one per page; else popup (not on top) + ⧉ classic PiP | popup + Firefox's own PiP button (no API) | popup + classic PiP | no (opens a tab) |
| click-through, opacity | yes (shell) | yes | click-through yes, opacity no | no | no | no | no |
| automatic mini | yes (`onWindowState`) | yes | yes | only if the browser calls `enterpictureinpicture` | no | no | no |
| global watching keys | yes (shell) | Accessibility permission | X11 only | in-page chords, tab focused | same | same | no |
| Hafif / Sadece ses | works | works | works | works | works | works | works |

## 13. Not verified

Real networks (loopback only: no loss, no real upload limit), real monitors
and GPUs (hardware encode/decode), eight separate computers (here one browser
on four cores), staying above a real game (`docs/izleme-kontrol.md`), Document
Picture-in-Picture (the API is in this Chromium; Playwright cannot drive its
window, so only the popup path is tested end to end), Chromium's automatic
`enterpictureinpicture`, Firefox and Safari, a phone's landscape lock.

## Test ids

`stage[data-layout|data-screens]`, `stage-toolbar`, `stage-sharing-line`,
`stage-mode-side`, `stage-mode-focus`, `stage-share-too[data-full]`,
`multishare-tip`, `multishare-tip-close`, `btn-screen[data-share-too|data-full]`,
`call-bar-talking[data-sharing]`, `tile-menu-<id>`, `tile-menu-panel-<id>`,
`tile-mini-button-<id>`, `tile-mini-<id>`, `tile-pip-<id>`,
`tile-theatre-<id>`, `tile-fullscreen-<id>`, `tile-light-<id>`,
`tile-audio-<id>`, `tile-pin-<id>`, `tile-stats-<id>`, `tile-share-mute-<id>`,
`tile-share-volume-<id>`, `tile-unwatch-<id>`, `audio-only-<id>`,
`audio-only-off-<id>`, `light-badge-<id>`, `receive-line-<id>`,
`share-sending`, `theatre[data-sharer|data-controls]`, `theatre-video-<id>`,
`theatre-share-<id>`, `theatre-pair`, `theatre-chat`, `theatre-chat-toggle`,
`theatre-speaking`, `theatre-mini`, `theatre-fullscreen`, `theatre-exit`,
`mini`, `mini-video`, `mini-name`, `mini-speaking`, `mini-close`, `mini-mute`,
`mini-volume`, `mini-next`, `mini-light`, `mini-audio-only`,
`mini-click-through`, `mini-opacity`, `mini-pip`, `mini-back`, `mini-ended`,
`mini-orphan`, `settings-watching`, `watch-setting-<key>`,
`watch-setting-opacity`, `settings-watch-keys`, `watch-key-<action>`,
`watch-key-<action>-bind`, `watch-key-<action>-clear`, `watch-key-conflict`.
