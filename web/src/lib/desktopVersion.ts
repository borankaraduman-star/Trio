/**
 * The desktop app's version and its update notice (CONTRACT-V6-VOICE
 * "Desktop version", replaced by CONTRACT-V10-UPDATE §4). The notice depends
 * on whether a NEWER DESKTOP RELEASE exists (`/api/downloads`' version, i.e.
 * GitHub's latest release), never on the server's version: a web-only
 * release does not nag. Inside an app that updates itself (the bridge's
 * `getUpdateState`, capability "auto") the shell's own state is shown
 * instead. Never in a plain browser.
 */

/** The server's own download page (CONTRACT-V6-DOWNLOAD); the desktop app opens it in the system browser. */
export const DESKTOP_RELEASES_URL = '/indir'
export const DISMISSED_KEY = 'trio.desktopUpdateDismissed'

/**
 * The first desktop release that carries the updater (CONTRACT-V10-UPDATE §6).
 * An app without the updater installing this version or later does its last
 * manual install, and the notice says so. If the release that ships the
 * updater gets another number, set it here: a too-high value only hides the
 * sentence, it never promises something false.
 */
export const FIRST_SELF_UPDATING_VERSION = '0.8.0'

interface Parsed {
  core: [number, number, number]
  pre: string | null
}

function parse(version: string): Parsed | null {
  const match = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version.trim())
  if (!match) return null
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ?? null }
}

/** Semver order of two versions: <0, 0, >0; null when either is not a version. Build metadata is ignored. */
export function compareVersions(a: string, b: string): number | null {
  const x = parse(a)
  const y = parse(b)
  if (!x || !y) return null
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i]
  if (x.pre === y.pre) return 0
  if (x.pre === null) return 1 // a release is newer than its pre-releases
  if (y.pre === null) return -1
  const xs = x.pre.split('.')
  const ys = y.pre.split('.')
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    if (xs[i] === undefined) return -1
    if (ys[i] === undefined) return 1
    const xn = /^\d+$/.test(xs[i]) ? Number(xs[i]) : null
    const yn = /^\d+$/.test(ys[i]) ? Number(ys[i]) : null
    if (xn !== null && yn !== null) {
      if (xn !== yn) return xn - yn
    } else if (xn !== null) return -1
    else if (yn !== null) return 1
    else if (xs[i] !== ys[i]) return xs[i] < ys[i] ? -1 : 1
  }
  return 0
}

export type DownloadPlatform = 'windows' | 'mac-arm64' | 'mac-x64' | 'linux'

export interface DesktopRelease {
  version: string
  files: { platform: DownloadPlatform; url: string }[]
}

const PLATFORMS: readonly DownloadPlatform[] = ['windows', 'mac-arm64', 'mac-x64', 'linux']

/** Defensive read of `/api/downloads`; null when there is no usable release. */
export function parseRelease(json: unknown): DesktopRelease | null {
  const record = json as { version?: unknown; files?: unknown } | null
  if (!record || typeof record.version !== 'string' || !parse(record.version)) return null
  const files: DesktopRelease['files'] = []
  if (Array.isArray(record.files)) {
    for (const file of record.files as { platform?: unknown; url?: unknown }[]) {
      const platform = file?.platform
      const url = file?.url
      if (typeof platform !== 'string' || !PLATFORMS.includes(platform as DownloadPlatform)) continue
      // Only the server's own redirect (CONTRACT-V6-DOWNLOAD), never an outside address.
      if (typeof url !== 'string' || url !== `/indir/dosya/${platform}`) continue
      files.push({ platform: platform as DownloadPlatform, url })
    }
  }
  return { version: record.version, files }
}

/** The shell's update state (CONTRACT-V10-UPDATE §3); only what the page reads. */
export interface ShellUpdateState {
  capability: 'auto' | 'manual'
  reason: string | null
  platform: DownloadPlatform | null
  currentVersion: string
  autoDownload: boolean
  status: 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'ready' | 'installing' | 'error' | 'manual'
  version: string | null
  percent: number | null
  error: string | null
  checkedAt: number | null
  inVoice: boolean
}

