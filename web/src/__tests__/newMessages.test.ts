import { describe, expect, it } from 'vitest'
import { countNewSince, dividerPlace, newCountLabel, newestSentId } from '../lib/newMessages'

const row = (id: number, author = 2, status: 'sent' | 'pending' | 'failed' = 'sent') => ({ id, key: `m${id}`, status, author: { id: author } })

describe('dividerPlace', () => {
  it('goes above the first message after the mark when the mark is held', () => {
    expect(dividerPlace([row(3), row(4), row(5)], 3, true)).toEqual({ kind: 'row', key: 'm4' })
  })
  it('asks for older pages while the mark is older than everything held', () => {
    expect(dividerPlace([row(10), row(11)], 3, true)).toEqual({ kind: 'older' })
  })
  it('the channel start counts as the mark being held', () => {
    expect(dividerPlace([row(10), row(11)], 3, false)).toEqual({ kind: 'row', key: 'm10' })
  })
  it('nothing after the mark: no divider (unsent rows do not count)', () => {
    expect(dividerPlace([row(3), row(-1, 1, 'pending')], 3, true)).toEqual({ kind: 'none' })
  })
})

describe('countNewSince', () => {
  it('counts other people’s confirmed messages after the base', () => {
    const items = [row(1), row(2), row(3, 1), row(4), row(-1, 1, 'pending')]
    expect(countNewSince(items, 1, 1)).toBe(2)
    expect(countNewSince(items, 4, 1)).toBe(0)
    expect(newestSentId(items)).toBe(4)
  })
  it('labels', () => {
    expect(newCountLabel(3)).toBe('3 yeni mesaj')
    expect(newCountLabel(150)).toBe('99+ yeni mesaj')
  })
})
