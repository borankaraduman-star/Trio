/**
 * CONTRACT-V7-READING §7: a device code as a link (and a QR of it):
 * `<origin>/#cihaz=<code>`. Like the invite link (lib/inviteLink.ts) the code
 * travels in the FRAGMENT, which a browser never sends to the server, and it is
 * taken out of the address bar as soon as the page has read it.
 */
import { normalizeLinkCode } from './linkCode'

const KEYS = ['cihaz', 'device'] as const

function params(hash: string): URLSearchParams | null {
  const text = hash.startsWith('#') ? hash.slice(1) : hash
  if (text === '') return null
  try {
    return new URLSearchParams(text)
  } catch {
    return null
  }
}

/** The device code in a location hash, normalised; null when there is none or it cannot be one. */
export function parseDeviceFragment(hash: string): string | null {
  const found = params(hash)
  if (!found) return null
  for (const key of KEYS) {
    const value = found.get(key)
    if (value !== null) return normalizeLinkCode(value.trim())
  }
  return null
}

/** The hash once the device code is taken out ('' when nothing else was in it). */
export function hashWithoutDeviceCode(hash: string): string {
  const found = params(hash)
  if (!found) return ''
  for (const key of KEYS) found.delete(key)
  const rest = found.toString()
  return rest === '' ? '' : `#${rest}`
}

export function deviceLinkUrl(origin: string, code: string): string {
  return `${origin}/#cihaz=${encodeURIComponent(code)}`
}

let taken: { code: string | null } | null = null

/** Read once per page load; the fragment leaves the address bar (and the history) at once. */
export function takeDeviceCodeFromLocation(): string | null {
  if (taken) return taken.code
  let code: string | null = null
  try {
    const { hash, pathname, search } = window.location
    const present = KEYS.some((key) => params(hash)?.has(key))
    code = parseDeviceFragment(hash)
    if (present) window.history.replaceState(window.history.state, '', `${pathname}${search}${hashWithoutDeviceCode(hash)}`)
  } catch {
    code = null
  }
  taken = { code }
  return code
}
