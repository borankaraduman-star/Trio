import { describe, expect, it } from 'vitest'
import { messageFamilyBusy, reloadBlocker, type ReloadState } from '../lib/reloadGuard'

const idle: ReloadState = {
  inCall: false,
  dialogOpen: false,
  pendingFiles: false,
  draft: false,
  unsentMessages: false,
  profileEdit: false,
  messageAction: false,
  ringing: false,
  connectionTest: false,
}

describe('reloadBlocker', () => {
  it('allows the reload when nothing would be lost', () => {
    expect(reloadBlocker(idle)).toBeNull()
  })

  it.each(Object.keys(idle) as (keyof ReloadState)[])('holds the reload while %s', (key) => {
    expect(reloadBlocker({ ...idle, [key]: true })).toBe(key)
  })
})

describe('reloadBlocker and the V4 voice extras', () => {
  it('waits while a ring band is showing or the connection test runs, after what loses more', () => {
    expect(reloadBlocker({ ...idle, ringing: true })).toBe('ringing')
    expect(reloadBlocker({ ...idle, connectionTest: true })).toBe('connectionTest')
    expect(reloadBlocker({ ...idle, inCall: true, ringing: true })).toBe('inCall')
  })
})

describe('messageFamilyBusy', () => {
  const none = { editing: null, reply: null, pinsOpen: false, overlayOpen: false }

  it('is quiet when nothing is open', () => {
    expect(messageFamilyBusy(none)).toBe(false)
    expect(reloadBlocker({ ...idle, messageAction: messageFamilyBusy(none) })).toBeNull()
  })

  it.each([
    ['an edit in place', { editing: { channelId: 1, messageId: 7 } }],
    ['a reply being composed', { reply: { id: 7 } }],
    ['the pins panel', { pinsOpen: true }],
    ['the emoji picker, the action sheet or the delete confirmation', { overlayOpen: true }],
  ])('holds the reload during %s', (_, open) => {
    const busy = messageFamilyBusy({ ...none, ...open })
    expect(busy).toBe(true)
    expect(reloadBlocker({ ...idle, messageAction: busy })).toBe('messageAction')
  })
})

describe('reloadBlocker with both families', () => {
  it('a message action is named before a ring or the connection test, after a call or a draft', () => {
    expect(reloadBlocker({ ...idle, messageAction: true, ringing: true })).toBe('messageAction')
    expect(reloadBlocker({ ...idle, messageAction: true, connectionTest: true })).toBe('messageAction')
    expect(reloadBlocker({ ...idle, inCall: true, messageAction: true })).toBe('inCall')
    expect(reloadBlocker({ ...idle, draft: true, messageAction: true })).toBe('draft')
  })
})
