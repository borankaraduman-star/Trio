import { describe, expect, it } from 'vitest'
import { reloadBlocker, type ReloadState } from '../lib/reloadGuard'

const idle: ReloadState = {
  inCall: false,
  dialogOpen: false,
  pendingFiles: false,
  draft: false,
  unsentMessages: false,
  profileEdit: false,
}

describe('reloadBlocker', () => {
  it('allows the reload when nothing would be lost', () => {
    expect(reloadBlocker(idle)).toBeNull()
  })

  it.each(Object.keys(idle) as (keyof ReloadState)[])('holds the reload while %s', (key) => {
    expect(reloadBlocker({ ...idle, [key]: true })).toBe(key)
  })
})
