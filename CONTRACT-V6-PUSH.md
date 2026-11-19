# Trio — contract, sixth layer: the phone and notifications (adds to v1–v5)

Until now Trio existed only while a tab was open. This layer makes it an
installable web app whose server pushes notifications (Web Push: RFC 8030
delivery, RFC 8291 payload encryption, RFC 8292 VAPID) for new messages,
mentions, a voice room opening and rings, decided ON THE SERVER from
preferences stored on the server. Everything is additive: an old client keeps
working (it never subscribes, it never reports viewing — see §3), and a new
client against an old server gets 404s from `/api/push/*` and shows nothing.

---

## 1. Keys

The server makes one P-256 VAPID key pair the first time it starts and keeps
it in the database (`push_vapid`, one row). The owner sets nothing. Losing the
database loses the key, and every browser subscription made with it stops
working (the client re-subscribes on its next start, §6).

    GET /api/push/key   (auth)  → 200 {"public_key": "<base64url, 65-byte uncompressed point>"}

Optional `TRIO_PUSH_SUBJECT` (`mailto:…` or `https://…`, no spaces): the
VAPID `sub` claim. Unset: the app's own `https://` origin as seen in the
`Origin` header when the device subscribed, else
`mailto:trio-push@users.noreply.github.com`. Apple refuses a `sub` that is not
a URL or `mailto:` (`BadJwtToken`).

## 2. Subscriptions

    GET    /api/push/subscriptions        (auth) → 200 {"subscriptions": [Device]}
    PUT    /api/push/subscriptions        (auth) {endpoint, keys: {p256dh, auth}, ua_family?, label?}
                                                 → 200 {"subscription": Device}
    DELETE /api/push/subscriptions/{id}   (auth) → 204 | 404 NOT_FOUND
    POST   /api/push/test                 (auth) {subscription_id} → 200 {ok, status, error, removed}

    Device = {id, label, ua_family, created_at, last_ok_at, last_error}   (never the endpoint)

- `PUT` is an upsert by `endpoint`: the same browser again is the same row (its
  keys and session are refreshed). An endpoint held by ANOTHER user moves to the
  caller (a shared browser signed in as somebody else).
- At most 10 per user: an 11th is `409 TOO_MANY_SUBSCRIPTIONS`.
- `keys.p256dh` must be a base64url uncompressed P-256 point, `keys.auth` 16
  bytes: else `422 INVALID_SUBSCRIPTION`. `ua_family` ∈ chrome, edge, firefox,
  safari, samsung, opera, electron, other (anything else → other). `label` is
  trimmed to 40 printable characters (default "Cihaz").
- **The endpoint is a URL the client chose and the server will POST to.** It
  must be `https`, port 443, no user info, and its host one of
  `ALLOWED_PUSH_HOSTS` (`server/trio_server/push.py`, tested as a constant):
  `fcm.googleapis.com`, `updates.push.services.mozilla.com`, `*.notify.windows.com`,
  `*.push.apple.com`. Else `422 PUSH_ENDPOINT_NOT_ALLOWED`. At SEND time the
  host is resolved again; every address must be public (not private, loopback,
  link-local, CGNAT, multicast, reserved, or an IPv4-mapped one of those), and
  the request goes to the checked address with `Host` and TLS SNI set to the
  name, so a second DNS answer cannot redirect it. Redirects are never
  followed. A name that resolves privately is not "gone" (the row stays,
  `last_error` says why); it is not retried.
- **A subscription belongs to the session (token) that made it.** `DELETE
  /api/session` deletes that token's subscriptions; a token revoked by the
  admin tool stops receiving at once (sends join on `tokens`).
- `POST /api/push/test` sends a test push to one of the caller's devices
  synchronously and reports what the push service answered: `ok` (2xx),
  `status` (HTTP status or null), `error` (short text or null), `removed`
  (404/410: the row was deleted). 5 per minute per user (`429 RATE_LIMITED`).
  It ignores preferences and viewing state: it is the owner's debugging tool on
  real phones.

## 3. Viewing

    client → server   client.viewing {viewing: bool, channel_id?: int|null}

Sent by the client on every `ready` (each new connection) and whenever looking
at the app changes (`lib/viewing.ts`: visible AND focused) or the open channel
changes. Wrong types → `error BAD_REQUEST`. Nothing is broadcast. The hub keeps
it per connection. A connection that never reported (an old client) counts as
viewing for 30 s after it connected and as not viewing afterwards.

