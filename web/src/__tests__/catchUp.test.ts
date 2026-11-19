import { describe, expect, it } from 'vitest'
import { fetchCovering, newestConfirmedId, type Page } from '../lib/catchUp'
import type { Message } from '../types'

const msg = (id: number): Message => ({
  id,
  channel_id: 1,
  author: { id: 2, name: 'b' },
  content: `m${id}`,
  created_at: '2026-11-18T10:00:00Z',
})

/** A channel holding messages 1..total, served like the API: newest `limit` before `before`, oldest first. */
function server(total: number, limit = 50) {
  const calls: (number | undefined)[] = []
  const fetchPage = async (before?: number): Promise<Page> => {
    calls.push(before)
    const top = (before ?? total + 1) - 1
    const from = Math.max(1, top - limit + 1)
    const messages = []
    for (let id = from; id <= top; id += 1) messages.push(msg(id))
    return { messages, has_more: from > 1 }
  }
  return { fetchPage, calls }
}

const ids = (messages: Message[]) => messages.map((m) => m.id)

describe('fetchCovering', () => {
  it('one page when nothing is held', async () => {
    const s = server(300)
    const result = await fetchCovering(s.fetchPage, null)
    expect(ids(result.messages)).toEqual(Array.from({ length: 50 }, (_, i) => 251 + i))
    expect(result).toMatchObject({ hasMore: true, covers: true })
    expect(s.calls).toEqual([undefined])
  })

  it('one page when the newest page already meets what is held', async () => {
    const s = server(303)
    const result = await fetchCovering(s.fetchPage, 300)
    expect(result.messages[0].id).toBe(254)
    expect(result.covers).toBe(true)
    expect(s.calls).toHaveLength(1)
  })

  it('walks back page by page to meet the held messages after a long absence', async () => {
    const s = server(300)
    const result = await fetchCovering(s.fetchPage, 120)
    expect(s.calls).toEqual([undefined, 251, 201, 151])
    expect(result.messages[0].id).toBe(101)
    expect(result.messages[result.messages.length - 1].id).toBe(300)
    expect(ids(result.messages)).toEqual([...ids(result.messages)].sort((a, b) => a - b))
    expect(result).toMatchObject({ hasMore: true, covers: true })
  })

  it('reports a gap when more than the page budget was missed', async () => {
    const s = server(1000)
    const result = await fetchCovering(s.fetchPage, 10, 3)
    expect(s.calls).toHaveLength(3)
    expect(result.messages[0].id).toBe(851)
    expect(result.covers).toBe(false)
  })

  it('an empty channel, or one that ends before the held id, covers', async () => {
    expect((await fetchCovering(server(0).fetchPage, 5)).covers).toBe(true)
  })
})

describe('newestConfirmedId', () => {
  it('skips the unconfirmed tail', () => {
    expect(
      newestConfirmedId([
        { id: 3, status: 'sent' },
        { id: 7, status: 'sent' },
        { id: -1, status: 'failed' },
      ]),
    ).toBe(7)
    expect(newestConfirmedId([{ id: -1, status: 'pending' }])).toBeNull()
  })
})
