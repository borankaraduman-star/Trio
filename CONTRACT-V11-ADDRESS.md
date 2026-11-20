# Trio — contract, moving to a new address (adds to v1–v10; where they differ, this wins)

A group's Trio can get a nicer address (a custom domain on the same Railway
service, a VPS's own name) while the old one keeps working beside it. A
browser keeps its session in the OLD origin's `localStorage`, the desktop app
stores the old server URL, push subscriptions and the service worker belong to
the old origin, and invite and device links carry the old host. This layer
makes the move one tap per device, without anybody having to be admitted
again, and gives the owner a way back in that needs only the hosting
dashboard (§6).

Everything is additive and **off while `TRIO_PUBLIC_URL` is unset**: every
response, page and link is then exactly what v10 served.

## 1. Configuration

| variable | default | meaning |
|---|---|---|
| `TRIO_PUBLIC_URL` | unset | the canonical address, a plain origin: `https://<host>[:<port>]`, no path, query, fragment or user info (a single trailing `/` is dropped). Anything else refuses to start. Set it only once the new address serves the app with a certificate |
| `TRIO_RECOVERY_CODE` | unset | the owner's lock-out insurance (§6): at least 24 characters, none of them whitespace; anything shorter refuses to start. Unset = the feature is off |
| `TRIO_TEST_HTTP_PUBLIC_URL` | unset | TESTS ONLY: `1` lets `TRIO_PUBLIC_URL` be `http://127.0.0.1:<port>` or `http://localhost:<port>`. Refused on Railway (`RAILWAY_ENVIRONMENT`, `RAILWAY_ENVIRONMENT_NAME` or `RAILWAY_PROJECT_ID` set) |

**The request's origin** below is CONTRACT-V6-DOWNLOAD's rule: the scheme from
`X-Forwarded-Proto` (http|https) or the request's own, and the `Host` only when
it is a plain `host[:port]`; otherwise there is none. It is compared with
`TRIO_PUBLIC_URL` case-insensitively on the host.

## 2. The canonical address everywhere

With `TRIO_PUBLIC_URL` set it is the source of truth for every absolute URL the
server writes; the request's `Host` is not used for them any more:

- `/indir`: `og:*`/`twitter:*` meta, `<link rel="canonical">`, JSON-LD
  `url`/`image` (CONTRACT-V6-DOWNLOAD);
- `/robots.txt`'s `Sitemap:` and `/sitemap.xml`'s `<loc>`;
- `GET /api/health` carries it: `{"ok", "version", "persistent", "data_since",
  "public_url": "<origin>" | null}` (unauthenticated, as before).

The client builds its own links from it (`web/src/lib/address.ts`):

- invite links (Ayarlar › Hesap) and device links / their QR
  (CONTRACT-V7-READING §7) use `public_url` when the server declares one, else
  `location.origin` as before. A device code is server-wide, so a QR shown on
  the old address signs a phone in on the new one.

Unchanged on purpose: the shell CSP's `connect-src` names the REQUEST's host
(the page must reach its own websocket), `/api/downloads` and every other URL
the API returns are root-relative, push subscriptions keep the origin they were
made on (CONTRACT-V6-PUSH: a subscription belongs to an origin).

## 3. Moving one device

    POST /api/move            (Bearer; the OLD origin)   {"prefs": {key: string, ...}}
      → 201 {"code", "expires_at", "public_url", "url": "<public_url>/#tasi=<code>"}
      409 NO_PUBLIC_URL     TRIO_PUBLIC_URL is unset
      409 ALREADY_HERE      the request's origin IS the canonical one
      403 FORBIDDEN         an Origin header that is not the request's origin
      422 INVALID_PREFS     prefs is not an object (absent = {})
      413 PAYLOAD_TOO_LARGE body over 96 KiB

    POST /api/move/peek       (no auth; the CANONICAL origin) {"code"}
      → 200 {"user": {id, name}, "expires_at"}     — redeems nothing
    POST /api/join            (no auth; the CANONICAL origin) {"link_code": "<move code>"}
      → 200 {"token", "user", "move": {"prefs": {...}}}
    POST /api/move/adopt      (Bearer, a token of the SAME user; the canonical origin) {"code"}
      → 200 {"user", "prefs": {...}, "ended": n}  — this device was signed in here already
    POST /api/move/confirm    (Bearer: the token the move created)
      → 200 {"ended": 0 | 1}

    peek / join / adopt:
      403 INVALID_MOVE_CODE  unknown, expired, used, its old session is gone, its user removed
                             (the join path answers INVALID_LINK_CODE, as for any bad code)
      409 NOT_CANONICAL      asked on an origin that is not TRIO_PUBLIC_URL (or it is unset)
      409 OTHER_ACCOUNT      adopt: the code belongs to somebody else (the code is spent)
      429 RATE_LIMITED       the join limiter (CONTRACT-V3 §5)

