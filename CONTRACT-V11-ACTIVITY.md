# Trio — contract V11: activity everywhere ("ne oynuyor, ne dinliyor")

Owner's request (20 Nov 2026): "Ne dinlediği / ne oynadığım sadece sesli
sohbette değil, kanallarda da görünsün." Like Discord: wherever a person is
listed, a quiet line says what they are playing and what they are listening
to, whether or not they are in a voice room and whether or not they share any
sound. Adds to V5 (game status) and V8 (music sharing); where they differ,
this wins. Additive on the wire.

## 1. Wire: `listening` is a second part of the V5 activity

    client → server   activity.set   {game?, since?, detail?, listening?}
    client → server   activity.clear {}
    server → everyone activity       {user_id, activity: Activity | null, updated_at}
    ready             gains  activity_parts: ["game", "listening"]

    Activity  = {game: string | null, since: int | null, detail: Detail | null,
                 listening?: Listening}      — `listening` absent when none, so a
                                               V5 entry is byte for byte as before
    Listening = {title, artist, app}            — artist/app "" when unknown

- A frame carries **at least one** part: a game (`game` + `since`, `detail`
  optional, V5's rules unchanged) and/or `listening`. With no game, `since` and
  `detail` must be absent or null. Neither part → `INVALID_ACTIVITY` (send
  `activity.clear` instead).
- `listening` is CLEANED, not refused (it comes from somebody's player, V8 §2):
  control, format (bidi, zero-width) and private-use characters removed,
  whitespace runs made one space; `title` cut to 120, `artist` to 120, `app`
  to 40 characters. Not an object, a non-string field, an unknown key, or a
  title empty after cleaning → `INVALID_ACTIVITY`.
- **Track changes are rate limited**: a frame whose `listening` differs from
  the stored one less than **4 s** after the stored one changed → `RATE_LIMITED`
  (nothing stored). A frame WITHOUT `listening` (stopping, or the setting
  turned off) is never held back: that is the private direction. The client waits 5 s between listening changes, so this
  never fires for it. V5's 30 frames per user per minute still covers all.
- Everything else is V5: one entry per user, replaced by every `activity.set`,
  in memory only (never in the database, no history, no "last listened"),
  gone after 10 min without a refresh, 30 s after the user's last socket
  closed, on `activity.clear` and on removal. `ready.activity` lists live
  entries.
- `activity_parts` in `ready` tells the client the server knows `listening`;
  without it (an older server after a rollback) the client sends the game
  part only.
- **An old client** (a tab left open across the release) reads `game` only:
  a listening-only entry has `game: null`, which it treats as "no activity";
  an entry with both shows the game as before.

## 2. Who sees it

**Everyone on the server**, live: the member list, the drawer, the rows
under channels, voice rows, tooltips. A small group's own server (CONTRACT-V10:
up to 15 people) and nobody else; it is not stored anywhere.

## 3. Privacy rules (the sender's device decides; nothing reaches the server otherwise)

- "Ne dinlediğimi göster" (Ayarlar › Hesap › Durum, `settings-listen-share`,
  per device `localStorage["trio.v11.listen"] = "0"` while off; **on by
  default**). Off: the shell's status watcher is off, nothing is read, the page
  sends `activity.set` without `listening` (or `activity.clear`).
- **Only known music apps by default.** The Windows media session also reports
  browser tabs (a YouTube video, anything with sound) and video players; their
  titles are NOT shown unless "Tarayıcılarda ve diğer uygulamalarda çalanları
  da göster" (`settings-listen-browsers`, `trio.v11.listenBrowsers` = "1"
  while on; **off by default**) is on. The filter runs in the desktop app's
  main process: with it off, a browser's title never even reaches the page.
- **First run**: the first time a listening status would be sent, it is NOT
  sent; a one-line band says "Ne dinlediğin sunucudaki herkese görünüyor"
  with "Tamam" (send from now on; remembered, `trio.v11.listenAck` = "1") and
  "Kapat" (turns the setting off). `listen-notice`, `listen-notice-ok`,
  `listen-notice-off`.
- Game status keeps V5's own switch, "Oyun durumumu paylaş" (`settings-game-share`,
  `trio.gameShare`, on by default). Both are under one "Durum" heading.
- Browsers without the app detect nothing (they still see others). No typed
  manual status line: it would need storing to survive a restart and is not
  what was asked.

## 4. The known music apps (matched on the session's AppUserModelId)

Matched case-insensitively by substring of `SourceAppUserModelId`, the id
Windows reports for a media session (a packaged app's
`<PackageFamilyName>!<App>`, an unpackaged one usually its executable name).
**None of these ids was read on a real Windows machine while building this**
(no Windows here, and no public page lists them): the column says where each
token comes from. Ayarlar shows the last app Windows reported and whether it is
shown (§6), so the owner's check (`docs/durum-kontrol.md`) settles each one.

