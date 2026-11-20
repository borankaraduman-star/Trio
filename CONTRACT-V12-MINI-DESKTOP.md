# Trio — contract, watching a share from inside a game: the desktop side (adds to v1–v11; where they differ, this wins)

Owner's request: somebody WATCHING a friend's screen share is usually playing a
game (borderless or fullscreen, hands busy). They watch in a small
picture-in-picture window that stays above the game, and control it with
global keys, without leaving the game. This file is the desktop shell's half:
the window rules, the bridge, the keys, and what the platforms allow. The web
client's half (the mini page, the controls, the settings) is its own contract
and refers to this one.

Code: `desktop/src/shared/mini.ts` (the rules, pure), `desktop/src/main/miniWindows.ts`
(the manager), `desktop/src/main/miniBounds.ts` (remembered places),
`desktop/src/shared/watchHotkeys.ts` + `desktop/src/main/ptt.ts` (the keys),
`desktop/src/main/windowState.ts`, `desktop/src/preload/mini-preload.ts`.

## 1. How a mini window is opened (the only window a page may open)

The web client opens it itself and attaches the stream from the opener:

    const w = window.open(`${location.origin}/mini.html?m=${id}`, `trio-mini-${id}`, 'popup,width=480,height=270')
    w.document.querySelector('video').srcObject = stream        // the opener drives the child

The main window's `setWindowOpenHandler` allows it only when **all** hold:

- the opener is the main window's top frame, on the configured server's origin
  (checked again on the created window: `webContents.opener` must be that
  frame; a cross-origin iframe of the page cannot open one);
- the URL is the server's origin (scheme, host and port), path exactly
  `/mini.html`, exactly one query parameter `m` equal to the id, no fragment,
  no credentials;
- the frame name is `trio-mini-<id>`, `id` matching `^[A-Za-z0-9_-]{1,64}$`;
- fewer than **4** mini windows exist (windows being created count; an allow
  that never became a window stops counting after 10 s);
- no window with that id is open. Opening an open id is refused and the
  existing window is shown (without focus) instead; the page should call
  `mini.show(id)`.

Anything that looks like a mini (frame name starting `trio-mini-`, or the
`/mini.html` path) and is not exactly one is **denied** (not sent to the system
browser). Everything else keeps the old rule: http(s)/mailto links go to the
system browser, nothing opens inside the app.

`/mini.html` must be served directly: a redirect on its first load is refused
like every other redirect of a window that is not the main one.

**The features string is not trusted.** Electron builds a child window from
the features string FIRST and the handler's options on top, and its parser
passes nearly any key through (measured on Electron 45.3.4 under xvfb:
`transparent`, `modal`, `opacity`, `enableLargerThanScreen`, `maxWidth`,
`titleBarStyle`, `thickFrame`, `center`, `zoomFactor`, …). So the shell writes
out every option itself (`miniWindowOptions`) and applies the ones that matter
again after creation. Of the features it reads exactly two: a first
`width`/`height` (used only when nothing is remembered, capped like any size),
and `focusable=no` (see §3).

**Lifetime.** Every mini window closes when the main window closes, starts a
new document (navigation, reload, server change), or its renderer dies; also
when the app quits. When the page closes a child (`w.close()` or
`mini.close(id)`), its state is cleaned up and one final state with
`closed: true` is sent.

## 2. The bridge (all members optional; an older app has none)

On `window.trioDesktop` (main window, server origin only):

    mini?: {
      supported: true,
      setOptions(id, { opacity?, clickThrough?, alwaysOnTop?, aspect?, contentProtection? }): void   send   trio:mini-options
      show(id): void                                                                             send   trio:mini-show
      hide(id): void                                                                             send   trio:mini-hide
      close(id): void                                                                            send   trio:mini-close
      onState(cb: (s: { id, visible, clickThrough, bounds: {x,y,width,height}, closed? }) => void): () => void
                                                    invoke trio:mini-states (every open window at once), then on trio:mini-state
    }
    setWatchHotkeys?(keys: { toggleMini?, nextShare?, clickThrough?, muteShare?, shareVolumeUp?, shareVolumeDown?, theatre? : string | null }): void
                                                    send   trio:set-watch-hotkeys
    onWatchHotkey?(cb: (action) => void): () => void                 on     trio:watch-hotkey
    onWindowState?(cb: (s: { focused, minimized, hiddenToTray, fullscreenAppInFront? }) => void): () => void
                                                    invoke trio:window-state-get (at once), then on trio:window-state

