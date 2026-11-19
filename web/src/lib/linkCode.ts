/**
 * Device link codes (CONTRACT-V3 §2): shown on a signed-in device, typed on
 * the new one. Pure helpers for showing, typing and counting down a code.
 */

/** The server's alphabet: no 0/O, no 1/I/L. */
export const LINK_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
export const LINK_CODE_LENGTH = 10
/** How long a code lives (the server's TTL); a countdown never shows more. */
export const LINK_CODE_TTL_SECONDS = 600
/** What the server accepts as typed (separators included). */
export const LINK_CODE_INPUT_MAX = 64

const SEPARATORS = /[\s-]/g

/** "K7QX3MZ9PA" → "K7QX3-MZ9PA": two groups of five, easier to read out and type. */
export function formatLinkCode(code: string): string {
  const clean = code.replace(SEPARATORS, '').toUpperCase()
  if (clean.length <= 5) return clean
  return `${clean.slice(0, 5)}-${clean.slice(5)}`
}

/**
 * What the server will make of a typed code: case, spaces and dashes ignored.
 * Null when it cannot be a code (wrong length, a letter the alphabet lacks).
 */
export function normalizeLinkCode(raw: string): string | null {
  if (raw.length > LINK_CODE_INPUT_MAX) return null
  const code = raw.replace(SEPARATORS, '').toUpperCase()
  if (code.length !== LINK_CODE_LENGTH) return null
  for (const ch of code) if (!LINK_CODE_ALPHABET.includes(ch)) return null
  return code
}

/**
 * The input field's text while typing or after a paste: upper case, grouped,
 * at most one code long. Characters the code cannot contain are kept (so the
 * person sees what they typed) and reported by `linkCodeProblem`.
 */
export function tidyLinkCodeInput(raw: string): string {
  const compact = raw.replace(SEPARATORS, '').toUpperCase().slice(0, LINK_CODE_LENGTH)
  return formatLinkCode(compact)
}

/** A Turkish sentence when the typed text cannot be a code, else null. Empty input is not a problem yet. */
export function linkCodeProblem(raw: string): string | null {
  const compact = raw.replace(SEPARATORS, '').toUpperCase()
  if (compact === '') return null
  const foreign = [...new Set([...compact].filter((ch) => !LINK_CODE_ALPHABET.includes(ch)))]
  if (foreign.length > 0) {
    return `Kodda “${foreign.join(' ')}” olamaz. Kodlarda 0, O, 1, I ve L kullanılmaz; harfleri yeniden kontrol et.`
  }
  return null
}

/**
 * When the code expires, on THIS device's clock. The server's `expires_at` is
 * on the server's clock; the response's `Date` header says what time the
 * server thought it was when it answered, so a device whose clock is minutes
 * off still counts down the right ten minutes.
 */
export function localExpiry(expiresAt: string, serverDate: string | null, receivedAtMs: number): number {
  const expires = Date.parse(expiresAt)
  if (!Number.isFinite(expires)) return receivedAtMs
  const serverNow = serverDate ? Date.parse(serverDate) : Number.NaN
  if (!Number.isFinite(serverNow)) return expires
  // `Date` has whole seconds and is truncated: the server's real time was within the next second.
  // Taking its end errs on the safe side: the code is shown as expiring up to a second EARLY, never late.
  return receivedAtMs + (expires - (serverNow + 999))
}

/** Whole seconds left until `expiresAtMs`, never negative and never more than a code's life. */
export function secondsLeft(expiresAtMs: number, nowMs: number): number {
  return Math.min(LINK_CODE_TTL_SECONDS, Math.max(0, Math.ceil((expiresAtMs - nowMs) / 1000)))
}

/** 599 → "9:59", 5 → "0:05". */
export function formatCountdown(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return `${minutes}:${String(rest).padStart(2, '0')}`
}