A user "is viewing" when ANY open connection of theirs is. Viewing suppresses
EVERY push (messages, mentions, voice, rings) to all of that user's devices:
when they look at the app on one device (any channel), in-app unread and the
ring band are enough. Otherwise the desktop tab left in the background would
swallow the phone's pushes — so a background tab, which reports `false`, does
not.

## 4. Mentions

`@ad` is matched in plain text against the CURRENT user names, folded like name
uniqueness (NFC text, then per character: NFKC, Turkish İ/ı → i, lower case,
U+0307 dropped). `@` must not follow a letter, digit, mark or `_`; the name
must not be followed by one. Longer names match first and a span is used once
(`@Ali Veli` is not also `@Ali`). `@herkes` mentions everybody. Implemented
twice, identically: `server/trio_server/mentions.py` (decides pushes) and
`web/src/lib/notify/mentions.ts` (highlight); both run
`web/src/lib/notify/mentionCases.json`.

## 5. What is pushed, to whom — decided on the server

Preferences, per user (`GET /api/push/prefs` → `{prefs}`; `PUT /api/push/prefs`
with any subset → `{prefs}`, merged; `422 INVALID_PREFS` names the bad field):

    {
      "channels": {"<channel id>": "all" | "mentions" | "none"},   // absent = all; null resets
      "quiet": {"enabled": false, "start": "23:00", "end": "08:00", "tz": "Europe/Istanbul"},
      "voice_rooms": true,        // "X ses odasına girdi"
      "calls": true,              // rings ("Çağrılar")
      "calls_break_quiet": false  // "Çağrılar sessiz saatleri delebilir"
    }

