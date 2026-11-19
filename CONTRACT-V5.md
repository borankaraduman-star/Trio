# Trio — contract, fifth layer: game status ("oyun durumu")

Adds to v1–v4; where they differ, this wins. Everything is additive on the
wire: an old client ignores the new frames, a new client works against an old
server (it simply sees no `ready.activity`), and an old desktop app (no
`onGameStatus`) leaves the page as it was.

Goal: next to each friend's name, quietly, what they are playing —
"WoW Forever · 37 · Orgrimmar", or "Counter-Strike 2" — and nothing when they
are not playing. Two layers feed one status:

1. **Process detection** (desktop app, no addon): a running program from a
   table of known games → `game` and `since`. Works for every game in the table.
2. **The TrioDurum addon** (World of Warcraft only): level, zone and character
   through the game's chat log (live) or its SavedVariables (on logout/`/reload`)
   → `detail`.

---

## 1. Wire (server)

    client → server   activity.set    {game, since, detail?}
    client → server   activity.clear  {}
    server → everyone activity        {user_id, activity: Activity | null, updated_at}
    ready             gains  activity: {"<user id>": {activity: Activity, updated_at}}

    Activity = {game, since, detail: Detail | null}
    Detail   = {character, realm, level, class, zone, subzone, source}

| field | rule |
|---|---|
| `game` | string, 1–64 characters after trim (NFC), one line of visible text (no control/format characters). A display name: "World of Warcraft", "WoW Forever", "Counter-Strike 2". |
| `since` | integer unix seconds, when the game was first seen running; ≥ 946684800 and at most 300 s ahead of the server clock. |
| `detail` | absent or null = no addon data; else an object with exactly these keys (missing optional ones are `""`): |
| `detail.character` | required, 1–48 characters after trim, one line; **may contain spaces and non-ASCII** ("Kahve Kokusu", "Işıl"). |
| `detail.realm` | 0–64; **optional, empty allowed** (the Forever character screen shows none). Never part of any key. |
| `detail.level` | integer 1–999 (no beta cap assumed). |
| `detail.class` | `""` or a class token `[A-Z_]{1,24}` (`ROGUE`, `DEATHKNIGHT`). |
| `detail.zone`, `detail.subzone` | 0–96 characters, one line; localized names, UTF-8 kept. |
| `detail.source` | `"log"` (chat log, live) or `"saved"` (SavedVariables). |

- Any other top-level or detail key, or any rule broken → `error INVALID_ACTIVITY`
  (the message names the field; nothing is stored or broadcast).
- Rate: `activity.set` and `activity.clear` together, **30 per user per sliding
  60 s**, counted before validation; over it → `error RATE_LIMITED`.
- `activity.set` replaces the user's entry and always broadcasts (also when
  unchanged: `updated_at` moves; the page refreshes every 4 min).
- `activity.clear` broadcasts `activity {activity: null}` only when there was an
  entry.
- Stored **in memory only** (it is presence; nothing in the database). A
  restart forgets everything; the page sends it again on `ready`.
- An entry goes away (`activity {activity: null}` to everyone) when it is not
  refreshed for **10 minutes**, when the user's **last** socket has been closed
  for **30 s** (a reconnect within that keeps it), on `activity.clear`, or when
  the user is removed (before `user.removed`).
- `ready.activity` lists only live entries.
- `updated_at`: ISO-8601 UTC with milliseconds and `Z`, server time of the change.
- Delivery: to every socket including the actor's own.

## 2. Desktop: process detection (`desktop/src/shared/gameCatalog.ts`)

- The main process lists running programs every **15 s** with the OS's own tool
  and a fixed argument list (`tasklist /FO CSV /NH` on Windows, `ps -A -o comm=`
  elsewhere); no shell, no native module, nothing that reads another process.