**Deviations from the seam the orchestrator fixed (additions only; nothing removed or renamed):**

1. `setOptions` also takes **`contentProtection?: boolean`** (§3; default off).
2. A mini state may carry **`closed: true`**, sent exactly once when the window
   has closed (by the page, by the shell, or by the OS). Without it the page
   could not tell "hidden" from "gone".
3. `onState` and `onWindowState` deliver the current state **at once** on
   subscribing (like `onListening`), then each change.
4. The mini page gets `window.trioMiniWindow = { isDesktop: true }` and
   nothing else (§5).

Every channel is checked in the main process with `fromServerPage` (main
window, top frame, configured origin); main → page messages go only to the
server page. An `id` is validated (`^[A-Za-z0-9_-]{1,64}$`) in the preload and
again in main, and addresses only a window this shell created for the calling
origin; anything else does nothing. `setOptions` drops unknown fields and
wrong types.

| option | effect | range / default |
|---|---|---|
| `opacity` | `setOpacity` | clamped to **0.4–1** (so no window is invisible); default 1. Windows and macOS; Linux ignores it |
| `clickThrough` | `setIgnoreMouseEvents(true, {forward: true})` / `(false)` | default off |
| `alwaysOnTop` | `setAlwaysOnTop(true, 'screen-saver')` (+ macOS/Linux `setVisibleOnAllWorkspaces(true, {visibleOnFullScreen: true, skipTransformProcessType: true})`) / `setAlwaysOnTop(false)` | default **on** |
| `aspect` | width ÷ height: `setAspectRatio`, and the window is brought to it (width kept when it fits; it grows towards the corner it sits in) | 0.2–5, or 0 to unlock; default: the first bounds' ratio (16:9) |
| `contentProtection` | `setContentProtection` | default **off** (§3) |

## 3. The window

- Frameless, resizable with a locked aspect ratio, not minimizable,
  maximizable or fullscreenable, no taskbar entry, opaque black background,
  `type: 'panel'` on macOS (a panel does not activate the app when clicked).
- **Shown without stealing focus**: created hidden, `showInactive()` on
  `ready-to-show`. `show(id)` is `showInactive()` too.
- **Focusable** by default (the page may want keyboard input in it).
  `focusable=no` in the features makes it a window clicks do not activate —
  better for gaming (the game keeps the keyboard), measured to take effect
  under Linux/X11 (`isFocusable() === false`); whether dragging and the
  page's buttons still work that way on Windows is part of
  `docs/izleme-kontrol.md`.
- **Same hardened webPreferences** as the main window (sandbox,
  contextIsolation, no node, webSecurity, no webview) plus
  `backgroundThrottling: false`, `zoomFactor: 1`, and its OWN preload. Without
  that override Electron gives a `window.open` child its opener's preload —
  the whole `trioDesktop` bridge.
