# Trio — contract, seventh layer: reading (adds to v1–v6)

Read state that follows a person across devices, where a channel opens, the
composer, and managing channels. Everything is additive: an old client keeps
working (it never sends `channel.read`, it ignores `read_state` and the new
frames), and a new client against an old server falls back to what it did
before (unread per device in `localStorage`).

---

## 1. Read state on the server

    ready.read_state  {"<text channel id>": {last_read, latest, unread}}

- `last_read`: the id of the newest message this USER has seen in the channel
  (0 = nothing stored). `latest`: the channel's newest message id (0 = empty).
  `unread`: messages after `last_read` written by somebody else, **at most
  100** (`reading.UNREAD_CAP`; a client shows "99+" past 99).
- Every text channel is listed; voice channels never are.
- It is read under `db.write_lock` (the lock every message is stored under)
  and the connection is registered before the lock is released, so a message
  is either counted here or arrives as `message.new` on the new socket — never
  neither.

    client → server   channel.read {channel_id, message_id}
    server → my OTHER connections   channel.read {channel_id, message_id, unread}

- "I have seen the channel up to `message_id`." Marks only move forward: a
  `message_id` at or below the stored one changes nothing and sends nothing.
  One above the channel's newest message is lowered to it.
- Refused with an `error` frame (nothing stored): not a text channel →
  `INVALID_CHANNEL`; `message_id` not an integer ≥ 1 → `BAD_REQUEST`; more
  than 120 per user per minute → `RATE_LIMITED` (`request: "channel.read"`).
- A mark that moved is sent to the user's OTHER open connections only (the
  sender knows), with `unread` counted after the new mark. **Nobody else is
  ever told anything about who read what**: no read receipts (product
  decision).
- Table `read_state (user_id, channel_id, last_read_message_id, updated_at)`,
  primary key the pair, both cascading. Created on boot; an older database
  gains it empty. A new account (`POST /api/join` with the invite code) gets
  a row per text channel at its newest message: history from before somebody
  arrived is not unread. Upgraded accounts start without rows (counts up to
  the cap) until their devices tell the server what they remember (below).
- Push decisions (CONTRACT-V6-PUSH §5) do **not** read it: a push is decided
  when a message is stored, which is before anybody could have read it.

### The client

- `ready.read_state` is merged with the device's own `trio.lastRead`
  (localStorage, still written as a cache): each channel keeps the LARGER
  mark. When the device's is larger it is sent with `channel.read` (this is
  the migration from the old per-device memory) and the count shown is "at
  least one" while anything is newer; otherwise the server's `unread` is shown.
- Whenever the device's mark moves past what the server is known to hold
  (opening a channel, a message arriving while it is looked at, one's own
  message), `channel.read` goes out, at most one round per 400 ms
  (`useReadSync.ts`). A frame the socket could not take goes after the next
  `ready`.
- `channel.read` from another device of mine moves the mark and sets the
  channel's count to the frame's `unread` (0 when the mark is the newest
  message). The sidebar dot, the tab title `(n)` and so the desktop badge
  (which reads the title) follow it.
- Without `ready.read_state` (an older server) nothing is sent and every
  channel's newest id is probed as before.

## 2. "Yeni mesajlar" and opening at the first unread (client only)

- Opening a text channel (switching to it, the first page after a reload, or
  coming back to the tab) while its mark is BEHIND its newest message
  remembers the mark as the channel's divider for the visit. The channel is
  marked read as before (being opened while looked at is reading it).
- A device with no mark for the channel at all (0) gets no divider and opens
  at the bottom, as before.
- The list (`MessageList`, `lib/newMessages.ts`) draws a `Yeni mesajlar` line
  (`data-testid="new-messages-divider"`, no `data-key`, so the scroll anchor
  never holds on it) above the first held message after the mark, and when it
  MOUNTS with a divider it opens with that line near the top instead of at the
  bottom. When the mark is older than the loaded page it loads older pages
  (the ordinary `before=` page) up to 4 times; past that it opens at the
  oldest loaded message.
- The divider goes when the person leaves the channel or sends a message in
  it. A divider that appears while the list is already open (back to the tab)
  is drawn without moving the list.
- After landing, every rule of the list is the old one: the anchor keeps the
  row being read in place, scrolling up loads older pages, a reader at the
  bottom stays there.

## 3. Back to the newest

- While the list is not at its bottom (more than 120 px away) a round button
  (`data-testid="jump-to-bottom"`) sits at the bottom right of the list. It
  counts the messages by OTHER people newer than the newest one there was when
  the reader left the bottom (after a landing: newer than the mark), shown on
  the button (`data-count`, "99+" past 99). A click goes to the bottom.
- Hidden while the list is `behind` a gap: the existing "Yeni mesajlar var —
  en yeniye git" does that job.

