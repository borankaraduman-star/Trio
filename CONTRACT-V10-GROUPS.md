# Trio — contract V10: a small group, not three friends

Owner decision (20 Nov 2026): Trio was built and tuned for exactly three
friends; it is now for **any small group that runs its own server, up to
10–15 people**. This file says what that changed on the server, the wire and
the client, what was measured, and which "three" assumptions were left on
purpose. Additive on the wire: a client or server that predates it keeps
working.

## 1. Configuration

| variable | default | meaning |
|---|---|---|
| `TRIO_MAX_USERS` | **`15`** (was 5) | accounts beyond this are refused (`409 SERVER_FULL`); set it to the real head count |
| `TRIO_VOICE_ROOM_MAX` | **`8`** (new; 2–16, else the server refuses to start) | people in ONE voice room at once |

`deploy/docker-compose.yml` forwards both with the same defaults.

## 2. The voice room cap

Voice is a full mesh: every member sends audio (and camera, screen, music) to
every other member, so a room of n is n·(n−1)/2 connections and every sender
encodes and uploads n−1 copies. The cap is enforced on the server.

    client → server   voice.join {channel_id, …}
    server → joiner   error {code: "ROOM_FULL", message, request: "voice.join",
                             channel_id, limit}          — nothing joined, nothing broadcast
    client → server   voice.ring {channel_id}
    server → ringer   error {code: "ROOM_FULL", request: "voice.ring", channel_id, limit}
                             — a full room cannot call people in
    ready             {…, voice_room_max: 8}
    GET /api/server   → {"server": {name, icon_url}, "voice_room_max": 8}
    GET /api/owner/overview  limits.voice_room_max

- Counted: the people listed in the room (members in their reconnect grace
  included). The joiner's own place never counts: a second tab rejoining, a
  `resume` that takes the membership over (inside the grace or by its
  `session`) are never refused.
- **Right after a start** (a deploy) the server has forgotten the rooms and
  everybody comes back with `resume: true`: for 120 s after the process starts
  (`RESTART_RESUME_SECONDS`) no resume is refused, so a restart never drops a
  member even if the cap was lowered meanwhile. Later, a resume by somebody
  who is not listed (their grace ran out and the place was taken) is an
  ordinary join and can be `ROOM_FULL`.
- A different room is a different count; moving rooms leaves the old one first.

**Client.** Each voice channel row shows `n/max` while somebody is in it
(`room-count-<id>`, `data-room-count`). For everybody not in it a full room
reads "Oda dolu (8/8)", the row is `aria-disabled` (`data-room-full`), and a
click shows why instead of joining (`room-full-note-<id>`: "Oda dolu (8/8).
Ses odasında herkes herkese ayrı ayrı ses gönderir; bu sunucuda bir odaya en
çok 8 kişi girebilir. Biri ayrılınca katılabilirsin ya da başka bir ses
kanalı aç."). A `ROOM_FULL` answer to a join (the view was stale) stops the
engine (microphone released) and shows the same sentence as the voice error.
A refused ring says "Oda dolu: çağırdığın kimse katılamaz.". Against a server
that predates V10 (`voice_room_max` absent) no count or cap is shown.

## 3. Measured (this machine, 20 Nov 2026)

4 CPUs, Chromium of the e2e suite, every person a context in ONE browser with
fake devices (the microphone a 20 ms beep every 500 ms, the camera a
1280×720 pattern), on loopback with host candidates only. Specs 78, 81, 82
print these lines (`[78]`, `[81]`, `[82]`).

| what | result |
|---|---|
| 6 people click the room within 179 ms | 15 pairs connected 133 ms after the last click; 30 directions heard; **0 rollbacks** (explicit or an offer applied in `have-local-offer`); 5 live connections per page. Leave and storm again: the same |
| 8 people clicking at once (spec 82) | 28 pairs connected after 2.5 s; everybody hears everybody |
| 4 more joining a room of 4 at once (spec 81) | all 28 pairs connected after 4.9 s (one browser for 8 people, 1 camera on) |
| audio only, outgoing per client | 4 people: 66–71 kbit/s (3 copies of ~22 kbit/s Opus); 8 people: 146–164 kbit/s (7 copies) |
| audio concealment, 8 people | 0.13–0.73 % of samples (with 1–3 cameras running) |
| one camera, room of 4, browser's own choice | ~340–580 kbit/s per viewer, 360–540 lines (bandwidth estimate still ramping at 15 s), ~1.5 Mbit/s for 3 viewers |
| one camera, room of 8, V10 encoding | 344–367 kbit/s per viewer, 360 lines (half the 720 source), **~2.45 Mbit/s upload** for 7 viewers; 130 frames encoded per second in all (7 encodes), ~2.2 s of encoder time per second |
| 8 people, 3 cameras | each camera owner ~2.0–2.3 Mbit/s up; audio unaffected |

What this says for real people: audio scales fine to 8 (≈150 kbit/s up and
down each); cameras are what cost, because each one is encoded once per
viewer, and a screen share at "Orta" is 3 Mbit/s **per viewer** (7 viewers ≈
21 Mbit/s up, more than most home uploads).

**Decided, camera** (`lib/groups.ts` `cameraEncodingFor`, applied with
`setParameters` on each camera sender when the room size changes — never a
renegotiation, CLAUDE.md): up to 4 people the browser's own choice (as
before); 5–6 people 600 kbit/s, scaled down 1.5× (720 → 480 lines), 30 fps; 7 or more 350 kbit/s,
half size, 24 fps. Back in a small room it goes back to the browser's choice
(e2e 81).