- The mini page cannot navigate anywhere (its first load is let through once,
  for exactly the URL that was allowed: Electron reports a child's first load
  as `will-navigate`), cannot open windows (not even to the system browser),
  gets no permission (the handler still grants only the main window), and
  cannot start a screen capture (`setDisplayMediaRequestHandler` now refuses
  any frame that is not the main window's).
- The screen-share picker lists no mini window (they are the app's own).

**Size and place.**

- Minimum 160 × 90. **Maximum 60 % of the work area's width and height of the
  display it is on**, always — also for a hand resize, because the shell
  cannot tell the user's drag from a page's `resizeTo`. With always-on-top that
  is the anti-overlay rule: a hostile server's page cannot cover the screen
  with a window that takes the clicks (and opacity cannot go under 0.4, so it
  cannot be an invisible one either). `focusable: false` never comes with
  full-screen bounds for the same reason. Bigger than that is what the main
  window's stage and theatre mode are for.
- Always fully inside a work area: a `moveTo` off the screen is pulled back;
  displays added, removed or rescaled re-clamp every window.
- A drag that ends within 24 px of an edge snaps to 8 px from it (a corner is
  two edges). Windows/macOS: on `moved` (the end of the drag); Linux, which has
  no `moved`: half a second after the last `move`. A `move` mid-drag on
  Windows/macOS never makes the window jump.
- **Remembered per id class** (the id up to its first `-` or `_`: `screen-u12`
  → `screen`), with the display it was on, in `<userData>/trio-mini.json`
  (16 classes at most). On the next open of that class: the same place if that
  display (or one holding the remembered centre) is still there, clamped into
  its work area; otherwise the bottom-right corner of the main window's
  display. A second window does not open on top of the first: it stacks above
  (then left of) it.

**Click-through and getting it back.** A click-through window cannot be
clicked, so the page cannot be the only way back:

- the **`clickThrough` watch key is handled in the main process**: it toggles
  directly (any visible window click-through → all clickable; otherwise every
  visible window click-through), THEN tells the page (`onWatchHotkey
  ('clickThrough')`, already applied: the page must **not** toggle again, only
  reflect `onState`). Not while the main window is focused: that is where keys
  are bound, and the page's own controls are at hand there;
- the tray menu has **"Mini oynatıcı: tıklamayı geri aç"** while any window is
  click-through;
- `setOptions(id, {clickThrough: false})` from the page.

Click-through is **not** turned off when the main window regains focus
(decided): somebody who sets it, alt-tabs to Trio to type a line and goes back
to the game would otherwise find the window catching the game's clicks again.

**Content protection (default off).** On, the window is left out of screen
captures — the user's OWN screen share then does not show their friends the
friend's stream in a corner (a mirror of the share). The costs: Windows 10
before 2004 shows a black rectangle instead (WDA_MONITOR); recording tools
(OBS, the Game Bar) cannot see it either; macOS 15+ apps that use
ScreenCaptureKit capture it anyway (Electron's docs, Apple forums); Linux has
no such thing. Read, not measured. The web may offer it as a setting.

## 4. The watching keys

    toggleMini  nextShare  clickThrough  muteShare  shareVolumeUp  shareVolumeDown  theatre

- On the ONE uiohook instance PTT already uses; the hook runs while PTT, a
  mute/deafen key or any watch key is set. A held key fires once.
- A key is a `KeyboardEvent.code` (`"F9"`), a mouse side button
  (`"MouseMiddle"`, `"MouseBack"`, `"MouseForward"`), or **a chord** in the
  page shortcuts' format: `Ctrl`, `Alt`, `Shift`, `Meta` (any order) `+` one
  non-modifier code, e.g. `"Ctrl+Shift+F9"`. uiohook reports the modifier
  state with each key, so chords are supported here (the V6 mute/deafen keys
  stay single keys). A chord matches only with exactly its modifiers; a plain
  key only with none (so `F9` and `Ctrl+F9` are two keys). Mouse buttons take
  no modifiers.
- **Refused** (not registered, logged, and to be shown by the settings with
  these sentences — `WATCH_REASONS` in `shared/watchHotkeys.ts`):

  | why | sentence |
  |---|---|
  | the PTT key's physical key (chord or not: PTT listens whatever modifiers are held) | Bu tuş bas-konuş tuşu; başka bir tuş seç. |
  | the mute key's physical key | Bu tuş sessize alma kısayolu; başka bir tuş seç. |
  | the deafen key's physical key | Bu tuş kulaklık kısayolu; başka bir tuş seç. |
  | the same key as an earlier watch action (in the order above) | Bu tuş başka bir izleme kısayolunda; başka bir tuş seç. |
  | a code the hook does not know | Bu tuş kullanılamıyor; başka bir tuş seç. |

  The refusals are decided again whenever PTT, mute or deafen changes: a watch
  key blocked by PTT works once PTT moves to another key. The page should check
  the same rules before it sends, as V6's `hotkeyConflict` does; the shell's
  check is the backstop.
- **While a key is being bound**, the page ignores the actions it receives (its
  `isBinding()`, as for mute/deafen). The one action the shell applies itself,
  `clickThrough`, is skipped while the main window is focused — which is when
  binding happens.
- A navigation clears the watch keys; the page sets them again.
- **Defaults: none bound** (games use most keys). Recommended presets for the
  settings: `Ctrl+Shift+` with an F-key (e.g. toggleMini Ctrl+Shift+F9,
  clickThrough Ctrl+Shift+F10, nextShare Ctrl+Shift+F11). Avoid `Ctrl+Alt+`
  letters and digits: on a Turkish Q keyboard AltGr is reported as Ctrl+Alt and
  types `@` (Q), `€` (E), `₺`… in game chat. Avoid `Alt+Shift` (Windows' layout
  switch) and `Ctrl+Shift+Escape`.

## 5. The mini page and its preload

`desktop/src/preload/mini-preload.ts` exposes `window.trioMiniWindow =
{ isDesktop: true }` (frozen) and **no IPC at all**: the page is driven by its
opener (same origin, same renderer process). It may use the flag to draw its
drag strip. The page itself sets `-webkit-app-region: drag` on the strip and
`no-drag` on every button; while click-through is on nothing in the window can
be clicked or dragged (by design), and it comes back clickable through §3.

`onWindowState` describes the MAIN window, debounced (150 ms) and sent only on
change: `focused`, `minimized`, `hiddenToTray` (hidden and not minimized). The
page can use it to, e.g., open the mini player when the main window goes to the
tray during a share. **`fullscreenAppInFront` is never set**: nothing tells it
reliably on all three platforms (Windows' `SHQueryUserNotificationState` says
"busy" for any fullscreen app, presentations included, and needs native code),
so it stays undefined rather than guessed.

## 6. Tray

While at least one mini window exists: **"Mini oynatıcıyı gizle"** (when any is
visible: hides all) or **"Mini oynatıcıyı göster"** (shows all, without focus),
and while any is click-through **"Mini oynatıcı: tıklamayı geri aç"**. The
menu is rebuilt only when one of these changes.

## 7. What the platforms allow (honest notes)

| | Windows | macOS | Linux X11 | Linux Wayland |
|---|---|---|---|---|
| Above a **borderless / windowed** game | yes, topmost (`screen-saver` is just TOPMOST there) — read, not measured | yes, `screen-saver` level | depends on the WM; worked under xvfb (`isAlwaysOnTop`) | probably **not**: Wayland gives apps no stacking or position control |
| Above an **exclusive-fullscreen** game | **no** — no normal window can overlay exclusive fullscreen (DirectX flips the display). Recommend "borderless"/"windowed fullscreen" in the game | games mostly use a fullscreen Space: `visibleOnFullScreen` + panel should show it there — read, not measured | depends on the game and WM | no |
| Click-through | yes (`forward` keeps hover) | yes | yes (no `forward`) | not guaranteed |
| Opacity | yes | yes | ignored | ignored |
| Snap / remembered place | yes | yes | yes | **no**: Wayland forbids apps setting their own position |
| Content protection | Win10 2004+; black box before | ignored by ScreenCaptureKit apps on macOS 15+ | no | no |
| Global keys | yes | needs Accessibility/Input Monitoring (as PTT) | XRecord | only while an X11/XWayland window is focused (as PTT) |

Electron 45 defaults to Wayland on Linux where available; the app does not
force X11.

## 8. Verified, and not

**Verified here** (Linux container, Electron 45.3.4 under xvfb, the real built
app against a local page, `desktop/scripts/mini-smoke.cjs`): the page opens a
mini window and every wrong one (other name, other origin, other path, id
mismatch, extra parameter, a fifth window, a nested open from the mini page)
is refused; the child loads `/mini.html` with only `trioMiniWindow` (no
`trioDesktop`); it is always on top, not focused when shown, not fullscreenable;
the opener reaches its DOM and a `captureStream()` set as `srcObject` from the
opener plays in it (320×180, readyState 4); a features string asking for
3000×2000, `transparent=yes`, `opacity=0.1` gets 60 % of the screen and an
opaque window; `resizeTo(5000,5000)` + `moveTo(-3000,-3000)` from the opener are
pulled back; `setOptions` (click-through, aspect 4:3) applies; `focusable=no`
gives a non-focusable window; `close(id)` reports `closed`. Unit tests cover
the rules, the manager (with fake windows/screens), the keys (with a fake hook)
and the wiring.

**Not verified** (no real Windows or macOS here): staying above a real
borderless game; exclusive fullscreen (expected: not above it); click-through
and its rescue key in a game; opacity; content protection; `focusable=no`
dragging on Windows; the macOS panel over a fullscreen Space; CPU use of a
second video window; Wayland. The owner's 5-minute check is
`docs/izleme-kontrol.md`.
