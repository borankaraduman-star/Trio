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
