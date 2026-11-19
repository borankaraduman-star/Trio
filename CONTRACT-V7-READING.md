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
