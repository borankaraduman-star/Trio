# Trio — contract, the download page (adds to v1–v5; where they differ, this wins)

A public page anybody can open on the Trio server to get the desktop app,
`/indir`, with its data from the newest GitHub release. Nothing here needs a
token; nothing here writes.

## Configuration (server environment)

| variable | default | meaning |
|---|---|---|
| `TRIO_RELEASES_REPO` | `borankaraduman-star/Trio` | `owner/name` whose releases hold the installers; anything else refuses to start |
| `TRIO_GITHUB_TOKEN` | unset | for a PRIVATE repository: a fine-grained token with read-only **Contents** on that one repository. Never logged, never in a response |
| `TRIO_GITHUB_API_URL` | `https://api.github.com` | tests only (a fake GitHub) |
| `TRIO_GITHUB_DOWNLOAD_URL` | `https://github.com` | tests only: where an asset's `browser_download_url` must point |

## Routes

    GET /api/downloads         → 200 {version, published_at, signed: {windows, mac}, files: [File...]}
    GET /indir/dosya/<platform> → 302 Location: the installer
         404 NOT_FOUND (platform not one of the four, or not in the release)
         429 RATE_LIMITED + Retry-After (20 per 10 min per client address)
         502 DOWNLOAD_UNAVAILABLE (private repo: GitHub refused the asset)
    GET  /indir                → the page (web/indir.html), with the app shell's headers (CSP, frame-ancestors none)
    GET  /download, /download/, /indir/, /indir.html → 302 /indir

`File` = `{platform: "windows" | "mac-arm64" | "mac-x64" | "linux", name, size, sha256: <64 hex> | null, url: "/indir/dosya/<platform>"}`,
in that platform order, each platform at most once. `version` is the tag
without its `v`; `published_at` ISO-8601 UTC. All four are optional: a release
without a file for a platform simply leaves it out.

### Which release, which files

- The release is `GET /repos/<repo>/releases/latest`: the newest release that
  is neither a draft nor a prerelease. Its tag must be `v<semver>`.
- A file is an asset whose name matches electron-builder's
  `Trio-${version}-${os}-${arch}.${ext}` (desktop/package.json) for exactly
  that version: `Trio-<v>-win-x64.exe`, `Trio-<v>-mac-arm64.dmg`,
  `Trio-<v>-mac-x64.dmg`, `Trio-<v>-linux-x86_64.AppImage` (or `-x64`). Its
  `browser_download_url` must lie under `<download url>/<repo>/releases/download/`
  and its `state` must be `uploaded`. Anything else in the release is ignored.
- The visitor chooses only the platform word; the redirect target is the
  cached asset's own address (public repo) or GitHub's answer for that asset's
  id (private repo). Nothing from the request becomes part of a URL.

### Caching

The catalog is kept in memory 10 minutes. When GitHub fails, the last good
catalog keeps being served and GitHub is asked again a minute later. With no
good catalog yet, the answer is `{version: null, published_at: null, signed:
{windows: false, mac: false}, files: []}` and GitHub is asked at most once a
minute.

### Private repository (`TRIO_GITHUB_TOKEN`)

Every API call carries `Authorization: Bearer <token>`. A download asks
`GET /repos/<repo>/releases/assets/<id>` with `Accept: application/octet-stream`
and does NOT follow its redirect: the visitor gets `302` to GitHub's
short-lived signed `Location`. If GitHub answers `200` with the bytes instead
(its docs allow both), the server relays them. Small assets the server reads
itself (below) are fetched the same way, the signed location without the token.

### SHA-256

From the asset's `digest` (`"sha256:<hex>"`, GitHub sets it on uploads since
June 2025) or from the release asset `SHA256SUMS.txt` (`sha256sum` output),
which the release workflow attaches. Either one suffices; when both are present
and differ, `sha256` is `null`.

### Signing

The release asset `signing.json` = `{"windows": bool, "mac": bool}`, written by
the workflow after checking the built files (Authenticode `Valid`; macOS
`spctl` "Notarized Developer ID"). Absent or unreadable: both `false`.

## The page (`web/indir.html`, `web/src/indir/`)

A second Vite entry; no inline script (the shell CSP applies). Turkish.

- Detects the visitor: phone (Android, iPhone, iPad incl. desktop-mode iPad),
  Windows, Linux, Mac. A Mac's processor comes from
  `userAgentData.getHighEntropyValues(['architecture'])` or the WebGL renderer;
  without either, Apple Silicon. Chromebooks and unknown systems get no
  primary button, only the list.
- Primary button "<sistem> için indir" with version · date · size; every file
  listed with its name, size and SHA-256 (copy button).
- "Kurmadan kullan: tarayıcıda aç" → `/` on every desktop.
- Phone: "Trio telefonda tarayıcıdan çalışır." + "Trio'yu aç" → `/`, and a
  generic "Ana ekrana ekle" hint (true with or without a web manifest).
- "Kurulumda uyarı çıkarsa": why (unsigned, private app), the exact clicks, a
  drawn SmartScreen / macOS Privacy & Security illustration, a copyable hash
  check (PowerShell `Get-FileHash … -eq`, `shasum -a 256`, `sha256sum`), Linux
  `chmod +x`. For a platform with `signed` true the unsigned help is replaced
  by one line (Windows still mentions SmartScreen reputation, which signing
  alone does not grant).
- Unavailable: "İndirmeler şu an kullanılamıyor…" and the browser path.

## Links to the page

"Masaüstü uygulamasını indir" (`/indir`, new tab) at the end of the join card
and at the end of Ayarlar; not rendered when `window.trioDesktop` exists.

## Release workflow

`release.yml` attaches `SHA256SUMS.txt` and `signing.json` to every release
and signs when secrets exist (docs/imzalama.md): macOS `CSC_LINK`,
`CSC_KEY_PASSWORD`, `APPLE_API_KEY` (.p8 text), `APPLE_API_KEY_ID`,
`APPLE_API_ISSUER`; Windows `WIN_CSC_LINK` + `WIN_CSC_KEY_PASSWORD`, or the
seven `AZURE_*` secrets. Without them the builds are exactly as before.
