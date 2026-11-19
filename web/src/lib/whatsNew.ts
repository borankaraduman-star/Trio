/**
 * Which "Yenilikler" entries a device has not seen yet (CONTRACT-V4 A2).
 * `trio.seenVersion` holds the last version this device acknowledged.
 */
import type { ChangelogEntry } from '../changelog'

export const SEEN_VERSION_KEY = 'trio.seenVersion'

/**
 * The last version before the card existed: a device that used Trio before it
 * (it had a session when the page loaded) but has no stored value is treated
 * as having seen this one, so it is told about what came after.
 */
export const VERSION_BEFORE_CARD = '0.2.0'

/** At most this many VERSIONS on the card (a device back after a long time); a split version counts once. */
export const MAX_ENTRIES = 3

/** `1.2.3` → [1, 2, 3]; a pre-release or build suffix is ignored; anything else is null. */
export function parseVersion(value: unknown): [number, number, number] | null {
  if (typeof value !== 'string') return null
  const match = /^\s*v?(\d{1,6})\.(\d{1,6})(?:\.(\d{1,6}))?(?:[-+][0-9A-Za-z.-]*)?\s*$/.exec(value)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)]
}

/** Negative, 0 or positive like a sort comparator; an unparsable version sorts first. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) return (x ? 1 : 0) - (y ? 1 : 0)
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]
  return 0
}

/**
 * The entries newer than `stored` and not newer than `current`, newest first.
 * `stored` missing or unreadable: nothing on a device never used before (a
 * first visit), else everything after VERSION_BEFORE_CARD.
 */
export function entriesSince(
  changelog: readonly ChangelogEntry[],
  stored: string | null,
  current: string,
  knownDevice: boolean,
): ChangelogEntry[] {
  const since = parseVersion(stored) ? (stored as string) : knownDevice ? VERSION_BEFORE_CARD : null
  if (since === null) return []
  const newer = changelog
    .filter((entry) => compareVersions(entry.version, since) > 0 && compareVersions(entry.version, current) <= 0)
    .sort((a, b) => compareVersions(b.version, a.version))
  const kept: string[] = []
  return newer.filter((entry) => {
    if (kept.some((version) => compareVersions(version, entry.version) === 0)) return true
    if (kept.length >= MAX_ENTRIES) return false
    kept.push(entry.version)
    return true
  })
}

export function loadSeenVersion(): string | null {
  try {
    return localStorage.getItem(SEEN_VERSION_KEY)
  } catch {
    return null
  }
}

export function saveSeenVersion(version: string): void {
  try {
    localStorage.setItem(SEEN_VERSION_KEY, version)
  } catch {
    // The card may show again next time: harmless.
  }
}

/**
 * Whether this page was opened on a device that has used Trio before: a
 * session AND what every past session wrote (`trio.lastRead`, saved from the
 * first render of a session). Read once, when this module loads — before the
 * join screen or a session can write either — so a first join is never
 * mistaken for an update.
 */
export function deviceWasUsed(storage: Pick<Storage, 'getItem'>): boolean {
  return storage.getItem('trio.token') !== null && storage.getItem('trio.lastRead') !== null
}

export const DEVICE_KNOWN_AT_LOAD: boolean = (() => {
  try {
    return typeof localStorage !== 'undefined' && deviceWasUsed(localStorage)
  } catch {
    return false
  }
})()
