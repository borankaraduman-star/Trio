# Trio — contract, the desktop app updates itself (adds to v1–v8; where they differ, this wins)

Owner's request: "We must not have to download the desktop app again and again
for every update; an update button should appear in the app, or it should
update itself." This replaces the update notice of CONTRACT-V6-VOICE §7.

## 1. Who updates itself, and why not everybody

| system | how it updates | why |
|---|---|---|
| Windows (the NSIS installer, per-user) | **itself**: downloads in the background, installs silently on "Yeniden başlat ve güncelle" or when the app quits | electron-updater's `NsisUpdater` checks an installer's Authenticode signature only when the running app's `app-update.yml` carries a `publisherName`; an unsigned build writes none, so an unsigned update is accepted (read in electron-updater 6.8.11's `NsisUpdater.verifySignature`) |
| Linux, run as the `.AppImage` | **itself**: the AppImage file is replaced and started again | `AppImageUpdater` works only when `APPIMAGE` is set, i.e. the app runs as an AppImage (6.8.11 `AppImageUpdater.isUpdaterActive`) |
| macOS (today: ad-hoc signed `.dmg`) | **by hand**: the notice with a direct download for this Mac's processor | Squirrel.Mac, which electron-updater's `MacUpdater` uses, refuses an app without a real signature (Electron's code-signing docs; electron-builder's mac docs). Automatic as soon as the build is Developer ID signed: §6 |
| Linux not as an AppImage (extracted, a distro package), the Windows portable exe, `npm start` / `npm run dev`, a build without `app-update.yml` | by hand | nothing to install over, or nothing that says where updates come from |

`desktop/src/shared/update.ts` `updateCapability()` is this table in code
(tested: `desktop/src/test/update.test.ts`, "capability matrix").

## 2. Where updates come from, and what is checked

- **One source, pinned in code**: `autoUpdater.setFeedURL({provider: "github",
  owner: "borankaraduman-star", repo: "Trio", private: false})`. Whatever the
  packaged `app-update.yml` says, the app asks only this public repository's
  GitHub releases, over https, with no token. No server setting, no page and
  no IPC message can change it.
- **Which release**: `https://github.com/<repo>/releases/latest` (GitHub's
  newest non-draft, non-prerelease release), then its `latest.yml` /
  `latest-mac.yml` / `latest-linux.yml`. A pre-release reaches only an app that
  itself runs a pre-release version (electron-updater sets `allowPrerelease`
  from the running version).
- **Never a downgrade, never the same build again**: `allowDowngrade = false`
  in electron-updater, and the controller accepts a version only when it is
  strictly newer (semver) than the running one; anything else is "Güncel".
- **The metadata must name plain files of that release**: every `files[].url`
  in `latest*.yml` must be a name like `Trio-<v>-win-x64.exe` (no scheme, no
  path, no `..`) with a sha512; otherwise nothing is downloaded and the state is
  "Güncelleme denetlenemedi (sürüm bilgisi kabul edilmedi)".
- **Never run a file whose hash does not match**: electron-updater computes the
  sha512 of the downloaded (or differentially rebuilt) file and compares it
  with `latest*.yml`; a mismatch throws and the update never becomes "ready".
  electron-updater's own `autoDownload` is always off: the controller downloads
  only after its checks.
- The release workflow refuses to publish a `latest*.yml` that names a file not
  in the release or whose sha512 does not match the file (`Check update
  metadata` in `release.yml`).

### What this protects against, and what it does not (plain words)

The sha512 and the files come from the **same GitHub release**. So the check
protects against a download that was cut off or corrupted on the way, a mirror
or proxy handing back something else, and a release whose metadata does not fit
its files. It does **not** protect against somebody who controls the GitHub
account or the repository's release workflow: they can publish a new release
with a matching `latest.yml`, and every installed Windows and Linux app would
download it within about a quarter of an hour (§4a) and run it at the next
restart, quit or start, without anybody clicking a download link.
That is the same trust root as today's manual flow (people download the
installer from the same releases page and run it, and the `/indir` page's
SHA-256 also comes from that release), only faster and with no human in the
loop. What would add a second, independent check is code signing (Windows
Authenticode with `publisherName`, macOS Developer ID): electron-updater then
also requires the new installer to be signed by the same publisher
(`docs/imzalama.md`). Protect the GitHub account accordingly (2FA, no
long-lived tokens with `contents: write`).

