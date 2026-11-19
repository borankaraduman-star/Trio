import { describe, expect, it } from 'vitest'
import { reloadBlocker, type ReloadState } from '../lib/reloadGuard'

const idle: ReloadState = {
  inCall: false,
  dialogOpen: false,
  pendingFiles: false,
  draft: false,
  unsentMessages: false,
  profileEdit: false,
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
