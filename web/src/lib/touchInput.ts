/**
 * CONTRACT-V7-READING §4: does Enter send?
 *
 * The rule: a device whose ONLY pointer is coarse (a finger: `(pointer: coarse)`
 * and no `(any-pointer: fine)`) types with an on-screen keyboard, where Enter is
 * the newline key and the send button sends. Anything with a mouse or a
 * trackpad (`any-pointer: fine`: a desktop, a laptop with a touch screen, an
 * iPad with a trackpad keyboard) keeps Enter = send, Shift+Enter = newline.
 * A hardware keyboard on a phone cannot be told apart reliably, so on a touch
 * device Ctrl+Enter / ⌘+Enter also sends.
 */
export interface MediaQueries {
  matchMedia?: (query: string) => { matches: boolean }
}

export function isTouchFirst(win: MediaQueries | undefined = typeof window === 'undefined' ? undefined : window): boolean {
  const match = win?.matchMedia
  if (typeof match !== 'function') return false
  try {
    return match.call(win, '(pointer: coarse)').matches && !match.call(win, '(any-pointer: fine)').matches
  } catch {
    return false
  }
}

export interface EnterKey {
  key: string
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  isComposing: boolean
}

/** Whether this keydown sends the message (else Enter inserts its newline). */
export function enterSends(event: EnterKey, touchFirst: boolean): boolean {
  if (event.key !== 'Enter' || event.isComposing || event.shiftKey || event.altKey) return false
  if (event.ctrlKey || event.metaKey) return true
  return !touchFirst
}

/** Somewhere a focus moved into the composer would interrupt: a dialog, a menu, another field. */
export function focusWouldInterrupt(doc: Document): boolean {
  if (doc.querySelector('[role="dialog"], [aria-modal="true"], [role="menu"]')) return true
  const active = doc.activeElement
  if (!active || active === doc.body) return false
  return active.matches('input, textarea, select, [contenteditable=""], [contenteditable="true"]')
}