| app | token(s) | basis |
|---|---|---|
| Spotify | `spotify` | desktop `Spotify.exe`, Store `SpotifyAB.SpotifyMusic_…` (the Store package name is public; the session id assumed to follow it) |
| Apple Music, iTunes | `applemusic`, `itunes` | Store packages `AppleInc.AppleMusicWin_…`, `AppleInc.iTunes_…` — assumed |
| TIDAL | `tidal` | assumed (Electron app) |
| Deezer | `deezer` | assumed |
| Amazon Music | `amazonmusic`, `amazon.music` | assumed |
| YouTube Music (desktop apps) | `youtube-music`, `youtubemusic` | th-ch/youtube-music `com.github.th-ch.youtube-music` — assumed; the official one is a browser web app and reports as its browser |
| SoundCloud | `soundcloud` | assumed |
| foobar2000 | `foobar2000` | assumed (v2 publishes to the media session itself) |
| AIMP | `aimp` | assumed |
| MusicBee | `musicbee` | assumed |
| Winamp | `winamp` | assumed |

Browsers (`chrome`, `msedge`, `firefox`/`308046b0af4a39cb`, `opera`, `brave`,
`vivaldi`, `yandex`) and **every app not in the table** — VLC, Windows Media
Player (`Microsoft.ZuneMusic`), Films & TV, players that also play videos —
count as "other": shown only with the browsers option on. The Spotify
window-title fallback (V8 §5) counts as Spotify.

## 5. Desktop: the status watcher (needs the new desktop app)

    window.trioDesktop.listeningStatus?: { supported: boolean }       // false on macOS/Linux
    window.trioDesktop.setListeningStatus?(opts: {on: boolean, browsers: boolean}): void
    window.trioDesktop.onListening?(cb: (state: ListeningState) => void): () => void

    ListeningState = { playing: NowPlaying | null,
                       health: "off" | "starting" | "ok" | "limited" | "failed" | "unsupported",
                       message?: string,                     // Turkish, shown as text
                       lastApp?: { name: string, shown: boolean } }

- One reader (V8's hidden PowerShell process) serves both the V8 share watch
  (`setNowPlayingWatch`) and this status: it runs while either wants it and
  stops when neither does (and on navigation/reload of the page). The
  reader now reports every session (app id, Playing/Paused, title, artist)
  every 3 s; the main process picks, for the status, the first **Playing**
  session (current one first) whose app is allowed; for the V8 share the first
  Playing session of any app, exactly as before. One reading, two answers: when
  the shared music is from an allowed app the two titles are the same string.
- **Pause and gone**: an allowed app's session still there but not Playing
  keeps the last value for **30 s**, then `playing: null`; a session that is
  gone (the app closed), or a reader that stopped, is `null` at once.
- Emitted only on change; the subscription gets the current state at once.
- `health`: `starting` until the first reading; `ok`; `limited` when the media
  session API was unavailable and only Spotify's window title is read;
  `failed` when PowerShell did not start or exited three times (with the
  reason in `message`); `unsupported` on macOS/Linux ("Bu sistemde otomatik
  algılanamıyor"). Ayarlar shows it (`settings-listen-health`).
- `lastApp`: the last app Windows reported (its cleaned short name) and
  whether the filter lets it through — local only, never sent.
- IPC from the main window's top frame on the configured server only, like
  every other channel.
- **An installed 0.9.x app** has none of this: the page shows "Bu masaüstü
  sürümü müzik durumunu göstermiyor; uygulamayı güncelle." and listening
  works exactly as V8 (a title only while sharing music in a room). Its
  `setNowPlayingWatch` is not used as a status source: it reads browsers too,
  and only the first playing session.

## 6. Web client

- `activityStore` keeps both parts; `ActivityForwarder` (was `GameForwarder`)
  sends one frame with both, at most one per 3 s, a listening change at most
  one per 5 s (latest wins; stopping goes at once), refreshed unchanged every 4 min and after every
  `ready`.
- **Shown wherever a person is listed**, text only, one line each, ellipsis
  when long, a small pad (game) or note (music) glyph:
  - member panel (`member-activity-<id>` game, `member-listening-<id>` music),
    the phone drawer (`drawer-activity-<id>`, `drawer-listening-<id>`; also
    for people in a voice room, under the room's name), voice rows
    (`voice-activity-<id>`, `voice-listening-<id>`): game on the first line,
    music on the second, "Spotify · Şarkı — Sanatçı";
  - the rows under a text channel (`viewer-activity-<channel>-<id>`): one
    short line after the name (the game's name, else the song); with stacked
    faces ("+n") it goes into the row's label and tooltip;
  - "Burada" in the channel header: the tooltip lists each person with their
    activity;
  - the people strip under a stage: a glyph and the tooltip.
- A V8 sharer's room row keeps its note mark and "Şu an çalıyor" line; the
  status line under it is not repeated when it says the same title.
- One person's change re-renders that person's lines only (a per-user
  selector on the store); the message list never.

## 7. Not verified

Everything Windows does: the session ids in §4, the PowerShell reader on a
real machine (it never has run on one), whether Spotify/Apple Music report
Paused vs. closing their session, the "no console window" promise. The owner's
3-minute check is `docs/durum-kontrol.md`. macOS/Linux: no source.

## Test ids and errors

`member-listening-<id>`, `drawer-listening-<id>`, `voice-listening-<id>`,
`viewer-activity-<channel>-<id>`, `settings-listen-share`,
`settings-listen-browsers`, `settings-listen-health`, `listen-notice`,
`listen-notice-ok`, `listen-notice-off`. Errors: `INVALID_ACTIVITY`,
`RATE_LIMITED` as V5. e2e 85 (listening everywhere, three people), 86 (setting,
notice, browser default, old shell), 87 (fifteen people, layouts).