**Recommendation, screen share** (not enforced): in a room of 5 or more,
share at "Düşük" (1.5 Mbit/s per viewer); the share menu already shows
`N izleyici × R ≈ total` and warns when the measured upload looks short
(CONTRACT-V6-VOICE §1), and "İzlemeyi bırak" stops the encode for a viewer.

**Why 8 and not more**: an 8-person room is ~150 kbit/s of audio each way per
person and 28 connections, which a phone or an old laptop holds; with cameras
it is ~2.5 Mbit/s up per camera. Above that a mesh needs a media server (an
SFU), which Trio does not have. The site should state: **"Ses odasında en çok
8 kişi (sunucu sahibi 16'ya kadar açabilir); sunucuya 15 kişiye kadar."**

## 4. Layouts with many people (client)

- **Stage**: a desktop shows up to 9 tiles, a phone 4; past that the last
  cell is "+N · Hepsini göster" (`stage-more`), which opens every tile in a
  scrolling grid (two columns on a phone) with "Daha az göster"
  (`stage-less`). Screens come first, then cameras, my own tiles last.
  Folded tiles stay mounted and playing (CSS only, like the V7 collapse): a
  folded screen's sound goes on and its sharer still counts me as watching.
  `stage` carries `data-count` and `data-shown`.
- **Call bar** (phone): up to three speakers read as before ("Konuşuyor:
  Ayşe, Sen"); four or more lead with the count, "5 kişi konuşuyor: Ayşe,
  Mehmet +3", because the line has room for a few words.
- **`@` suggestions** in the composer (`mention-list`, `mention-option-<id>`,
  `herkes` as id 0): opened by an "@" that starts a word, filtered as one
  types (folded like the mention matcher: case and Turkish İ/ı; names that
  start with it, then a word that does, then containing), at most 8, ↑/↓ to
  move, Enter or Tab to insert `@Ad `, Esc to close.
- **Avatar colours**: 16, deterministic by user id, so 15 consecutive ids
  never share one; the first seven are the old colours at the old places
  (ids 1–6 keep theirs); each carries the white initial at ≥ 5.2:1. Colour is
  an aid; the initial and the name tell people apart.
- **Yönetim**: from 8 active people a search box (`owner-people-search`,
  folded like names) and a sort (`owner-people-sort`: katılma sırası, ad, son
  görülme, depolama); removed people fold into "Çıkarılanlar (n)". The storage
  card says `15 kişi × 1 GB kota = en çok 15 GB` (`owner-quota-total`) and,
  when what everybody may still upload exceeds the free space above the
  reserve, says so (`owner-quota-shortfall`) — uploads past the disk are
  refused with "disk dolu" whatever the quota.
- Sidebar, member list, the drawer's presence (online/offline groups with
  counts), the people strip under a screen: already scrolled and grouped;
  checked with 15 accounts at 1440 and 390 px (e2e 80, `v10-groups-*.png`).

## 4a. Who is here, in a text channel (the owner's report, 20 Nov 2026)

"Desktop app: when I join Sohbet I am listed under it, but in text channels I
am not there." The member list was a right-hand column hidden at ≤ 960 CSS px
with nothing in the channel view to bring it back; Windows display scaling
puts common setups below that (a 1366×768 laptop at 150 % is ~911 px wide, a
1280×720 one at 150 % ~853). Now:

- **"Üyeler" in the channel header at every width above a phone**
  (`btn-members`, the online count on it, `data-online`, `aria-pressed`). Wide
  it shows/hides the column, remembered per device
  (`localStorage["trio.v10.membersHidden"] = "1"` while hidden; shown by
  default). At ≤ 880 px it opens the same panel over the chat from the right
  (`members-panel` with class `overlay`, `members-backdrop`, `members-close`),
  always starting closed. On a phone (≤ 680 px) the V7 presence pill is that
  control (it opens the drawer at the people).
- The panel's title says what it is: **"Üyeler — 5 çevrimiçi"**
  (`members-title`) and one line under it: text channels are seen by
  everybody; this lists everybody on the server and who is online. My own row
  carries "(sen)". A text channel has no presence of its own (unlike a voice
  room): who can read it is the whole group.
- **The column now shows from 881 px** (`NO_MEMBERS_QUERY` and the CSS were
  960): sidebar 260 + member list 220 leaves the chat 401 px at 881, which the
  header, the composer and the stage were checked at (e2e 83 at 900 and 911).
  This supersedes CONTRACT-V7-PHONE's "no member column = at most 960 px".
- **Desktop app**: the first window is the default 1280×820 DIP clamped to the
  primary display's work area (`desktop/src/shared/windowSize.ts`): DIP are
  the page's CSS px, and scaling shrinks the work area, not the window; a
  window larger than the screen was cut off at its edge.

**"I can't switch between channels"** — not reproduced. e2e 83 clicks every
text channel row at its left edge, middle and right edge, presses Enter on a
focused row, and taps on a phone, at 1440, 1100, 1000, 960, 911 (150 %), 900,
1024 (125 %), 853 (150 %), 800, 700 and 390 px, and checks the header, the
active row, the composer's channel and that the choice survives a reload; it
clicks the voice row and checks it joins and leaves the text view as it was
(a voice room is joined, never "opened": the centre stays on the text
channel, by design since v1). The desktop window has a native frame (no
drag regions over the sidebar). What is left as diagnostics: a text channel
click whose header has not changed a second later is sent to the owner's
client error log (`reportBreadcrumb`, CONTRACT-V6-OPS §5) with the viewport,
the device pixel ratio and whether it is the desktop app.

## 4b. Who is in which text channel, right now

The owner, once more: "switching works, but it is not clear who is in which
channel" — voice rooms list their people under the row, text channels did not.

    client → server   client.viewing {viewing, channel_id?, show_channel?: bool}
                      — CONTRACT-V6-PUSH §3's frame; show_channel (default true,
                        not a boolean → BAD_REQUEST) is new; at most 240 a minute
                        per user (RATE_LIMITED, request "client.viewing")
    server → everyone presence.viewing {user_id, channel_id: int | null}
    ready             {…, viewers: {"<channel id>": [user_id, …]}}   — sorted ids

