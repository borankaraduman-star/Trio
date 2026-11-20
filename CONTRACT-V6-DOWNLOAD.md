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
    GET  /indir                → the page (web/indir.html), with the app shell's headers (CSP, frame-ancestors none);
                                 root-relative <meta content="/…"> (og:image, og:url, twitter:image) made absolute
                                 from the request: X-Forwarded-Proto (http|https) or the request's scheme, and the
                                 Host only when it is a plain host[:port] (else the page is served as built)
                                 — and also the <link rel="canonical"> href and the "url"/"image" strings inside
                                 the page's one <script type="application/ld+json"> block (V10)
    GET  /download, /download/, /indir/, /indir.html → 302 /indir
    GET  /robots.txt           → 200 text/plain (V10, below)
    GET  /sitemap.xml          → 200 application/xml: one <url>, <origin>/indir
                                 404 NOT_FOUND when no origin can be built (same rule as above)

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

### The site around the download (V9)

The page is also Trio's one public site. Above and below the download it
shows what Trio does with live, scripted demos built from the client's own
look (no screenshots, no video): the main screen (friends joining the voice
room, messages, a reaction, a photo; the visitor may write into it and gets a
canned answer — nothing is sent anywhere), a voice room that keeps talking
through a server restart (mute and a 0–200 % volume are the visitor's), music
sharing (the music level, 0–100 %, is the visitor's), the phone (lock-screen
notifications and the call bar; the visitor switches views), and small live
vignettes (voice message, photo location removed, share profiles, own
server). Then three steps, the files and help (unchanged), five questions
and answers, and a footer with the version and the public repository.

- Every demo is a list of steps (`web/src/indir/demo/player.ts`) rendered from
  the step index. It plays only while a quarter of it is on screen and the tab
  is visible, has a pause button, and under `prefers-reduced-motion` never
  plays: it shows its last step and offers "Önceki / Sonraki adım". The roots
  carry `data-demo`, `data-step`, `data-last`, `data-playing`, `data-reduced`.
- Names in the demos are made up: one group of six (Ece, Ozan, Deniz, Selin,
  Barış, Melis), five of them in the voice room. Every claim on the page is one
  the contracts and the changelog back.
- No inline script, no external origin, no web font, and no image files besides the favicon: the
  demos are DOM and inline SVG. The link-preview image is
  `/og/trio-og.png` (1200×630, `design/tools/build_og.py`, from a real e2e
  screenshot).
- V10: the page is for search engines too (below).

### Who the page is for (V10)

Trio is for any group that runs its own server (a friend group, a small team,
a small community), built for up to about 10–15 people per server; a voice
room works best up to about 8 (full mesh). The page says so and never
promises more. It serves two readers:

- **Invited**: the hero's primary action (download for this system, or the
  phone card) and "Kurmadan kullan: tarayıcıda aç", under the label "Davet
  edildiysen"; the steps section (`#baslangic`) explains address → invite
  code → room.
- **Wants Trio for their group**: the hero's secondary link "Kendi sunucunu
  kur" (`#sunucu`), a section with what it takes (cost, effort, size), the
  Railway path in five steps, a link to the README's "Kendi sunucunu kur"
  section on GitHub, and what the owner gets (CONTRACT-V6-OPS).

The number three is the logo's, never a headline or a claim about the group.

### Search engines (V10)

- `/indir`: `<title>Trio — grubunun sohbeti, kendi sunucunda</title>`,
  `robots: index, follow`, a meta description, `<link rel="canonical">` and
  the Open Graph tags made absolute as above, `lang="tr"`, one `h1`, and a
  JSON-LD `SoftwareApplication` (name, description, category, operating
  systems, language, `isAccessibleForFree`, url, image, the repository as
  `sameAs`; no ratings, no price). JSON-LD is a data block: the shell CSP's
  `script-src` does not apply to it and nothing executes it.
- The app shell (`/`, every client route, `index.html`): `<meta name="robots"
  content="noindex">` and `X-Robots-Tag: noindex`. The join screen links
  "Trio nedir?" → `/indir` (not inside the desktop app).
- `/robots.txt`: `User-agent: *`, `Allow: /indir`, `Disallow: /api/`
  (uploaded files and avatars live there), `Disallow: /ws`,
  `Disallow: /indir/dosya/`, and `Sitemap: <origin>/sitemap.xml` when an
  origin can be built. `/` is deliberately not disallowed: a crawler must be
  able to read its noindex.

## Links to the page

"Masaüstü uygulamasını indir" (`/indir`, new tab) at the end of the join card
and at the end of Ayarlar; not rendered when `window.trioDesktop` exists.

## Release workflow

`release.yml` attaches `SHA256SUMS.txt` and `signing.json` to every release
and signs when secrets exist (docs/imzalama.md): macOS `CSC_LINK`,
`CSC_KEY_PASSWORD`, `APPLE_API_KEY` (.p8 text), `APPLE_API_KEY_ID`,
`APPLE_API_ISSUER`; Windows `WIN_CSC_LINK` + `WIN_CSC_KEY_PASSWORD`, or the
seven `AZURE_*` secrets. Without them the builds are exactly as before.