/** Defensive read of the bridge's state: anything malformed is "no updater". */
export function parseShellState(value: unknown): ShellUpdateState | null {
  const r = value as Partial<ShellUpdateState> | null
  if (!r || typeof r !== 'object') return null
  if (r.capability !== 'auto' && r.capability !== 'manual') return null
  if (typeof r.status !== 'string') return null
  const platform = typeof r.platform === 'string' && PLATFORMS.includes(r.platform as DownloadPlatform) ? r.platform : null
  return {
    capability: r.capability,
    reason: typeof r.reason === 'string' ? r.reason : null,
    platform: platform as DownloadPlatform | null,
    currentVersion: typeof r.currentVersion === 'string' ? r.currentVersion : '',
    autoDownload: r.autoDownload !== false,
    status: r.status as ShellUpdateState['status'],
    version: typeof r.version === 'string' ? r.version : null,
    percent: typeof r.percent === 'number' && Number.isFinite(r.percent) ? Math.round(r.percent) : null,
    error: typeof r.error === 'string' ? r.error : null,
    checkedAt: typeof r.checkedAt === 'number' ? r.checkedAt : null,
    inVoice: r.inVoice === true,
  }
}

/** Which installer(s) fit this machine: the shell says; an older app is guessed from the user agent. */
export function platformsFor(shell: DownloadPlatform | null, userAgent: string): DownloadPlatform[] {
  if (shell) return [shell]
  if (/Windows/.test(userAgent)) return ['windows']
  if (/Macintosh|Mac OS X/.test(userAgent)) return ['mac-arm64', 'mac-x64'] // an old app cannot tell the processor
  if (/Linux/.test(userAgent) && !/Android/.test(userAgent)) return ['linux']
  return []
}

export interface DownloadButton {
  platform: DownloadPlatform
  url: string
  label: string
}

const LABEL: Record<DownloadPlatform, string> = {
  windows: 'İndir',
  linux: 'İndir',
  'mac-arm64': 'İndir (Apple Silicon)',
  'mac-x64': 'İndir (Intel)',
}

export type DesktopNotice =
  /** Download and install by hand (no updater, or one that cannot update here, or one that failed). */
  | { kind: 'manual'; version: string; downloads: DownloadButton[]; lastManual: boolean }
  /** The shell found a newer version and automatic download is off. */
  | { kind: 'available'; version: string; inVoice: boolean }
  | { kind: 'downloading'; version: string; percent: number | null; inVoice: boolean }
  /** Downloaded and verified: "Yeniden başlat ve güncelle". */
  | { kind: 'ready'; version: string; inVoice: boolean }

export interface NoticeInput {
  isDesktop: boolean
  appVersion: unknown
  /** The bridge has the V10 update members. */
  hasUpdater: boolean
  shell: ShellUpdateState | null
  release: DesktopRelease | null
  userAgent: string
}

function validApp(appVersion: unknown): string | null {
  return typeof appVersion === 'string' && parse(appVersion) ? appVersion : null
}

/** A newer DESKTOP release than this app (an app too old to say its version is older than any). */
export function newerRelease(appVersion: unknown, release: DesktopRelease | null): boolean {
  if (!release) return false
  const app = validApp(appVersion)
  if (app === null) return true
  const order = compareVersions(release.version, app)
  return order !== null && order > 0
}

export function desktopNotice(input: NoticeInput): DesktopNotice | null {
  if (!input.isDesktop) return null
  const shell = input.hasUpdater ? input.shell : null
  if (shell?.capability === 'auto') {
    const version = shell.version
    if ((shell.status === 'ready' || shell.status === 'installing') && version) {
      return { kind: 'ready', version, inVoice: shell.inVoice }
    }
    if (shell.status === 'available' && version) return { kind: 'available', version, inVoice: shell.inVoice }
    if (shell.status === 'downloading' && version) {
      return { kind: 'downloading', version, percent: shell.percent, inVoice: shell.inVoice }
    }
    // Self-update failed: the newer release is still one download away.
    if (shell.status !== 'error') return null
  }
  if (!input.release || !newerRelease(input.appVersion, input.release)) return null
  const release = input.release
  const wanted = platformsFor(shell?.platform ?? null, input.userAgent)
  const downloads = wanted.flatMap((platform) => {
    const file = release.files.find((f) => f.platform === platform)
    return file ? [{ platform, url: file.url, label: LABEL[platform] }] : []
  })
  const first = compareVersions(release.version, FIRST_SELF_UPDATING_VERSION)
  const lastManual =
    !input.hasUpdater && first !== null && first >= 0 && (wanted[0] === 'windows' || wanted[0] === 'linux')
  return { kind: 'manual', version: release.version, downloads, lastManual }
}