## 4. Enter on a touch device

- Rule (`lib/touchInput.ts`): a device whose only pointer is coarse
  (`(pointer: coarse)` and not `(any-pointer: fine)`) is touch-first. There
  Enter inserts a newline and the composer's "Gönder" button sends;
  Ctrl+Enter / ⌘+Enter also send (a phone with a hardware keyboard cannot be
  recognised reliably). Everywhere else Enter sends, Shift+Enter is a newline.
  An IME composition's Enter never sends. Read once per composer.
- The textarea's `enterkeyhint` is `enter` on touch and `send` elsewhere, and
  it carries `data-enter="newline" | "send"`.
- No setting: the rule decides.

## 5. Focus after a channel switch

- Switching to another text channel on purpose (the sidebar, a notification
  click) focuses the new channel's composer — never on a touch-first device
  (it would raise the on-screen keyboard), and not when a dialog, a menu or
  another field holds the focus. Nothing else moves the focus. Typing in the
  composer does not hold back a reload onto a new build unless it leaves
  text (the reload guard reads the text, not the focus). Push-to-talk's
  in-page key is ignored while a text field has the focus (as before); the
  desktop app's global key is not.

## 6. Renaming and deleting a channel

    PATCH  /api/channels/{id}  {name}           → 200 {"channel": {id, name, kind}}
           422 INVALID_CHANNEL (name 1–32, the join/create rules) · 404 NOT_FOUND
    DELETE /api/channels/{id}  {confirm_name}   → 204
           403 FORBIDDEN          not the owner (CONTRACT-V6-OPS §1)
           422 CONFIRM_MISMATCH   `confirm_name` is not exactly the channel's name
           409 CHANNEL_IN_USE     a voice channel somebody is listed in (a member in
                                  their reconnect grace counts)
           409 LAST_TEXT_CHANNEL  the only text channel left
           404 NOT_FOUND
    both: 429 RATE_LIMITED past 20 renames and deletes per user per minute

    server → everyone   channel.updated {channel}
    server → everyone   channel.deleted {channel_id}

- **Who**: renaming is anybody's, like creating a channel (three friends; the
  name is shown, nothing is lost). Deleting is the OWNER's only, because a text
  channel takes its messages with it. The typed name (`confirm_name`) is a
  guard against a slip, not a secret: unlike V6-OPS's destructive actions it
  does not ask for the invite code (nothing about the account is at stake, and
  a backup restores the data).
- Renaming to the same name answers 200 and broadcasts nothing.
- Deleting runs in ONE transaction: the channel's reactions, pins, links,
  attachment rows, messages, read state and the channel itself. The files and
  their previews are unlinked after the commit (a crash in between leaves
  files without rows, swept at the next start). Every user's push preference
  for the channel is dropped (`push_prefs`), and the voice "room opened"
  cool-down for it is forgotten. The last voice channel may be deleted; the
  seed channels are only made for an empty database.
- The client: right click, the context-menu key or a long press (touch, 450
  ms; the click that ends the press is swallowed, `lib/pressEnd.ts`) on a
  channel row in the sidebar opens the channel menu (`data-testid=
  "channel-notify-menu"`): the notification levels when push is available
  (V6-PUSH §6; voice rooms have no "Yalnız @ben"), "Yeniden adlandır"
  (`channel-rename`), and for the owner "Kanalı sil" (`channel-delete`),
  disabled with the reason when the server would refuse (somebody in the
  voice room, the last text channel). Deleting a text channel needs its name
  typed (`channel-delete-input`); a voice channel needs only the button.
- On `channel.deleted` a client forgets the channel: its messages, unread,
  marks, pins, typing, divider and this tab's draft; when it was open the
  first remaining text channel opens.

## 7. A device code as a QR

- Where a device code is shown (Ayarlar › Hesap › Cihaz ekle) a QR is drawn
  beside it (`data-testid="link-code-qr"`), encoding
  `<origin>/#cihaz=<code>` (`lib/deviceLink.ts`). It is generated in the page
  (`qrcode-generator`, MIT, bundled; error correction M; an SVG of dark
  modules on white with a four-module quiet zone): no image is fetched and
  nothing leaves the device.
- The code is in the FRAGMENT, never the query string: a browser does not send
  it to the server, so it is in no access log or proxy (CONTRACT-V3 §2's code
  is a credential for ten minutes).
- Opening such a link: the page reads `#cihaz=` (or `#device=`) ONCE on load,
  normalises it (case, spaces and dashes; a value that cannot be a code is
  dropped) and removes it from the address bar at once (`history.replaceState`,
  other fragment keys such as `#davet=` kept). Signed out, the join screen
  opens on "Zaten hesabım var" with the code filled in; the person still taps
  "Giriş yap" (nothing is redeemed without a tap). Signed in, it is dropped.
