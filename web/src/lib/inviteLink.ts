/**
 * Invite links: `<origin>/#davet=<code>`. The code travels in the FRAGMENT,
 * which a browser never sends to the server, so it stays out of every access
 * log and proxy; it is never put in the query string.
 */

const KEYS = ['davet', 'invite'] as const

/** The invite code in a location hash (`#davet=…` or `#invite=…`, URL-decoded), else null. */
export function parseInviteFragment(hash: string): string | null {
  const text = hash.startsWith('#') ? hash.slice(1) : hash
  if (text === '') return null
  let params: URLSearchParams
  try {
    params = new URLSearchParams(text)
  } catch {
    return null
  }
  for (const key of KEYS) {
    const value = params.get(key)
    if (value !== null && value.trim() !== '') return value.trim()
  }
  return null
}

/** The hash left once the invite is taken out ('' when nothing else was in it). */
export function hashWithoutInvite(hash: string): string {
  const text = hash.startsWith('#') ? hash.slice(1) : hash
  const params = new URLSearchParams(text)
  for (const key of KEYS) params.delete(key)
  const rest = params.toString()
  return rest === '' ? '' : `#${rest}`
}

/** The link to share: the code in the fragment, encoded. */
export function inviteLinkUrl(origin: string, code: string): string {
  return `${origin}/#davet=${encodeURIComponent(code)}`
}

let taken: { code: string | null } | null = null

/**
 * Reads the invite code from the address bar ONCE per page load and removes
 * it from there at once (`history.replaceState`), so it is not left in the
 * history, a bookmark or a screenshot. Later calls answer the same code.
 */
export function takeInviteFromLocation(): string | null {
  if (taken) return taken.code
  let code: string | null = null
  try {
    const { hash, pathname, search } = window.location
    code = parseInviteFragment(hash)
    if (code !== null) {
      window.history.replaceState(window.history.state, '', `${pathname}${search}${hashWithoutInvite(hash)}`)
    }
  } catch {
    code = null
  }
  taken = { code }
  return code
}