/** "Masaüstü uygulaması 0.4.0" / "… (eski sürüm)". */
export function desktopLine(appVersion: unknown): string {
  const app = validApp(appVersion)
  return app ? `Masaüstü uygulaması ${app}` : 'Masaüstü uygulaması (eski sürüm)'
}

export const LAST_MANUAL_TEXT = 'Bu son elle kurulum: bundan sonra uygulama kendini güncelleyecek.'

/** Why this app does not update itself (Hakkında). */
export function manualReasonText(reason: string | null): string | null {
  switch (reason) {
    case 'unsigned-mac':
      return 'Bu Mac\'te güncellemeler elle kurulur: uygulama imzasız olduğu için macOS kendini güncellemesine izin vermiyor.'
    case 'not-appimage':
      return 'Kendiliğinden güncelleme yalnız AppImage olarak çalışırken olur; yeni sürümü elle kur.'
    case 'portable':
      return 'Taşınabilir sürüm kendini güncellemez; yeni sürümü elle kur.'
    case 'dev':
      return 'Geliştirme sürümü: güncelleme denetlenmez.'
    case 'no-config':
    case 'unsupported':
      return 'Bu kurulum kendini güncelleyemiyor; yeni sürümü elle kur.'
    default:
      return null
  }
}

/** One line for Ayarlar › Hakkında from the shell's state. */
export function statusText(state: ShellUpdateState): string {
  switch (state.status) {
    case 'idle':
      return 'Güncellemeler birazdan denetlenecek.'
    case 'checking':
      return 'Güncellemeler denetleniyor…'
    case 'up-to-date':
      return 'Güncel'
    case 'available':
      return `Yeni sürüm var: ${state.version ?? ''}`.trim()
    case 'downloading':
      return `İndiriliyor %${state.percent ?? 0}`
    case 'ready':
      return `Hazır: ${state.version ?? ''} — yeniden başlatınca kurulur`
    case 'installing':
      return 'Yeniden başlatılıyor…'
    case 'error':
      return `Güncelleme denetlenemedi (${state.error ?? 'bilinmeyen neden'})`
    case 'manual':
      return manualReasonText(state.reason) ?? ''
  }
}

export function updateText(version: string): string {
  return `Masaüstü uygulamasının yeni sürümü var (${version}).`
}

/** The band's one line for the shell's own states (CONTRACT-V10-UPDATE §5). */
export function bandText(notice: Exclude<DesktopNotice, { kind: 'manual' }>): string {
  const inVoice = notice.inVoice ? ' — sesli odadan çıkınca kurulabilir' : ''
  switch (notice.kind) {
    case 'available':
      return updateText(notice.version)
    case 'downloading':
      return `Güncelleme indiriliyor: ${notice.version} (%${notice.percent ?? 0})${inVoice}`
    case 'ready':
      return `Güncelleme hazır: ${notice.version}${inVoice}`
  }
}

// ------------------------------------------------------------ "look now"

/**
 * CONTRACT-V10-UPDATE §4a: the page learns of a new desktop release from
 * `/api/downloads` (polled) long before the shell's own schedule would, and
 * then asks the shell to look (`checkForUpdates()`, which every updating
 * shell since 0.8.0 has). The shell stays the authority: it reads its pinned
 * feed and decides; this only says "look now". At most once per version per
 * `HINT_RETRY_MS`, also across reloads.
 */
export const HINT_RETRY_MS = 10 * 60 * 1000
export const HINT_KEY = 'trio.desktopUpdateHint'
/** How often an open page asks the server for the newest desktop release. */
export const RELEASE_POLL_MS = 5 * 60 * 1000

export interface HintRecord {
  version: string
  at: number
}

export interface HintInput {
  appVersion: unknown
  hasUpdater: boolean
  shell: ShellUpdateState | null
  release: DesktopRelease | null
  last: HintRecord | null
  now: number
}

/** Statuses in which the shell is already busy with (or done with) an update: never nudged. */
const SHELL_BUSY: readonly ShellUpdateState['status'][] = ['checking', 'downloading', 'ready', 'installing', 'manual']

