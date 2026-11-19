/**
 * Quiet hours (CONTRACT-V6-PUSH §5): a daily range in a time zone. The server
 * decides (notify.in_quiet_hours); this is the same rule for the settings
 * screen's "şu an sessiz saatlerdesin" line and the local notifications.
 * Start inclusive, end exclusive, start > end runs over midnight, start == end
 * is no range; wall-clock time in the zone (DST days follow the clock).
 */

export interface QuietHours {
  enabled: boolean
  /** "HH:MM", 24-hour. */
  start: string
  end: string
  /** IANA name, e.g. "Europe/Istanbul". */
  tz: string
}

export const DEFAULT_TZ = 'Europe/Istanbul'

export function isHhMm(value: string): boolean {
  return /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(value)
}

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

/** Minutes past local midnight of `nowMs` in `tz` (an unknown zone counts as Istanbul). */
export function localMinutes(nowMs: number, tz: string): number {
  let format: Intl.DateTimeFormat
  try {
    format = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  } catch {
    format = new Intl.DateTimeFormat('en-GB', { timeZone: DEFAULT_TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  }
  const parts = format.formatToParts(new Date(nowMs))
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
  return hour * 60 + minute
}

export function inQuietHours(quiet: QuietHours, nowMs: number): boolean {
  if (!quiet.enabled || !isHhMm(quiet.start) || !isHhMm(quiet.end)) return false
  const start = minutes(quiet.start)
  const end = minutes(quiet.end)
  if (start === end) return false
  const now = localMinutes(nowMs, quiet.tz || DEFAULT_TZ)
  return start < end ? now >= start && now < end : now >= start || now < end
}

/** The browser's own zone, for "saat dilimi" (falls back to Istanbul). */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_TZ
  } catch {
    return DEFAULT_TZ
  }
}

export function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz })
    return true
  } catch {
    return false
  }
}