## 3. The bridge (all members optional; an older app has none)

On `window.trioDesktop`, from the main window's preload, only on the
configured server's origin; every message is origin-checked in the main
process like the existing channels (`fromServerPage`):

    getUpdateState(): Promise<UpdateState | null>              invoke trio:update-state
    onUpdateState(cb: (state: UpdateState) => void): () => void on     trio:update-changed
    checkForUpdates(): Promise<UpdateState | null>             invoke trio:update-check
    downloadUpdate(): Promise<UpdateState | null>              invoke trio:update-download
    installUpdate(): Promise<{ok, reason?}>                    invoke trio:update-install
    setAutoUpdate(on: boolean): void                           send   trio:update-auto

    UpdateState = {
      capability: "auto" | "manual",
      reason: null | "dev" | "portable" | "not-appimage" | "unsigned-mac" | "no-config" | "unsupported",
      platform: "windows" | "mac-arm64" | "mac-x64" | "linux" | null,   // /api/downloads' word
      currentVersion, autoDownload: boolean,
      status: "idle" | "checking" | "up-to-date" | "available" | "downloading"
            | "ready" | "installing" | "error" | "manual",
      version: string | null, percent: 0–100 | null,
      error: Turkish reason | null,     // never the raw message (it may hold paths)
      checkedAt: ms | null, inVoice: boolean
    }

`installUpdate` answers `{ok: false, reason: "in-voice" | "not-ready" |
"manual"}` instead of restarting. Nothing here gives the page a new
privilege: it cannot choose what is downloaded, from where, or run anything.
The voice state comes from the existing `setVoiceState({inVoice})` (V6 §5); a
new document counts as not in voice until it says so again.

## 4. When (the shell's schedule)

- First check **30 s** after start, then every **45–60 min** (`CHECK_INTERVAL_MS`
  45 min + up to `CHECK_JITTER_MS` 15 min at random, so a group's apps do not
  ask in step). A check is three requests to github.com's web front
  (`releases.atom`, `releases/latest` as JSON, `latest*.yml`; electron-updater
  6.8.11 `GitHubProvider` deliberately avoids the REST API for github.com), from
  the user's own address; hourly is far below any limit (GitHub documents none
  for these pages; the REST API's unauthenticated 60/h per IP does not apply).
  Do not go below ~15 min: the page's "look now" (§4a) is the fast path.
- **Waking up**: `powerMonitor` `resume` and the window shown again from the
  tray (or a minimised window restored) check when the last check is older than
  **15 min** (`WAKE_MIN_GAP_MS`).