- **Per user, one text channel or none**: the channel of their most recently
  reported connection that is being looked at (visible AND focused,
  `lib/viewing.ts`) and shares it. None when no connection is looked at (a tab
  in the background, the desktop app in the tray or behind another window, a
  phone with the app closed), when the connection closes, when the person
  turned "Hangi kanalda olduğumu göster" off, when the channel is a voice
  channel, unknown or deleted, and for a client that never sends the frame.
  Several devices: the one reported last wins (I sit down at the desktop and
  open #oyun while the phone in my pocket still shows #genel: #oyun; the
  desktop goes to the tray: #genel again if the phone is still looked at).
- **Coalesced**: one `presence.viewing` per user per 500 ms at most; the first
  change goes at once, the state at the end of the window follows if it
  differs from what was sent. Fast hopping costs one or two frames, never one
  per click. Sent to every socket, the person's own included.
- **Push decisions are unchanged**: the notifier keeps the whole report as
  before (a hidden channel still counts as "looking at the app", so pushes are
  held back exactly as in V6). `show_channel: false` only stops the channel
  being shown to people.
- **Truthfully**: this is presence, live, nothing else. Nothing is stored (not
  in the database, not in a log), there is no history, no "last seen in", no
  read receipts — a person under a channel has it open now, which says nothing
  about what they have read. It does show everyone, live, which channel you
  have open; that is what the owner asked for, for a small group of people who
  know each other, and "Hangi kanalda olduğumu göster" (Ayarlar › Hesap ›
  Kanal görünürlüğü, `settings-show-channel`, per device:
  `localStorage["trio.v10.showChannel"] = "0"` while off, on by default) turns
  it off. Off, you are under no channel for anybody and still "çevrimiçi" in
  Üyeler.
- Online is not presence in a channel: somebody online with the app in the
  background is under no channel and still "çevrimiçi" in Üyeler.

**Client.** Under each text channel row (`channel-viewers-<id>`,
`data-count`): up to four people as a light list (an 18 px avatar and the
name, mine with "(sen)", `viewer-<channel>-<user>`); five or more fold into
one row of four stacked faces and "+n" (`channel-viewers-more-<id>`), the
names in its label and title. In the channel header (wider than a phone) "Burada: Sen, Ece +2"
with up to three faces (`here-line`; only the faces at ≤ 1100 px, the names in
its title). At ≤ 680 px the drawer shows the same rows. Drops to nobody while
the connection is down, until the next `ready`.

## 5. Server at this size

- One process, one worker, the hub in memory: unchanged and fine. The load
  test (`server/tests/test_v10_groups.py`: 15 members, 30 sockets, 60
  messages, everybody typing, presence churn, an 8-person room relaying 56
  signals) checks that a frame is serialised ONCE per broadcast however many
  sockets get it (plus one for the sender's own copy carrying its nonce), that
  every socket sees the messages in id order, and that it finishes in seconds.
  What breaks first at a larger size: the browsers (the mesh), long before the
  server; on the server, the per-socket send queue (512 frames) of a slow tab,
  which drops that tab, not the others.
- `typing`: at most 10 frames per user per 10 s; the rest are dropped silently
  (the client sends one per 3 s; one tab could otherwise make the hub fan out
  to every socket of every member as fast as it types).
- Join limit: a successful join or device link gives its per-address attempt
  back (`JoinGuard.succeeded`), so 15 people on one network (an office NAT)
  can all join; wrong codes are limited exactly as in CONTRACT-V3 §5.
- Web Push queue: 2000 jobs (was 500) and 8 workers (was 4): one message to 14
  others with up to 10 devices each is 140 deliveries.

## 6. "Three" assumptions found, and their fate

| where | assumption | fate |
|---|---|---|
| `TRIO_MAX_USERS` default 5 (server, compose `:-5`, `.env.example` 3, README) | a handful of friends | **15** |
| voice rooms | unbounded, sized for 3 | **cap 8**, `ROOM_FULL` (§2) |
| camera encoding | browser default ×2 viewers | **by room size** (§3) |
| stage grid | ≤ 4 tiles | **+N overflow** (§4) |
| call bar talking line | ≤ 3 names | **count first past 3** |
| avatar colours | 7 colours | **16** |
| `@` mentions | type the whole name | **suggestions** |
| Yönetim people list | 3 rows | **search, sort, removed folded, quota arithmetic** |
| join limit 10/address counting successes | 3 joins | **successes refunded** |
| typing | unlimited, 3 receivers | **10 per 10 s per user** |
| push queue 500 / 4 workers | 3 users' devices | **2000 / 8** |
| ring | everybody not in the room | kept (Discord's rule), refused into a full room |
| `typingLabel` "Birkaç kişi yazıyor…" past 2 | fine for any size | **kept** |
| presence pill: three faces + count | a count is the point | **kept** |
| sockets per user 10, link codes 5 live per user, ring 1/30 s per user, `channel.read` 120/min | per user, not per group | **kept** |
| per-person volume sheet and music menus | per person, one sheet at a time | **kept** (checked to scroll) |
| "X ses odasına girdi" (room empty → 1) | per room, not per member | **kept** |
| the brand: three dots, the name "Trio", design/palette.md "üç arkadaş" | identity, not a limit | **kept** (the site agent owns copy) |
| e2e `threePeople` | three browsers | **kept**, plus `lib/groups.ts` for N |
| CONTRACT.md's "~3 friends" | history | **kept**; this file wins |

## 7. Not verified

Real networks with 8 people (only loopback with host candidates here: no
TURN relay, no loss, no real upload limit), real cameras and their encoders,
phones in an 8-person room (only a 390 px viewport of desktop Chromium),
Safari and Firefox in a big mesh, the desktop app with 8 peers, CPU of eight
separate machines (here eight contexts share one browser and four cores).

## Test ids

`room-count-<id>`, `room-full-note-<id>`, `data-room-full`, `data-room-count`
(voice channel rows), `stage-more`, `stage-less`, `stage[data-shown]`,
`mention-list`, `mention-option-<id>`, `owner-people-search`,
`owner-people-sort`, `owner-removed`, `owner-quota-total`,
`owner-quota-shortfall`, `btn-members`, `members-panel`, `members-title`,
`members-close`, `members-backdrop`, `channel-viewers-<id>`,
`channel-viewers-more-<id>`, `viewer-<channel>-<user>`, `here-line`,
`settings-show-channel`. e2e 84 (who is in which channel: three pages, moving,
hidden, the setting, fifteen with "+n"), e2e 83 (channel rows and Üyeler at every
width and scale), e2e 78 (join storm), 79 (cap 3: count, full, stale
view), 80 (layouts with 15), 81 (measurements, camera encoding), 82 (defaults:
8 at once, the ninth refused, nine tabs of chat).