- A name is normalised: the bundle name for a macOS `.app` path, else the file
  name; lower case; without `.exe`/`.app`. It is matched exactly against a
  table: built-ins (World of Warcraft: `Wow`, `Wow-64`, `WowB`, `WowT`,
  `WowClassic`, `WowClassicB`, `WowClassicT`, `World of Warcraft[.app]`,
  `World of Warcraft Classic[.app]`, …; Counter-Strike 2 `cs2`; VALORANT
  `VALORANT-Win64-Shipping`; League of Legends `League of Legends` (the game,
  not the `LeagueClient` launcher); Rocket League; Dota 2; GTA V
  (`GTA5`, `GTA5_Enhanced`); Fortnite; Overwatch 2; Diablo IV; Hearthstone;
  ELDEN RING) plus the user's own entries, which win on a clash.
- **WoW Forever's executable name is not known.** The "Oyun durumu" window lets
  the user add a game from the currently running programs (names only, no
  paths) with a display name (1–64 characters). A user entry counts as WoW
  (may carry addon detail) when its name or executable mentions wow/warcraft.
- Stored in `<userData>/trio-game.json`: `{wowFolder, customGames: [{executable, name}]}`.
- **Privacy:** the process list never leaves the main process except as the
  names shown in the local "Oyun durumu" window for "add"; only a match
  against the table becomes a status.

## 3. The addon line (TrioDurum) and SavedVariables

One chat message, at most 255 bytes, sent by the addon as a whisper to the
player themselves (default; `/trio mod kanal` uses a private channel):

    TRIO1;<seq>;<unix time>;<name>;<realm>;<level>;<classToken>;<zone>;<subzone>;<kind>

- Ten `;`-separated fields. `seq` increases per account (kept in
  SavedVariables). `unix time` is the game client's `time()`, the same machine
  as the desktop app. `kind` ∈ `login | zone | level | beat | logout | test`.
