import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { swallowPressEndClick } from '../lib/pressEnd'

/** The document as the gesture sees it, with a "sheet item" that counts the clicks it gets. */
function page() {
  const doc = new EventTarget()
  let itemClicks = 0
  const click = () => {
    const event = new Event('click', { cancelable: true })
    doc.dispatchEvent(event)
    // Capture listeners on the document run first; a stopped event never reaches the item.
    if (!event.defaultPrevented) itemClicks += 1
  }
  return { doc, click, pointer: (type: string) => doc.dispatchEvent(new Event(type)), clicks: () => itemClicks }
}

describe('swallowPressEndClick', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('the click that ends the long-press never reaches the sheet under the finger', () => {
    const p = page()
    swallowPressEndClick(p.doc)
    p.pointer('pointerup')
    p.click()
    expect(p.clicks()).toBe(0)
    // The next tap on the sheet is the person's.
    p.pointer('pointerdown')
    p.pointer('pointerup')
    p.click()
    expect(p.clicks()).toBe(1)
  })

  it('swallows one click only', () => {
    const p = page()
    swallowPressEndClick(p.doc)
    p.click()
    p.click()
    expect(p.clicks()).toBe(1)
  })

  it('lets a new touch through, and gives up when no click follows the lift', () => {
    const p = page()
    swallowPressEndClick(p.doc)
    p.pointer('pointerdown')
    p.click()
    expect(p.clicks()).toBe(1)

    const q = page()
    swallowPressEndClick(q.doc, 400)
    q.pointer('pointerup')
    vi.advanceTimersByTime(401)
    q.click()
    expect(q.clicks()).toBe(1)
  })

  it('can be stopped by its owner', () => {
    const p = page()
    const stop = swallowPressEndClick(p.doc)
    stop()
    p.click()
    expect(p.clicks()).toBe(1)
  })
})
