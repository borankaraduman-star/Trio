/** `Retry-After` (RFC 9110 §10.2.3) and how to say "try again in …" in Turkish. */

/** Seconds to wait, from a delay in seconds or an HTTP date. Null when absent or unreadable. */
export function parseRetryAfter(value: string | null | undefined, nowMs: number): number | null {
  if (value === null || value === undefined) return null
  const text = value.trim()
  if (text === '') return null
  if (/^\d+$/.test(text)) {
    const seconds = Number(text)
    return Number.isSafeInteger(seconds) ? seconds : null
  }
  // An HTTP date names its day ("Wed, 18 Nov 2026 12:00:30 GMT"); Date.parse alone takes "-5" for a year.
  if (!/^[A-Za-z]{3},\s/.test(text)) return null
  const date = Date.parse(text)
  if (!Number.isFinite(date)) return null
  return Math.max(0, Math.ceil((date - nowMs) / 1000))
}

/** 8 → "8 saniye", 75 → "2 dakika", 600 → "10 dakika" (always rounded up: never too early). */
export function formatWait(seconds: number): string {
  const total = Math.max(1, Math.ceil(seconds))
  if (total < 60) return `${total} saniye`
  return `${Math.ceil(total / 60)} dakika`
}

/** The join screen's sentence while a rate limit lasts; `secondsLeft` null when the server said nothing. */
export function rateLimitMessage(secondsLeft: number | null): string {
  if (secondsLeft === null) return 'Çok fazla deneme yapıldı. Biraz sonra tekrar dene.'
  if (secondsLeft <= 0) return 'Çok fazla deneme yapılmıştı; şimdi tekrar deneyebilirsin.'
  return `Çok fazla deneme yapıldı. ${formatWait(secondsLeft)} sonra tekrar dene.`
}