- Fields `name`, `realm`, `classToken`, `zone`, `subzone` are percent-encoded:
  `%`, `;`, `|` (WoW's escape character), `\` and control bytes become `%XX`;
  every other byte is UTF-8 as is (spaces, apostrophes, `ş`, `ö`). Long zone
  names are cut at a character boundary to keep the 255 bytes.
- In the chat log the frame follows the game's own prefix
  (`11/19 21:03:04.123  To Kahve Kokusu: TRIO1;…`); the reader finds it by
  the `TRIO1;` marker. A self-whisper appears twice (sent and received); the
  reader de-duplicates by (time, seq).
- When: on entering the world, a zone change (debounced 2–4 s), a level-up, a
  heartbeat every 4 min, logout, and `/trio test`. At most one automatic line
  per 10 s and 12 per 10 min; never while
  `C_ChatInfo.InChatMessagingLockdown()` is true (instances, encounters,
  M+, PvP matches): the line waits.
- SavedVariables, account-wide, `WTF/Account/<account>/SavedVariables/TrioDurum.lua`:

      TrioDurumDB = {
          ["mode"] = "whisper",          -- whisper | channel | off
          ["hide"] = true,               -- hide own lines in the chat window
          ["autolog"] = true,            -- turn /chatlog on at login
          ["channel"] = "TrioDurum",
          ["seq"] = 12,
          ["last"] = {                   -- written on EVERY emit, sent or not
              ["seq"] = 12, ["time"] = 1795072075,
              ["name"] = "Kahve Kokusu", ["realm"] = "", ["level"] = 37,
              ["class"] = "ROGUE", ["zone"] = "Orgrimmar", ["subzone"] = "",
              ["kind"] = "logout", ["line"] = "TRIO1;12;…;logout", ["sent"] = false,
          },
      }

  The game writes this file only at logout and `/reload`. The desktop reads
  `last.line` (decoded like a log line, with `last.kind` taking precedence),
  else the separate fields, with a purpose-built parser of exactly this data
  format (tables, strings with Lua escapes, numbers, booleans, nil; nothing is
  evaluated).

## 4. Desktop: reading the log (`desktop/src/main/chatLogTailer.ts`)

- The user picks the WoW folder in the "Oyun durumu" window (or "Otomatik bul"
  lists flavour folders `_forever_`, `_retail_`, `_classic_`… that contain
  `Logs`, `WTF` or `Interface/AddOns`). Stored as the flavour folder.
- `Logs/WoWChatLog.txt` is polled every 2 s (`fs.watch` on `Logs/` only
  hints). First look: only the last 64 KiB. Truncation or replacement (size
  smaller, or another inode/birth time) restarts at the top; a partial line
  waits for its newline; a BOM is skipped; at most 4 MiB per poll.
- **Privacy:** a line without `TRIO1;` is dropped as raw bytes, never decoded,
  logged, stored or sent; only the frame from the marker on is kept. Nothing
  but the merged status reaches the page.
- SavedVariables are checked every 5 s and read when their mtime changes.
- Merge (`desktop/src/shared/gameStatus.ts`): a record older than 10 min is
  ignored; only newer (time, seq) wins; the addon layer ends after 12 min
  without a line, on a `logout` line, or when a matched WoW process stops
  (records from before that moment). WoW in the process list → that entry's
  name; addon data without a matched process → `"World of Warcraft"`. With
  several games running, a WoW one is reported first, else the earliest.

## 5. Desktop bridge (extends CONTRACT-V2 §5)

    window.trioDesktop = {
      …,                                      // isDesktop, setPttKey, onPtt as before
      gameStatus: { supported: true },
      onGameStatus(cb: (status: GameStatus | null) => void): () => void,
    }
    GameStatus = {game: string, since: number, detail?: Detail}   // Detail as in §1

- The first subscriber starts detection in the main process (and gets the
  current status at once); the last unsubscribe stops it unless the "Oyun
  durumu" window is open. A navigation of the main window unsubscribes.
- The main process sends only to the main window, only while it is on the
  configured server's origin. It holds no Trio token: **the page** forwards.

## 6. Web client

- `activityStore` (outside `store.ts`) follows `ready.activity`, `activity`
  and `user.removed`.
- `GameForwarder`: when `window.trioDesktop.onGameStatus` exists and sharing is
  on, each status becomes `activity.set` (null → `activity.clear`), at most one
  frame per 3 s (latest wins), re-sent unchanged every 4 min, and again after
  every `ready` (a server restart forgets it). A browser without the bridge
  never sends anything.
- "Oyun durumumu paylaş" (Ayarlar, `settings-game-share`, per device in
  `localStorage` `trio.gameShare`, default on). Turning it off unsubscribes
  from the bridge and sends one `activity.clear`; while off, a `ready` that
  still lists the user's activity gets an `activity.clear` too.
- Display: one quiet line under the name in the member list
  (`member-activity-<id>`) and on voice participant rows
  (`voice-activity-<id>`): `game · level · zone` (zone, else subzone), a class
  coloured dot; the tooltip has character (realm), level, class, zone ›
  subzone, "x oynuyor", "Güncellendi: x dk önce", and says when the data came
  from SavedVariables. Not in a game: nothing.

## 7. What is NOT verified (nobody could run the game while building this)

- Whether the WoW Forever client loads addons at all; its `## Interface:`
  number (16001 is a fan-site figure; the `.toc` lists several).
- Whether a whisper to oneself is allowed and is written to `WoWChatLog.txt`;
  whether a character name with a space can be a whisper target.
- **How promptly the client writes `WoWChatLog.txt`**: some reports say only
  at logout or `/reload`; then only the SavedVariables layer is useful.
- Whether chat filters (used to hide the lines) also keep them out of the log.
- WoW Forever's executable name (add it in the "Oyun durumu" window).

## New error codes and limits

| where | code |
|---|---|
| ws `activity.set` | `INVALID_ACTIVITY`, `RATE_LIMITED` |
| ws `activity.clear` | `RATE_LIMITED` |

| limit | value |
|---|---|
| activity changes | 30 per user per minute |
| activity TTL without refresh | 10 min |
| after the last socket closes | 30 s |
| page refresh of an unchanged status | 4 min |
| page minimum gap between frames | 3 s |
| addon heartbeat | 4 min; ≥ 10 s between lines, ≤ 12 per 10 min |
| addon layer offline after | 12 min without a line |
| process poll / log poll / SavedVariables poll | 15 s / 2 s / 5 s |
