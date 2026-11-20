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
  | { kind: 'available'; version: string }
  | { kind: 'downloading'; version: string; percent: number | null }
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
    if (shell.status === 'available' && version) return { kind: 'available', version }
    if (shell.status === 'downloading' && version) return { kind: 'downloading', version, percent: shell.percent }
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
