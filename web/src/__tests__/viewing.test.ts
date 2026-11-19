import { describe, expect, it } from 'vitest'
import { isViewing } from '../lib/viewing'

const doc = (visibilityState: DocumentVisibilityState, focused: boolean) => ({
  visibilityState,
  hasFocus: () => focused,
})

describe('isViewing', () => {
  it('is true only for a visible and focused page', () => {
    expect(isViewing(doc('visible', true))).toBe(true)
  })

  it('a visible window without focus (behind another window, the desktop app in the tray) is not viewing', () => {
    expect(isViewing(doc('visible', false))).toBe(false)
  })

  it('a hidden page is not viewing, focused or not', () => {
    expect(isViewing(doc('hidden', true))).toBe(false)
    expect(isViewing(doc('hidden', false))).toBe(false)
  })
})