**A move code** is a CONTRACT-V3 §2 code in shape (10 characters, same
alphabet, forgiving input) and lives **10 minutes**, single use, only its
SHA-256 stored (`move_codes`, prefix `trio-move:`, so it is never a valid link
code and the reverse). It is NOT a link code: it does not count towards the
user's 5 live link codes, and each SESSION has at most one live move code (a
new `POST /api/move` replaces it). It remembers the session it was made from
(`from_token_hash`): when that session is gone (signed out, revoked, user
removed) the code is dead. `revoke-tokens` / `remove-user` delete the user's
move codes; a backup's snapshot has none.

peek, join-with-a-move-code and adopt spend the join limiter exactly like a
join (every attempt per address; a wrong code is a failed join). A move needs
two attempts (peek + redeem) of the address's ten.

**Redeeming** (the join path) creates a new token for the user, marked as
moved (`tokens.via_move`, `tokens.moved_from` = the old session), returns the
carried preferences and DELETES them with the code: the server keeps nothing.
`POST /api/move/confirm` with the new token then ends the old session: its
token is deleted, its push subscriptions are deleted (CONTRACT-V6-PUSH), its
sockets close with 4401. Confirm is idempotent (`ended: 0` the second time).
The client confirms as soon as it has stored the new token; a confirm that
failed is retried on the next load (`trio.moveConfirm`).

**Adopt** (the device is already signed in on the canonical origin as the same
user): no new token; the old session is ended at once; prefs are returned and
the page applies only the keys it does not have yet.

### What moves (the preference allowlist)

Only these `localStorage` keys, each a string of at most 32 KiB; the whole set
at most 64 KiB (keys over the per-key cap are dropped; past the total, the
rest are dropped in this order's reverse). Anything else in `prefs` is ignored.

| key | what |
|---|---|
| `trio.settings` | devices, push-to-talk, noise suppression… (V2) |
| `trio.voice6` | volumes, gate, share profiles (V6-VOICE) |
| `trio.music8` | music sharing preferences (V8) |
| `trio.drafts` | unsent drafts (V6-MEDIA) |
| `trio.channel` | the open channel |
| `trio.lastRead` | the device's own read marks (V7: the server's are authoritative) |
| `trio.lastName` | the last name typed |
| `trio.seenVersion` | the changelog seen |
| `trio.recentEmoji`, `trio.sendOriginal`, `trio.gameShare` | small preferences |
| `trio.v7.stageCollapsed`, `trio.v10.membersHidden`, `trio.v10.showChannel` | layout |
| `trio.desktopUpdateDismissed`, `trio.desktopUpdateLater`, `trio.desktopUpdateHint` | the desktop update notice |
| `trio.invite` | the invite code this device joined with (to share as a link): kept only when it equals the server's invite code (compared in constant time), else dropped |

