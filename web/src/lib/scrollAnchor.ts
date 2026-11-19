/**
 * Keeping the row being read in place while the list changes around it
 * (an older page above, a merge after a reconnect, rows added below).
 *
 * The anchor is the first message row whose bottom is below the top of the
 * scroller, and how far its top is from the scroller's top. After a change the
 * scroller is moved by exactly what that row moved. Rows carry `data-key`.
 */
export interface Anchor {
  key: string
  /** Row top minus scroller top, in px (negative when the row starts above the view). */
  offset: number
}

interface Box {
  getBoundingClientRect(): { top: number; bottom: number }
}
interface Row extends Box {
  dataset: { key?: string }
}
export interface Scroller extends Box {
  scrollTop: number
  querySelectorAll(selector: string): ArrayLike<Row>
}

const ROWS = '[data-key]'

export function captureAnchor(scroller: Scroller): Anchor | null {
  const top = scroller.getBoundingClientRect().top
  const rows = scroller.querySelectorAll(ROWS)
  // Rows are in document order, so their tops ascend: binary search.
  let low = 0
  let high = rows.length - 1
  let found = -1
  while (low <= high) {
    const middle = (low + high) >> 1
    if (rows[middle].getBoundingClientRect().bottom > top) {
      found = middle
      high = middle - 1
    } else {
      low = middle + 1
    }
  }
  if (found < 0) return null
  const row = rows[found]
  const key = row.dataset.key
  return key === undefined ? null : { key, offset: row.getBoundingClientRect().top - top }
}

/** Moves the scroller so the anchor row is where it was. False when the row is gone. */
export function restoreAnchor(scroller: Scroller, anchor: Anchor): boolean {
  const rows = scroller.querySelectorAll(ROWS)
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    if (row.dataset.key !== anchor.key) continue
    const delta = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.offset
    if (delta !== 0) scroller.scrollTop += delta
    return true
  }
  return false
}
