import { describe, expect, it } from 'vitest'
import { captureAnchor, restoreAnchor, type Scroller } from '../lib/scrollAnchor'

/** A scroller of fixed-height rows laid out top to bottom; the view is at y = 100. */
function fakeList(keys: string[], scrollTop: number, rowHeight = 40) {
  const viewTop = 100
  const list: Scroller & { keys: string[] } = {
    keys,
    scrollTop,
    getBoundingClientRect: () => ({ top: viewTop, bottom: viewTop + 400 }),
    querySelectorAll: () =>
      list.keys.map((key, index) => {
        const top = viewTop + index * rowHeight - list.scrollTop
        return { dataset: { key }, getBoundingClientRect: () => ({ top, bottom: top + rowHeight }) }
      }),
  }
  return list
}

const keys = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `m${from + i}`)

describe('scroll anchor', () => {
  it('picks the first row still visible at the top, with its offset', () => {
    const list = fakeList(keys(1, 300), 4010) // row 100 starts at 3960 and ends at 4000; row 101 at 4000
    expect(captureAnchor(list)).toEqual({ key: 'm101', offset: -10 })
  })

  it('an older page above: the row being read does not move', () => {
    const list = fakeList(keys(51, 300), 2000)
    const anchor = captureAnchor(list)!
    list.keys = keys(1, 300)
    expect(restoreAnchor(list, anchor)).toBe(true)
    expect(list.scrollTop).toBe(4000)
    expect(captureAnchor(list)).toEqual(anchor)
  })

  it('rows added below (a merge after a reconnect) change nothing', () => {
    const list = fakeList(keys(1, 300), 3990)
    const anchor = captureAnchor(list)!
    list.keys = keys(1, 303)
    restoreAnchor(list, anchor)
    expect(list.scrollTop).toBe(3990)
  })

  it('an empty list has no anchor; a vanished row is reported', () => {
    expect(captureAnchor(fakeList([], 0))).toBeNull()
    const list = fakeList(keys(1, 10), 0)
    const anchor = captureAnchor(list)!
    list.keys = keys(20, 30)
    expect(restoreAnchor(list, anchor)).toBe(false)
    expect(list.scrollTop).toBe(0)
  })
})