- **Whenever the page asks** (`checkForUpdates()`, §4a, and "Güncellemeleri
  denetle").
- **In a voice room the check and the download run like anywhere else.** Only
  the restart waits. Until 20 Nov 2026 nothing automatic ran during a call;
  people sit in a voice room for hours with the app open for days, so the
  shell never looked. A download is ~100 MB (Windows fetches only the changed
  blocks when the installed version's blockmap is in its release): it competes
  with the call's incoming media only on a line it saturates; nothing is
  throttled (electron-updater has no throttle, and a slower download only
  delays "ready").
- A found update downloads in the background when "Güncellemeleri kendiliğinden
  indir" is on (default; `<userData>/trio-update.json`), else it waits as
  "available" for "İndir".
- **Never restarts by itself while the user is in a voice room**, and never
  restarts by itself in the middle of a session at all: the restart happens on
  "Yeniden başlat ve güncelle" (band, Ayarlar, tray menu), which is not offered
  (band) / disabled (Ayarlar, tray) during a call and refused by the main
  process then. No idle-time restart either.
- **Quitting** (tray "Çıkış", app menu) with a ready update installs it
  silently (`autoInstallOnAppQuit`, electron-updater runs the installer from its
  `quit` handler when the exit code is 0) and does **not** start the app again;
  the next start is the new version.
- **The next start**: an update downloaded in an earlier run that was never
  quit (Windows shut down or restarted, the process was killed: electron-updater's
  `quit` handler does not run then, and the downloaded file stays in its cache,
  `%LOCALAPPDATA%\trio-desktop-updater\pending`) is remembered
  (`readyVersion` in `trio-update.json`). The next start checks after **5 s**
  (`START_INSTALL_CHECK_DELAY_MS`); electron-updater finds the cached file valid
  and is "ready" at once; if that happens within **2 min** of start
  (`START_INSTALL_WINDOW_MS`) and the page does not say the user is in a voice
  room (a call that survives a restart, V4, may rejoin by itself), it installs
  silently and starts the new version. The user sees the window close a few
  seconds after start and Trio open again as the new version. **Once per
  version** (`startInstallTried`): an installer that fails cannot loop the app.

### 4a. The page says "look now", and the latency that follows

The web client keeps the newest desktop release (`GET /api/downloads`) fresh
while it is open: on load, every **5 min** (`RELEASE_POLL_MS`), when it becomes
visible again (respecting the 5 min) and on every socket `ready` (every
reconnect, at most once per 30 s). The server answers from its 10-minute cache
of GitHub's latest release (CONTRACT-V6-DOWNLOAD), so these are in-memory
answers; no frame was added to the protocol. When that release is newer than
`appVersion`, the shell's state is `auto` and not already busy with or done
with an update (`checking`, `downloading`, `ready`, `installing`), and the
shell has not already found this version and waits for "İndir", the page calls
`checkForUpdates()`, **at most once per version per 10 min**
(`HINT_RETRY_MS`, kept in `localStorage` `trio.desktopUpdateHint` so a reload
does not ask again). A failed **download** (status `error` with a version) is
not retried from the page: a file that keeps failing its hash would be fetched
every ten minutes. The shell stays the authority: it reads its own pinned feed
and applies every check of §2; the page only chooses the moment.

This works with the shells already installed: `checkForUpdates()` exists since
0.8.0 and runs a "manual" check there, which in 0.8.0/0.9.0 is honoured during
a call and, with automatic download on, downloads right away.

**Timeline rule — a release is noticed by every open app within ≈ 15 min**
(server cache ≤ 10 min, then the page's poll ≤ 5 min), typically ~8 min, then
downloaded (a minute or several, by line). An app that was asleep or closed
notices it at most 15 min after waking / within 30 s of starting. Without the
page (connect page, server down) the shell's own hourly check is the bound.

Why 0.9.0 was not noticed by an open 0.8.0 app (20 Nov 2026): the app had been
running since before the release, so its 45 s start check had found nothing;
the next one was up to 4 h away, and every one that came due while the user
was in a voice room was deferred to 60 s after leaving, which with hours-long
calls meant never; the page had read `/api/downloads` once at load and never
again. "Güncellemeleri denetle" bypassed all of it and worked at once.

## 5. What the page shows (`web/src/components/voice/DesktopVersion.tsx`)

The notice now follows the newest **desktop release**, `GET /api/downloads`
(CONTRACT-V6-DOWNLOAD; GitHub's latest release, cached 10 minutes by the server
and by the page), never the server's version. A web-only release (no new
desktop release) shows nothing.

- **App with the updater, capability auto** — band, one line, without opening
  Ayarlar: "Güncelleme indiriliyor: X (%40)" + **Sonra**; then
  "Güncelleme hazır: X" + **Yeniden başlat ve güncelle** + **Sonra**. In a
  voice room both say "… — sesli odadan çıkınca kurulabilir" and there is no
  restart button. With automatic download off: "Masaüstü uygulamasının yeni
  sürümü var (X)." + **İndir** + **Sonra**. **Sonra** on available/downloading
  hides that version until it is ready (`localStorage`
  `trio.desktopUpdateLater`); on ready it hides it until the page loads again.
  Nothing while checking. A coral dot on the settings button (and on the
  drawer button) while the shell has an available, downloading or ready
  version (`desktop-update-dot`, `data-status`).
- **Outside the page** (the shell): the tray menu's second line
  ("Güncelleme indiriliyor: X (%40)" in tens, "Yeni sürüm var: X",
  "Yeniden başlat ve güncelle (X)" outside a call, "Güncelleme hazır: X
  (sesli odadan çıkınca)" greyed in one), the tray tooltip "Trio — Güncelleme
  hazır: X", and when it becomes ready while the window is hidden (in the tray
  or minimised) one silent native notification "Trio güncellemesi hazır" /
  "X indirildi. Tepsideki menüden yeniden başlatabilirsin; uygulamadan çıkınca
  da kurulur." (in a call: "Sesli odadan çıkınca yeniden başlatabilirsin; …"),
  once per version per run, only where `Notification.isSupported()` (the
  system's own notification settings decide whether it shows); clicking it
  shows the window. Ayarlar › Hakkında: the version,
  the state line (Güncel · Güncellemeler denetleniyor… · Yeni sürüm var: X ·
  İndiriliyor %40 · Hazır: X — yeniden başlatınca kurulur · Yeniden
  başlatılıyor… · Güncelleme denetlenemedi (neden)), **Güncellemeleri denetle**,
  the restart button when ready, and the switch "Güncellemeleri kendiliğinden
  indir". If self-update fails (status error) and a newer release exists, the
  manual notice below is shown as well.
- **Manual** (an app without the update members, or capability manual):
  when `/api/downloads`' version is newer than `appVersion` (a missing
  `appVersion` counts as older), the band "Masaüstü uygulamasının yeni sürümü
  var (X)." with a direct download button for this machine's file
  (`/indir/dosya/<platform>`, opened in the system browser; the platform comes
  from the shell's state, else the user agent; an old Mac app cannot tell its
  processor, so it gets both "İndir (Apple Silicon)" and "İndir (Intel)"; no
  file for the platform → a link to `/indir`), dismissable per version as
  before; the same line in Hakkında, with the reason when the shell says why
  (e.g. unsigned macOS).
- Nothing when `/api/downloads` gives no version, and never in a plain browser.

## 6. The one last manual install, and macOS later

Apps 0.4.0–0.7.1 have no updater. They see the manual notice (the web client
is the server's, so they get the new text). When the newer release is at least
`FIRST_SELF_UPDATING_VERSION` (`web/src/lib/desktopVersion.ts`, `0.8.0`: set it
to the first release that carries this contract) and the machine is Windows or
Linux, the band adds **"Bu son elle kurulum: bundan sonra uygulama kendini
güncelleyecek."** Running the new installer over the old app keeps the server
address and settings (same `appId`, same per-user folder).

macOS becomes automatic without a code change once the build is really signed:
`release.yml` writes `trioBuild: {macSigned: true}` into the built app's
`package.json` (electron-builder `extraMetadata`) only on the Developer ID path,
whose signature check fails the job when the app is not notarized. The mac
build already publishes the `.zip` files and `latest-mac.yml` Squirrel.Mac
needs. The first signed release is still one manual install for Mac users (the
unsigned app before it cannot update itself).

## 7. Release workflow

Besides the installers, `SHA256SUMS.txt` (now with the `.zip` files) and
`signing.json`, every release carries `latest.yml` + `Trio-<v>-win-x64.exe.blockmap`,
`latest-linux.yml` (the AppImage embeds its block map), `latest-mac.yml` +
`Trio-<v>-mac-{x64,arm64}.zip` (+ `.zip.blockmap`, `.dmg.blockmap`). The build
still runs `electron-builder --publish never` (the publish config only makes it
write `app-update.yml` and `latest*.yml`); the release job uploads them with
the other files. Blockmaps let Windows download only the changed blocks when
the installed version's blockmap is in its release (from the first updating
release on); otherwise it falls back to a full download.

**One version number, but dispatch the release only when the desktop app
changed.** Server and desktop keep one version number. Every desktop release
makes every installed Windows/Linux app download ~100 MB and every Mac show
the notice, so `release.yml` should be dispatched only when `desktop/` changed
since the last release (`git diff --quiet v<last>..HEAD -- desktop/`). A
web-only release then has no GitHub release at all: `/api/downloads` keeps the
last desktop version, installed apps stay "Güncel", and the `/indir` page shows
the newest installer (whose number may be lower than the server's).

## 8. Electron-builder 27

electron-builder 27 makes an unsigned Windows build that writes
`app-update.yml` fail unless `win.verifyUpdateCodeSignature: false` is set
explicitly (its v27 migration notes). This repository is on 26.18 /
electron-updater 6.8.11, where unsigned simply means "not verified". When
upgrading, set that option for unsigned builds only.

## 9. Signed Windows builds and the publisher

The Windows signature is checked by the INSTALLED app against ITS OWN
`app-update.yml` (6.8.11 `NsisUpdater.verifySignature`): no `publisherName`
there means no check; with one, the new installer must carry a `Valid`
Authenticode signature whose certificate subject matches it (a plain name is
compared with the certificate's CN, `windowsExecutableCodeSignatureVerifier`).
A build writes `publisherName` only when it is signed
(`win.signtoolOptions.publisherName`, or the CN of a configured certificate).
Hence:

- **unsigned 0.8.x → the first signed release**: no `publisherName` installed,
  so the signed installer is accepted like an unsigned one; it installs the
  new `app-update.yml` with `publisherName`.
- **signed → signed**: verified against that name. The SignPath path writes
  `SIGNPATH_PUBLISHER_NAME` (default `SignPath Foundation`) and the workflow
  fails unless the CN of every signed file equals it
  (`.github/actions/signpath-sign`, "Check signature (Windows)").
- **signed → unsigned, or signed by another publisher**: refused by every
  installed app, which then stays on its version with the update error. The
  workflow therefore refuses an unsigned Windows build once the latest
  release's `signing.json` says `windows: true` (override: repository variable
  `TRIO_ALLOW_UNSIGNED_WINDOWS=true`). Changing publisher (SignPath to an own
  certificate, say) needs one manual install from `/indir` for every Windows
  user; building the new release with both names in `publisherName` does not
  help apps that are already installed, only the ones it installs.

SignPath signing happens inside electron-builder (`desktop/scripts/signpath-bridge.cjs`
as the sign hook, the build in the background while the workflow submits each
file), so `latest.yml`'s sha512 and the blockmap are computed from the signed
installer. `docs/signpath-basvuru.md` is the owner's side.

## Test ids

`desktop-update` (`data-kind` manual | available | downloading | ready,
`data-version`, `data-in-voice`), `desktop-update-dot` (`data-status`), `desktop-update-download` (`data-platform`),
`desktop-update-last`, `desktop-update-dismiss`, `desktop-update-install`,
`desktop-update-fetch`, `desktop-update-later`, `desktop-update-settings`,
`desktop-version`, `desktop-update-status` (`data-status`),
`desktop-update-reason` (`data-reason`), `desktop-update-check`,
`desktop-update-install-settings`, `desktop-update-fetch-settings`,
`desktop-update-in-voice`, `desktop-update-auto`, `desktop-update-line`,
`desktop-update-line-download`.

## Verified on a real machine

- **20 Nov 2026, Windows, unsigned 0.8.0 → 0.9.0** (the owner): check →
  download → install worked through "Güncellemeleri denetle" in Ayarlar ›
  Hakkında. The unsigned NSIS path (no `publisherName`, §1) is accepted, and
  the app came back as 0.9.0. What did not happen is discovery: left open, the
  app never noticed the release by itself (§4a, "why").

## Not verified

The automatic discovery of §4/§4a on a real machine (the page's "look now" and
the hourly / resume / show checks; only the fake updater and a stubbed bridge
in the suites); the install at the next start after a Windows shutdown with a
ready update; the tray line and the native notification on Windows/macOS/Linux
desktops; SmartScreen during a silent update; whether the download was
differential; the AppImage replacement; a signed macOS update. The manual
check is `docs/guncelleme-kontrol.md`.