export function shouldAskShell(input: HintInput): boolean {
  const { shell, release } = input
  if (!input.hasUpdater || !shell || shell.capability !== 'auto' || !release) return false
  if (!newerRelease(input.appVersion, release)) return false
  if (SHELL_BUSY.includes(shell.status)) return false
  // The shell already knows this version (or a newer one) and only waits for "İndir".
  if (shell.status === 'available' && shell.version && (compareVersions(shell.version, release.version) ?? -1) >= 0) {
    return false
  }
  const last = input.last
  if (last && last.version === release.version && input.now - last.at >= 0 && input.now - last.at < HINT_RETRY_MS) {
    return false
  }
  return true
}

export function loadHint(storage: Pick<Storage, 'getItem'> | null = safeStorage()): HintRecord | null {
  try {
    const raw = JSON.parse(storage?.getItem(HINT_KEY) ?? 'null') as Partial<HintRecord> | null
    return raw && typeof raw.version === 'string' && typeof raw.at === 'number' ? { version: raw.version, at: raw.at } : null
  } catch {
    return null
  }
}

export function saveHint(record: HintRecord, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  try {
    storage?.setItem(HINT_KEY, JSON.stringify(record))
  } catch {
    // Private mode: the in-memory record still rate-limits this page.
  }
}

/** "Sonra" on available/downloading, per version; a ready update shows again. */
export const LATER_KEY = 'trio.desktopUpdateLater'

export function loadLater(storage: Pick<Storage, 'getItem'> | null = safeStorage()): string | null {
  try {
    return storage?.getItem(LATER_KEY) ?? null
  } catch {
    return null
  }
}

export function saveLater(version: string, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  try {
    storage?.setItem(LATER_KEY, version)
  } catch {
    // ignore
  }
}

/**
 * The newest desktop release, kept fresh while somebody watches: asked on the
 * first subscription, every `RELEASE_POLL_MS`, when the page becomes visible
 * again (respecting the poll interval) and on `refresh(true)` (the socket's
 * `ready`, i.e. every (re)connect; at most once per `FORCE_GAP_MS`). The
 * server caches GitHub for ten minutes, so these are in-memory answers.
 */
export const FORCE_GAP_MS = 30 * 1000

export interface ReleaseWatchDeps {
  fetchRelease: () => Promise<DesktopRelease | null>
  now: () => number
  setInterval: (cb: () => void, ms: number) => unknown
  clearInterval: (handle: unknown) => void
}

export class ReleaseWatch {
  private value: DesktopRelease | null = null
  private askedAt: number | null = null
  private inFlight: Promise<void> | null = null
  private timer: unknown = null
  private readonly listeners = new Set<(release: DesktopRelease | null) => void>()

  constructor(private readonly deps: ReleaseWatchDeps) {}

  get current(): DesktopRelease | null {
    return this.value
  }

  subscribe(listener: (release: DesktopRelease | null) => void): () => void {
    this.listeners.add(listener)
    if (this.listeners.size === 1) {
      this.timer = this.deps.setInterval(() => void this.refresh(), RELEASE_POLL_MS)
    }
    void this.refresh()
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0 && this.timer !== null) {
        this.deps.clearInterval(this.timer)
        this.timer = null
      }
    }
  }

  /** Asks the server unless it was asked recently (`force`: recently = `FORCE_GAP_MS`). */
  refresh(force = false): Promise<void> {
    if (this.inFlight) return this.inFlight
    const now = this.deps.now()
    const gap = force ? FORCE_GAP_MS : RELEASE_POLL_MS - 1000
    if (this.askedAt !== null && now - this.askedAt >= 0 && now - this.askedAt < gap) return Promise.resolve()
    this.askedAt = now
    this.inFlight = this.deps
      .fetchRelease()
      .catch(() => null)
      .then((release) => {
        // A failed ask keeps what was known (GitHub or the server may be briefly down).
        if (release) this.value = release
        for (const listener of [...this.listeners]) listener(this.value)
      })
      .finally(() => {
        this.inFlight = null
      })
    return this.inFlight
  }
}

export function loadDismissed(storage: Pick<Storage, 'getItem'> | null = safeStorage()): string | null {
  try {
    return storage?.getItem(DISMISSED_KEY) ?? null
  } catch {
    return null
  }
}

export function saveDismissed(version: string, storage: Pick<Storage, 'setItem'> | null = safeStorage()): void {
  try {
    storage?.setItem(DISMISSED_KEY, version)
  } catch {
    // Private mode: dismissed until the tab closes.
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}