Quiet hours: HH:MM, start inclusive, end exclusive, start > end runs over
midnight, start == end is no range; wall-clock time in `tz` (an IANA name the
server knows; the client sends the browser's own zone). On a DST day the range
follows the clock on the wall.

Events and recipients — every user except the actor, with at least one live
subscription:

| event | when | payload `kind`, `tag` | TTL, Urgency |
|---|---|---|---|
| message | `message.send` stored | `message` (or `mention`), `ch-<channel>` | 6 h (mention 24 h), high |
| voice | a room goes from empty to one person by an ordinary join (not a resume); 10 min cool-down per room (the clock starts at every opening, announced or not) | `voice`, `voice-<channel>` | 600 s, normal |
| ring | `voice.ring` accepted | `ring`, `ring-<channel>` | 60 s, high |

The decision (`notify.decide`, tested as a table):

| | own | viewing | level none | mention | level mentions | quiet | other |
|---|---|---|---|---|---|---|---|
| message | no | no | no (even a mention) | **yes** (breaks "mentions" and quiet) | no | no | yes |
| voice | no | no | no | — | no | no | no if `voice_rooms` off or the recipient is in ANY voice room; else yes |
| ring | no | no | (no channel level) | — | — | no unless `calls_break_quiet` | no if `calls` off or in that room; else yes |

Payload (JSON, UTF-8, encrypted; well under 4 KB — bodies are cut to 120
characters):

    {v: 1, kind, title, body, tag, channel_id, message_id?, author?, channel?, renotify?}

- message: `title` "Mehmet — #genel", `body` the text with whitespace folded, or
  "📎 fotoğraf" / "🎤 sesli mesaj" / "📎 video" / "📎 dosya" for attachments only;
  `author`, `channel` for the collapsed form. A mention adds `renotify: true`.
- voice: `title` "Mehmet ses odasına girdi", `body` "🔊 Sohbet".
- ring: `title` "Trio — sesli çağrı", `body` "Mehmet seni Sohbet odasına çağırıyor", `renotify: true`.
- test: `kind: "test"`, `tag: "test"`.

Editing or deleting a message does not retract a notification.

Sending happens off the request path: the hub's hooks put a job on a bounded
in-process queue (500; full → dropped and logged, never blocking chat); four
workers read the subscriptions, encrypt (`aes128gcm`, one 4096-byte record) and
POST with `TTL`, `Urgency`, `Content-Encoding: aes128gcm` and `Authorization:
vapid t=<ES256 JWT, exp 12 h, reused 6 h>, k=<public key>`. 2xx → `last_ok_at`;
404/410 → the row is deleted; 429/5xx/transport error → retried after 2 s,
10 s, 60 s (or `Retry-After`, capped at 300 s), at most 4 attempts; anything
else → `last_error`.

## 6. The client

- `web/public/manifest.webmanifest`: `id`, `scope` `/`, `display: standalone`,
  `any` and `maskable` icons (the icon's motif sits inside the 80 % safe zone).
- `web/public/sw.js`, served by the server with `Cache-Control: no-cache`,
  `text/javascript`, its own CSP, `Service-Worker-Allowed: /`; registered with
  `updateViaCache: 'none'`; `skipWaiting` + `clients.claim`. **No fetch handler,
  no cache**: the product is online-only and a caching worker would bring back
  the stale-client problem `lib/buildCheck.ts` prevents (e2e 55 proves a deploy
  still reloads the tab and replaces the worker).
  - `push`: always shows a notification (Safari revokes push otherwise; an
    unreadable payload shows "Trio / Yeni bildirim"). Same `ch-<id>` tag as a
    notification still shown → one notification, "N yeni mesaj · Ayşe: …",
    with `data.count`. App badge = sum of the shown message counts
    (`setAppBadge`, where supported).
  - `notificationclick`: focus a Trio window and `postMessage({type:
    'trio.open', channel_id, kind})` (a text channel is opened, a voice room
    opens the drawer); no window → `openWindow('/?open=<id>&kind=<kind>')`,
    which the app reads once and removes from the address.
  - `pushsubscriptionchange`: subscribe again with the same key; the page
    sends the new subscription to the server on its next start (the worker
    holds no token, on purpose).
  - `message {type: 'trio.viewed'}` from the page: close the message
    notifications and clear the badge.
- Notifications a tab shows itself (messages, "girdi", rings while it is open
  and not looked at) go through `registration.showNotification` with the same
  tags and `data`, so clicks take one path; they are skipped on a device the
  server pushes to (no doubles) and follow the same preferences.
- Ayarlar › Bildirimler: the permission state with its explanation (default →
  "Bildirimlere izin ver", asked from the click; denied → how to re-enable per
  platform; iOS in Safari → the home-screen requirement; insecure; unsupported;
  no Push API), "Bu cihazda bildir", the device list with "Kaldır", per-channel
  levels (also on a channel's context menu: "Hepsi / Yalnız @ben / Kapalı";
  voice rooms have no "@ben"), "Ses odası açılınca", "Çağrılar", quiet hours
  with time pickers and time zone, "Çağrılar sessiz saatleri delebilir",
  "Deneme bildirimi gönder" with what the push service answered.
- "Ana ekrana ekle" card: iOS Safari not standalone → the two steps; Chromium →
  the browser's install dialog when `beforeinstallprompt` fired. Dismissed for
  good (`localStorage` `trio.installCard.dismissed`).
- Mentions of me (or `@herkes`) in somebody else's message: the row gets
  `mentions-me`; every `@ad` is emphasised.

## 7. Platform limits (what this cannot do)

- iOS/iPadOS: Web Push only for a web app added to the Home Screen and opened
  from there, iOS 16.4+; the permission must be asked from a gesture; no
  silent pushes; notification action buttons are not supported (none are used).
- Android Chrome: full support; battery savers of some manufacturers delay or
  drop pushes to apps the system thinks idle.
- Desktop browsers: pushes arrive only while the browser process runs. The
  Electron app does not register a push service (Electron has no Web Push
  provider); it keeps the in-tab notifications.

## 8. TEST ONLY: `TRIO_TEST_PUSH_SERVICE`

`TRIO_TEST_PUSH_SERVICE=http://127.0.0.1:<port>` (or `localhost`) accepts
endpoints under exactly that origin without the allowlist and the DNS check,
so the e2e suite can run a fake push service. Refused at startup when any of
`RAILWAY_ENVIRONMENT`, `RAILWAY_ENVIRONMENT_NAME`, `RAILWAY_PROJECT_ID` is set,
and when it is anything but an http loopback origin with a port. Never set it
in production.

## Schema

New tables, created on boot (`CREATE TABLE IF NOT EXISTS`; an older database
gains them): `push_vapid`, `push_subscriptions` (cascade on user delete),
`push_prefs` (JSON per user). Distinctly named so they cannot collide with any
other layer's `meta` table.
