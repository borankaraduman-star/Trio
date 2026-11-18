import { describe, expect, it } from 'vitest'
import { buildRows, dayKey, dayLabel, typingLabel, GROUP_WINDOW_MS } from '../lib/grouping'

let counter = 0
/** Built from LOCAL date parts, so the tests hold in any time zone. */
function at(authorId: number, y: number, mo: number, d: number, h: number, mi: number, s = 0) {
  counter += 1
  return {
    key: `k${counter}`,
    author: { id: authorId },
    created_at: new Date(y, mo - 1, d, h, mi, s).toISOString(),
  }
}

const shape = (rows: ReturnType<typeof buildRows>) =>
  rows.map((row) => (row.type === 'day' ? 'day' : row.showHeader ? 'head' : 'cont'))

describe('buildRows', () => {
  it('returns nothing for no messages', () => {
    expect(buildRows([])).toEqual([])
  })

  it('starts with a day separator and a header', () => {
    expect(shape(buildRows([at(1, 2026, 11, 18, 10, 0)]))).toEqual(['day', 'head'])
  })

  it('groups consecutive messages by one author inside the window', () => {
    const rows = buildRows([
      at(1, 2026, 11, 18, 10, 0),
      at(1, 2026, 11, 18, 10, 1),
      at(1, 2026, 11, 18, 10, 4, 59),
    ])
    expect(shape(rows)).toEqual(['day', 'head', 'cont', 'cont'])
  })

  it('measures the window from the previous message, and breaks at exactly the window', () => {
    const first = at(1, 2026, 11, 18, 10, 0)
    const edge = {
      key: 'edge',
      author: { id: 1 },
      created_at: new Date(new Date(first.created_at).getTime() + GROUP_WINDOW_MS).toISOString(),
    }
    expect(shape(buildRows([first, edge]))).toEqual(['day', 'head', 'head'])
    const chain = buildRows([
      at(1, 2026, 11, 18, 10, 0),
      at(1, 2026, 11, 18, 10, 4),
      at(1, 2026, 11, 18, 10, 8),
    ])
    expect(shape(chain)).toEqual(['day', 'head', 'cont', 'cont'])
  })

  it('starts a new group when the author changes', () => {
    const rows = buildRows([
      at(1, 2026, 11, 18, 10, 0),
      at(2, 2026, 11, 18, 10, 0, 30),
      at(1, 2026, 11, 18, 10, 1),
    ])
    expect(shape(rows)).toEqual(['day', 'head', 'head', 'head'])
  })

  it('separates days and restarts the group across midnight', () => {
    const rows = buildRows([
      at(1, 2026, 11, 18, 23, 59),
      at(1, 2026, 11, 19, 0, 1),
      at(1, 2026, 11, 19, 0, 2),
    ])
    expect(shape(rows)).toEqual(['day', 'head', 'day', 'head', 'cont'])
    const days = rows.flatMap((row) => (row.type === 'day' ? [row.key] : []))
    expect(days).toEqual(['day-2026-11-18', 'day-2026-11-19'])
  })

  it('gives every row a unique key and keeps the message order', () => {
    const messages = [at(1, 2026, 11, 17, 9, 0), at(2, 2026, 11, 18, 9, 0), at(2, 2026, 11, 18, 9, 1)]
    const rows = buildRows(messages)
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length)
    expect(rows.flatMap((row) => (row.type === 'message' ? [row.message] : []))).toEqual(messages)
  })

  it('survives a bad timestamp without a separator of its own', () => {
    const rows = buildRows([
      at(1, 2026, 11, 18, 10, 0),
      { key: 'bad', author: { id: 1 }, created_at: 'not a date' },
    ])
    expect(shape(rows)).toEqual(['day', 'head', 'head'])
  })
})

describe('labels', () => {
  const now = new Date(2026, 10, 18, 12, 0)

  it('names today and yesterday', () => {
    expect(dayLabel(new Date(2026, 10, 18, 0, 1), now)).toBe('Bugün')
    expect(dayLabel(new Date(2026, 10, 17, 23, 59), now)).toBe('Dün')
  })

  it('writes any other day out with its year', () => {
    const label = dayLabel(new Date(2026, 10, 3, 8, 0), now)
    expect(label).toContain('3')
    expect(label).toContain('2026')
  })

  it('yesterday works across a month boundary', () => {
    expect(dayLabel(new Date(2026, 9, 31, 10, 0), new Date(2026, 10, 1, 10, 0))).toBe('Dün')
  })

  it('pads the day key', () => {
    expect(dayKey(new Date(2026, 0, 5))).toBe('2026-01-05')
  })

  it('words the typing line', () => {
    expect(typingLabel([])).toBe('')
    expect(typingLabel(['Bora'])).toBe('Bora yazıyor…')
    expect(typingLabel(['Bora', 'Cem'])).toBe('Bora ve Cem yazıyor…')
    expect(typingLabel(['Bora', 'Cem', 'Ada'])).toBe('Birkaç kişi yazıyor…')
  })
})
