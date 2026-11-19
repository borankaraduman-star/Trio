import { describe, expect, it } from 'vitest'
import { pageTitle } from '../lib/title'
import { versionLine } from '../lib/version'

// desktop/src/shared/title.ts, copied: the web package cannot import the desktop one
// (the web image is built without it). Keep the two in step.
const UNREAD_PREFIX = /^\s*\((\d{1,6})\)/
function parseUnread(title: string): number {
  const match = UNREAD_PREFIX.exec(title)
  const n = match ? Number.parseInt(match[1] ?? '0', 10) : 0
  return Number.isFinite(n) && n > 0 ? n : 0
}

describe('the page title', () => {
  it('is the server name, with the unread count in front', () => {
    expect(pageTitle(0, 'Trio')).toBe('Trio')
    expect(pageTitle(3, 'Trio')).toBe('(3) Trio')
    expect(pageTitle(12, 'Bizim Ev')).toBe('(12) Bizim Ev')
    expect(pageTitle(0, '   ')).toBe('Trio')
  })

  it('is read by the desktop shell as the count, and only the count', () => {
    expect(parseUnread(pageTitle(3, 'Bizim Ev'))).toBe(3)
    expect(parseUnread(pageTitle(0, 'Bizim Ev'))).toBe(0)
    // A server whose name looks like a count does not light the badge.
    expect(parseUnread(pageTitle(0, '(5) kişi'))).toBe(0)
    expect(parseUnread(pageTitle(2, '(5) kişi'))).toBe(2)
  })
})

describe('the versions line', () => {
  it('names the client, its build and the server', () => {
    expect(versionLine('0.3.0', '202611190135', '0.2.0')).toBe('Trio 0.3.0 (202611190135) · sunucu 0.2.0')
    expect(versionLine('0.3.0', 'abc1234', null)).toBe('Trio 0.3.0 (abc1234)')
  })
})
