# CONTRACT-V7-PHONE — one-handed on a phone, in a call

Client-only: no wire message, server route or stored server state changes.
Widths are the existing breakpoints of `styles.css`: **phone** = at most 680 px
(the sidebar is a drawer), **no member column** = at most 960 px. Code:
`web/src/lib/phone.ts`, `web/src/components/phone/*`, `web/src/styles-v7-phone.css`.
e2e: specs 63–66, screenshots `v7-phone-*.png`.

## 1. The call bar

- On a phone, while this tab is in a voice room (`status` not `idle`), a bar sits
  above the composer (`call-bar`; with no text channel it is the bottom row and
  keeps the safe-area inset). It is reachable with the drawer closed.
- Left: the room's name and a second line, "Konuşuyor: Ayşe, Sen" from
  `voice.speaking`, else "N kişi" / "Odada yalnızsın"; "Bağlanıyor…" until
  connected. Tapping it opens the drawer (the room's people).
- Buttons, each at least 44 × 44 px: `call-bar-mute` (Sessize al / Sesi aç),
  `call-bar-deafen` (Kulaklığı kapat / Kulaklığı aç), `call-bar-camera`,
  `call-bar-screen` (only where screen sharing exists, below), `call-bar-hangup`
  (Görüşmeden ayrıl).
- They call the same engine methods as the drawer's buttons (mute and deafen go
  through the same self-toggle with its cue), so the drawer and the bar always
  agree and nothing new is signalled or renegotiated.
- Not rendered at wider widths (and hidden by CSS above 680 px).

### Screen share where the browser cannot share

`screenShareSupported()` is `typeof navigator.mediaDevices.getDisplayMedia ===
'function'`. Where it is false (most phones) no share control is offered
anywhere: no `call-bar-screen`, no `btn-screen`, no share-profile caret
(`btn-share-menu`), and Ayarlar › Görüntü shows `settings-screen-unsupported`
instead of the "Ekran sesini de paylaş" toggle. Watching others' screens is
unaffected. (The engine's own refusal stays as a backstop.)

## 2. Presence where the member column is hidden

- At no-member-column widths the sidebar ends with `drawer-presence`: online and
  offline people (`drawer-member-<id>`, `data-online`), and for anybody in a
  voice room that room's name (`data-voice-channel` = its id, empty otherwise),
  else their game activity line. Distinct test ids from the member column
  (`member-<id>`), which is still the only list on wide screens.
- On a phone the header carries `presence-pill`: up to three online faces and
  the online count (`data-online`); tapping it opens the drawer scrolled to the
  people. At least 44 px tall.

## 3. The collapsible stage

- On a phone, while the stage shows at least one tile (a screen I watch, a
  camera, my own preview), it carries "Küçült" (`stage-collapse`). Collapsed,
  the stage and its people strip are replaced by a one-line pill
  (`stage-expand`) naming what is on it ("Ayşe ekranı, Mehmet kamerası") with
  "Göster".
- Remembered per device: `localStorage["trio.v7.stageCollapsed"] = "1"` while
  collapsed (absent otherwise). Wider screens ignore it and never collapse.
- **Collapsing is layout only.** The tiles stay mounted and hidden with CSS:
  streams keep arriving and decoding, a shared screen's sound keeps playing,
  the sharer still counts this device as watching, and nothing is signalled or
  renegotiated. Not receiving a screen remains the V6 "İzlemeyi bırak"
  (CONTRACT-V6-VOICE §2), per screen and told to the sharer; collapsing never
  becomes one. Since CONTRACT-V12-WATCHING §3 a collapsed tile asks the
  sharer for a small picture (`watch.size: "thumb"`): still watching, still
  heard, never off. The frame is always the same wrapper (`display: contents` while
  inactive), so tiles are never remounted by it appearing.

## 4. The user bar and adding channels

- The bottom user bar has no sign-out button. Signing out is Ayarlar › Hesap ›
  "Çıkış yap" (`settings-sign-out`), which opens the existing safe-logout
  dialog (with "make a device code first").
- One "+" in the sidebar header (`add-channel`) opens a menu asking which kind:
  `add-channel-text` (Metin kanalı) or `add-channel-voice` (Ses kanalı); the
  name form then appears in that kind's section as before. Escape or a tap
  outside closes the menu. The menu only creates: renaming and deleting a
  channel belong on the channel's own row, not here.

## 5. Settings in sections

Seven sections, in order: Ses (devices, noise suppression, input mode and
push-to-talk, input sensitivity and AFK, shortcuts, cue sounds and "rahatsız
etme", connection test), Görüntü (camera, screen sharing), Bildirimler, Hesap
(profile, add a device, invite link, sign out, game status, the server's name
and icon), Depolama, Yönetim (the owner only; absent for everybody else),
Hakkında (download link, version lines).

- Tabs: `settings-tab-<id>` (`role="tab"`), panels `settings-panel-<id>`, ids
  `ses goruntu bildirimler hesap depolama yonetim hakkinda`. Only the chosen
  section is rendered; every control keeps its old test id.
- Wide screens: the list on the left, Ses open by default; arrow keys move
  along the list.
- Phones: the dialog fills the screen and opens on the list (each row with a
  one-line summary, at least 44 px); choosing one shows that section with its
  title and a back button (`settings-back`).
- Opened to make a device code (from the sign-out dialog) it opens straight on
  Hesap.