**Never moved:** `trio.token`, `trio.user` (the move signs the device in
itself), `trio.dataSince` (re-learned), `trio.push.device` and anything about
push (a subscription is per origin), `trio.installCard.dismissed` (installing
is a new question on the new origin), and every key not in the table (a later
feature's key is not carried until it is added here). The token never travels
in a URL, a fragment, or the prefs.

### The client

- **On an origin that is not the canonical one, signed in:** a calm band above
  everything (`data-testid="address-band"`): “Trio yeni adrese taşındı:
  <host> — [Bu cihazı taşı]”, plus one line each when it applies: “Bildirim
  iznini yeni adreste bir kez daha vermen gerekir.” (notifications were
  allowed here) and “Ana ekrana eklediysen: yeni adresi açıp yeniden ekle.”
  (running as an installed app). It never blocks the screen. The tap posts the
  allowlisted keys, stores `trio.movedTo = <public_url>` on the old origin,
  and navigates to `url` (`location.assign`), or in the desktop app asks the
  shell (§5).
- **On the canonical origin, `#tasi=<code>`:** read once on load, normalised,
  removed from the address bar at once (like `#cihaz=`). Signed out: one
  screen, “Bu cihazda <ad> olarak devam et” with the name from peek (never from
  the URL) and [Devam et] / [Vazgeç]; the tap redeems, stores the token and the
  carried preferences, confirms, and opens Trio. Signed in as the same user:
  adopt silently. Signed in as somebody else: a notice, nothing changes.
- **Back on the old origin** after the move: the session is gone; with
  `trio.movedTo` set the screen says “Bu cihaz yeni adrese taşındı” with
  [Yeni adrese git] and the carried keys are removed from the old origin.
- **Signed out on the old origin:** instead of the join form, “Trio yeni adrese
  taşındı” with [Yeni adrese git] (an `#davet=` or `#cihaz=` the page was
  opened with is carried over in the fragment) and a small “Bu adreste devam
  et” that shows the usual join form (if the new address is unreachable).
- The typed path: a move code typed into “Zaten hesabım var” on the canonical
  origin works like the link (it is redeemed through `POST /api/join`).

## 4. Where sessions are

`tokens` gains `last_origin TEXT`, `via_move INTEGER NOT NULL DEFAULT 0` and
`moved_from TEXT` (added on boot to an older database). An authenticated REST
request records the request's origin on its token when it differs from what
this process last saw for that token (an in-memory map in front of the write:
one UPDATE per token per origin change, not per request).

    GET /api/owner/address     (owner)
      → 200 {"public_url": str | null, "request_origin": str | null,
             "reachable": null | {"ok": bool, "same_server": bool, "at", "detail"},
             "sessions": {"total", "canonical", "other", "unknown", "moved"},
             "other_origins": [{"origin", "sessions"}],   (at most 5, most first)
             "recovery": {"configured": bool, "used_at": str | null,
                          "uses_this_boot": n, "max_per_boot": 3},
             "safe_to_retire": bool}

- `reachable`: the server asks `<public_url>/api/health` itself (5 s, cached a
  minute; `null` while unset); `same_server` is its `data_since` equal to ours.
- `canonical`/`other`: sessions whose last request came through that origin;
  `unknown`: none since v11; `moved`: sessions created by a move.
- `safe_to_retire`: the address is set and reachable as this server, and no
  session was last seen on another origin. **Yönetim › Adres** shows these and
  says, when `safe_to_retire`, that the old address may be dropped. The
  Railway default domain is never removed by Trio; that is the owner's call.

## 5. The desktop app

New optional bridge member (absent in older shells):

    window.trioDesktop.moveServer({origin, code}) → Promise<{ok: true} | {ok: false, reason}>

The main process never trusts the page for the address. On a request from the
server page (`fromServerPage`), it:

1. normalises `origin` with `validateServerUrl` and `code` against the code
   alphabet (10 characters), else `invalid`;
2. fetches `<stored origin>/api/health` ITSELF (no redirects) and requires
   `public_url` to be exactly `origin` (`not-declared` otherwise);
3. fetches `<origin>/api/health` and requires a Trio answer (`ok: true`)
   declaring the same `public_url` (`unreachable` / `not-trio`);
4. stores the origin, loads `<origin>/#tasi=<code>`; the navigation guards,
   permission handlers and every IPC origin check then follow the new origin.

A hostile page asking for `https://evil.example` is refused at step 2 (the
trusted server does not declare it). `TRIO_SERVER_URL` in the environment still
wins at the next start.

**Older shells** (no `moveServer`): the band says “Uygulama menüsü → Sunucu
adresini değiştir → <host>”, and the tap shows the move code as text with a
copy button; after switching, the person types it into “Zaten hesabım var”.

## 6. The owner's recovery code

`TRIO_RECOVERY_CODE` set on the host (Railway › Variables) lets the owner sign a
device in with nothing but the dashboard, also when every session is gone:

    POST /api/join  {"recovery_code": "<the value>"}   (no auth)
      → 200 {"token", "user": <the owner>, "recovery": true}
      403 INVALID_RECOVERY_CODE  wrong, or the feature is off (the same answer)
      409 NO_OWNER               TRIO_OWNER names nobody
      429 RECOVERY_LIMIT         already used 3 times since this process started
      429 RATE_LIMITED           the join limiter

- Precedence in the body: `link_code`, then `recovery_code`, then the invite.
- Compared in constant time (on SHA-256 digests, so the length is not timed);
  spends the join limiter like a join (a wrong value is a failed join).
- Each use logs `WARNING recovery.used`; it records `meta.recovery_used_at`.
- The owner (owner rule, CONTRACT-V6-OPS §1) sees a band on every screen while
  the variable is set and was used: “Kurtarma koduyla girildi — Railway'deki
  TRIO_RECOVERY_CODE değişkenini silmeyi unutma.” Removing the variable
  (a restart) clears `recovery_used_at` and the band.
- Client: “Zaten hesabım var” › “Sunucunun sahibiysen: kurtarma kodu”.

## 7. Security

- **No open redirect.** The only navigation the move makes is to the
  `public_url` the server declares in its own response (§3, `url`), and the
  desktop shell checks that against the server it already trusts (§5).
  `#tasi=` and `#cihaz=` carry a CODE, never an address; a crafted link can
  only point at the server it is opened on.
- **A pasted hostile link** (`<canonical>/#tasi=<attacker's code>`) could sign
  the victim into the attacker's account (“login CSRF”). It is not redeemed
  without a tap, and the one screen names the account from the server; a
  signed-in device is never switched to another account (`OTHER_ACCOUNT`).
- **Code leakage.** The code is in the fragment (never sent to a server, so in
  no log or proxy), removed from the address bar on load, single use, 10
  minutes, dead when its session ends, hashed at rest, out of backups. The
  token never leaves its origin.
- **CSRF / Origin.** Every new endpoint authenticates with a Bearer header
  (never a cookie) or with the code itself; `POST /api/move` additionally
  refuses an `Origin` that is not the request's own.
- **No CORS.** Nothing is requested across the two origins: each page talks
  only to its own origin, and the server joins the two halves through the code.
  No CORS header is added anywhere.
- **Host trust.** With `TRIO_PUBLIC_URL` set, no absolute URL comes from the
  `Host` header. The request origin is only compared (canonical or not) and
  counted for the owner; a forged `Host` can at worst miscount the caller's own
  session.
- **Recovery code.** Long by rule, constant-time, limited per address and per
  boot, loud in the log and on the owner's screen; it signs in only the owner.
  Anyone who can read the host's variables already controls the server.
