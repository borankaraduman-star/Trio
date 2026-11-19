/**
 * The desktop app's version and the update notice (CONTRACT-V6-VOICE,
 * "Desktop version"). The desktop app and the server are released together
 * with one version number, so a desktop app OLDER than the server (or one so
 * old it does not say) has a newer build waiting. Never in a plain browser.
 */

/** The server's own download page (CONTRACT-V6-DOWNLOAD); the desktop app opens it in the system browser. */
export const DESKTOP_RELEASES_URL = '/indir'
export const DISMISSED_KEY = 'trio.desktopUpdateDismissed'

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

export interface DesktopVersionState {
  /** "Masaüstü uygulaması 0.4.0" / "… (eski sürüm)". */
  line: string
  /** The version to update to, or null. */
  update: string | null
}

/**
 * `appVersion` is the bridge's value (undefined from a build before it);
 * `serverVersion` is `ready.server_version` (null/"unknown" from a server that
 * does not say), else this web client's own version stands in for it.
 */
export function desktopVersionState(input: {
  isDesktop: boolean
  appVersion: unknown
  serverVersion: string | null | undefined
  clientVersion: string
}): DesktopVersionState | null {
  if (!input.isDesktop) return null
  const app = typeof input.appVersion === 'string' && parse(input.appVersion) ? input.appVersion : null
  const reference =
    typeof input.serverVersion === 'string' && parse(input.serverVersion) ? input.serverVersion : input.clientVersion
  const known = parse(reference) !== null
  const line = app ? `Masaüstü uygulaması ${app}` : 'Masaüstü uygulaması (eski sürüm)'
  if (!known) return { line, update: null }
  if (app === null) return { line, update: reference }
  const order = compareVersions(app, reference)
  return { line, update: order !== null && order < 0 ? reference : null }
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
