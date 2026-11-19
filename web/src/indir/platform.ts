/**
 * The download page's pure parts (CONTRACT-V6-DOWNLOAD): which installer a
 * visitor most likely wants, and how sizes and dates are written.
 */

export type Platform = 'windows' | 'mac-arm64' | 'mac-x64' | 'linux'
export type Visitor = Platform | 'phone' | 'unknown'

export interface DownloadFile {
  platform: Platform
  name: string
  size: number
  sha256: string | null
  url: string
}

export interface Downloads {
  version: string | null
  published_at: string | null
  signed: { windows: boolean; mac: boolean }
  files: DownloadFile[]
}

export const PLATFORM_ORDER: Platform[] = ['windows', 'mac-arm64', 'mac-x64', 'linux']

export const PLATFORM_LABEL: Record<Platform, string> = {
  windows: 'Windows',
  'mac-arm64': 'macOS (Apple Silicon: M1, M2, M3…)',
  'mac-x64': 'macOS (Intel işlemcili)',
  linux: 'Linux (AppImage)',
}

/** Short names for the primary button: "Windows için indir". */
export const PLATFORM_SHORT: Record<Platform, string> = {
  windows: 'Windows',
  'mac-arm64': 'Mac (Apple Silicon)',
  'mac-x64': 'Mac (Intel)',
  linux: 'Linux',
}

export interface VisitorHints {
  userAgent: string
  /** `navigator.maxTouchPoints`: an iPad asking for the desktop site says "Macintosh". */
  maxTouchPoints?: number
  /** `navigator.userAgentData.getHighEntropyValues(['architecture'])`, Chromium only: "arm" | "x86". */
  architecture?: string | null
  /** The WebGL renderer string, e.g. "Apple M2" on Apple Silicon, "Intel Iris" on an Intel Mac. */
  gpu?: string | null
}

/**
 * The visitor's platform. A Mac's user agent says "Intel Mac OS X" whatever
 * its processor (Apple froze it), so the processor comes from the high-entropy
 * hint or the GPU name when the browser gives one; without either, Apple
 * Silicon is the better guess (every Mac sold since 2021) and the Intel file
 * stays one line below.
 */
export function detectVisitor(hints: VisitorHints): Visitor {
  const ua = hints.userAgent
  if (/Android|iPhone|iPad|iPod|Mobile|Windows Phone/i.test(ua)) return 'phone'
  if (/Macintosh|Mac OS X/i.test(ua)) {
    if ((hints.maxTouchPoints ?? 0) > 1) return 'phone' // iPadOS in desktop mode
    const arch = hints.architecture?.toLowerCase() ?? ''
    if (arch.startsWith('arm')) return 'mac-arm64'
    if (arch.startsWith('x86')) return 'mac-x64'
    const gpu = hints.gpu ?? ''
    if (/Apple (M\d|GPU)/i.test(gpu)) return 'mac-arm64'
    if (/Intel|AMD|Radeon|NVIDIA/i.test(gpu)) return 'mac-x64'
    return 'mac-arm64'
  }
  if (/Windows/i.test(ua)) return 'windows'
  if (/CrOS/i.test(ua)) return 'unknown'
  if (/Linux|X11/i.test(ua)) return 'linux'
  return 'unknown'
}

const SIZE = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 0 })

/** 92_274_688 → "88 MB" (binary megabytes, as the file managers show them). */
export function formatSize(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  if (mb < 1) return `${SIZE.format(Math.max(1, Math.round(bytes / 1024)))} KB`
  return `${SIZE.format(mb)} MB`
}

const DATE = new Intl.DateTimeFormat('tr-TR', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'Europe/Istanbul',
})

/** "2026-11-18T09:30:00Z" → "18 Kasım 2026"; null when it is not a date. */
export function formatDate(iso: string | null): string | null {
  if (!iso) return null
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? null : DATE.format(date)
}

/** The platform whose file is the primary button; null when none fits. */
export function primaryFile(visitor: Visitor, files: DownloadFile[]): DownloadFile | null {
  if (visitor === 'phone' || visitor === 'unknown') return null
  return files.find((f) => f.platform === visitor) ?? null
}

/** Files in the page's fixed order, the primary one left out. */
export function otherFiles(files: DownloadFile[], primary: DownloadFile | null): DownloadFile[] {
  return PLATFORM_ORDER.flatMap((p) => files.filter((f) => f.platform === p && f !== primary))
}

/** Which help section a platform's warning belongs to. */
export function family(platform: Platform): 'windows' | 'mac' | 'linux' {
  return platform === 'windows' ? 'windows' : platform === 'linux' ? 'linux' : 'mac'
}

/** PowerShell that answers True when the downloaded file is the one on the page. */
export function powershellCheck(name: string, sha256: string): string {
  return `(Get-FileHash "$env:USERPROFILE\\Downloads\\${name}" -Algorithm SHA256).Hash -eq "${sha256.toUpperCase()}"`
}

/** The same on macOS / Linux: prints "OK" or "FARKLI". */
export function shellCheck(platform: Platform, name: string, sha256: string): string {
  // Linux names the folder in the desktop's language (~/İndirilenler); xdg-user-dir knows it.
  const path = platform === 'linux' ? `"$(xdg-user-dir DOWNLOAD)/${name}"` : `~/Downloads/${name}`
  const tool = platform === 'linux' ? 'sha256sum' : 'shasum -a 256'
  return `[ "$(${tool} ${path} | cut -d' ' -f1)" = "${sha256}" ] && echo OK || echo FARKLI`
}

/** Defensive read of /api/downloads: anything unexpected becomes "unavailable". */
export function readDownloads(raw: unknown): Downloads {
  const empty: Downloads = { version: null, published_at: null, signed: { windows: false, mac: false }, files: [] }
  if (!raw || typeof raw !== 'object') return empty
  const body = raw as Record<string, unknown>
  const signed = (body.signed ?? {}) as Record<string, unknown>
  const files = Array.isArray(body.files) ? body.files : []
  return {
    version: typeof body.version === 'string' ? body.version : null,
    published_at: typeof body.published_at === 'string' ? body.published_at : null,
    signed: { windows: signed.windows === true, mac: signed.mac === true },
    files: files.flatMap((f): DownloadFile[] => {
      if (!f || typeof f !== 'object') return []
      const file = f as Record<string, unknown>
      const platform = file.platform as Platform
      if (!PLATFORM_ORDER.includes(platform)) return []
      if (typeof file.name !== 'string' || typeof file.size !== 'number') return []
      if (typeof file.url !== 'string' || !file.url.startsWith('/indir/dosya/')) return []
      const sha = typeof file.sha256 === 'string' && /^[0-9a-f]{64}$/.test(file.sha256) ? file.sha256 : null
      return [{ platform, name: file.name, size: file.size, sha256: sha, url: file.url }]
    }),
  }
}
