/**
 * The page title (CONTRACT-V4 C): the server's name, with the unread count in
 * front as "(n) " — the desktop shell reads the badge from exactly that prefix
 * (desktop/src/shared/title.ts: /^\s*\((\d{1,6})\)/).
 */
const LOOKS_LIKE_COUNT = /^\s*\(\d/

export function pageTitle(unread: number, serverName: string): string {
  const name = serverName.trim() === '' ? 'Trio' : serverName
  if (unread > 0) return `(${unread}) ${name}`
  // A server called "(3) ..." must not read as three unread messages: a
  // zero-width space in front keeps the regex from matching and shows nothing.
  return LOOKS_LIKE_COUNT.test(name) ? `​${name}` : name
}
