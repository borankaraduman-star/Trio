import { describe, expect, it } from 'vitest'
import { enterSends, isTouchFirst } from '../lib/touchInput'

const media = (coarse: boolean, fine: boolean) => ({
  matchMedia: (query: string) => ({ matches: query === '(pointer: coarse)' ? coarse : query === '(any-pointer: fine)' ? fine : false }),
})
const key = (extra: Partial<Parameters<typeof enterSends>[0]> = {}) => ({
  key: 'Enter',
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  isComposing: false,
  ...extra,
})

describe('isTouchFirst', () => {
  it('only a coarse pointer and no fine one anywhere', () => {
    expect(isTouchFirst(media(true, false))).toBe(true)
    expect(isTouchFirst(media(true, true))).toBe(false) // a touch laptop, an iPad with a trackpad
    expect(isTouchFirst(media(false, true))).toBe(false)
    expect(isTouchFirst({})).toBe(false)
    expect(isTouchFirst(undefined)).toBe(false)
  })
})

describe('enterSends', () => {
  it('desktop: Enter sends, Shift+Enter and an IME confirmation do not', () => {
    expect(enterSends(key(), false)).toBe(true)
    expect(enterSends(key({ shiftKey: true }), false)).toBe(false)
    expect(enterSends(key({ isComposing: true }), false)).toBe(false)
    expect(enterSends(key({ key: 'a' }), false)).toBe(false)
  })
  it('touch: Enter is a newline, Ctrl/⌘+Enter sends', () => {
    expect(enterSends(key(), true)).toBe(false)
    expect(enterSends(key({ ctrlKey: true }), true)).toBe(true)
    expect(enterSends(key({ metaKey: true }), true)).toBe(true)
  })
})
