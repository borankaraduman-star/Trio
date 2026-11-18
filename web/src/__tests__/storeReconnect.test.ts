/** The store across connection drops: lost echoes (finding 2). */
import { describe, expect, it } from 'vitest'
import { claimEchoes, isEchoOf, RECONCILE_WINDOW_MS } from '../lib/reconcile'
import { channelMessages, createInitialState, reducer, type Action, type AppState, type UiMessage } from '../store'
import type { Attachment, Message, ServerEvent } from '../types'

const ME = { id: 1, name: 'Ada' }
const BORA = { id: 2, name: 'Bora' }
const T0 = Date.parse('2026-11-18T10:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()

const READY: ServerEvent = {
  type: 'ready',
  user: ME,
  users: [
    { ...ME, online: true },
    { ...BORA, online: true },
  ],
  channels: [
    { id: 10, name: 'genel', kind: 'text' },
    { id: 11, name: 'planlar', kind: 'text' },
  ],
  voice: {},
}

const FILE: Attachment = { id: 'a'.repeat(32), filename: 'liste.txt', content_type: 'text/plain', size: 3, url: '/x' }

function stored(id: number, over: Partial<Message> = {}): Message {
  return { id, channel_id: 10, author: BORA, content: `m${id}`, created_at: iso(T0 + id * 1000), attachments: [], ...over }
}

const server = (state: AppState, event: ServerEvent) => reducer(state, { type: 'server', event, now: T0, viewing: true })
const page = (channelId: number, messages: Message[], hasMore = false, mode: 'replace' | 'prepend' = 'replace'): Action => ({
  type: 'messages.loaded',
  channelId,
  messages,
  hasMore,
  mode,
  viewing: true,
})

function local(nonce: string, content: string, over: Partial<UiMessage> = {}): UiMessage {
  return {
    id: -1,
    channel_id: 10,
    author: ME,
    content,
    created_at: iso(T0),
    attachments: [],
    key: nonce,
    nonce,
    status: 'pending',
    ...over,
  }
}

const rows = (state: AppState, channelId = 10) =>
  channelMessages(state, channelId).items.map((item) => `${item.id}:${item.status}:${item.content}`)

function readyWith(channelId: number, ids: number[], hasMore = false): AppState {
  let state = server(createInitialState({ me: ME, activeChannelId: channelId }), READY)
  state = reducer(state, page(channelId, ids.map((id) => stored(id, { channel_id: channelId })), hasMore))
  return state
}

const drop = (state: AppState) => server(reducer(state, { type: 'connection.down' }), READY)

describe('a lost echo (finding 2)', () => {
  it('the reconnect page pairs the stored copy with the failed row: one row, sent, same key', () => {
    let state = readyWith(10, [1, 2])
    state = reducer(state, { type: 'message.optimistic', message: local('n1', 'selam') })
    state = drop(state) // the echo never came: failed
    expect(rows(state)).toEqual(['1:sent:m1', '2:sent:m2', '-1:failed:selam'])

    const mine = stored(3, { author: ME, content: 'selam', created_at: iso(T0 + 400) })
    state = reducer(state, page(10, [stored(1), stored(2), mine]))
    expect(rows(state)).toEqual(['1:sent:m1', '2:sent:m2', '3:sent:selam'])
    const row = channelMessages(state, 10).items[2]
    expect(row).toMatchObject({ key: 'n1', nonce: 'n1' })
  })

  it('pairs a live message.new without a nonce, too', () => {
    let state = readyWith(10, [1])
    state = drop(reducer(state, { type: 'message.optimistic', message: local('n1', 'selam') }))
    state = server(state, { type: 'message.new', message: stored(2, { author: ME, content: 'selam' }) })
    expect(rows(state)).toEqual(['1:sent:m1', '2:sent:selam'])
  })

  it('needs the same content, attachments, author and a send within the window', () => {
    const row = local('n1', 'selam', { attachments: [FILE], status: 'failed' })
    const base = stored(5, { author: ME, content: 'selam', attachments: [FILE], created_at: iso(T0 + 2000) })
    expect(isEchoOf(row, base, ME.id)).toBe(true)
    expect(isEchoOf(row, { ...base, content: 'selam!' }, ME.id)).toBe(false)
    expect(isEchoOf(row, { ...base, attachments: [] }, ME.id)).toBe(false)
    expect(isEchoOf(row, { ...base, author: BORA }, ME.id)).toBe(false)
    expect(isEchoOf(row, { ...base, channel_id: 11 }, ME.id)).toBe(false)
    expect(isEchoOf(row, { ...base, created_at: iso(T0 + RECONCILE_WINDOW_MS + 1) }, ME.id)).toBe(false)
    expect(isEchoOf(row, { ...base, created_at: iso(T0 - RECONCILE_WINDOW_MS) }, ME.id)).toBe(true)
    // A retry long after: within the window of the retry counts.
    const late = iso(T0 + 3_600_000)
    expect(isEchoOf({ ...row, sentAt: T0 + 3_600_000 - 500 }, { ...base, created_at: late }, ME.id)).toBe(true)
    // A nonce on the stored copy decides by itself.
    expect(isEchoOf(row, { ...base, content: 'x', nonce: 'n1' } as Message, ME.id)).toBe(true)
    expect(isEchoOf(row, { ...base, nonce: 'other' } as Message, ME.id)).toBe(false)
  })

  it('two identical unsent rows and one stored copy: only the oldest is paired', () => {
    const items = [local('n1', 'ok', { status: 'failed' }), local('n2', 'ok', { status: 'failed', created_at: iso(T0 + 1000) })]
    const result = claimEchoes(items, [{ ...stored(7, { author: ME, content: 'ok' }), key: 'm7', status: 'sent' }], ME.id)
    expect(result.items.map((item) => item.key)).toEqual(['n2'])
    expect(result.incoming[0]).toMatchObject({ id: 7, key: 'n1', status: 'sent' })
  })

  it('a stored copy already paired is not paired again', () => {
    let state = readyWith(10, [1])
    state = reducer(state, { type: 'message.optimistic', message: local('n1', 'ok') })
    state = server(state, { type: 'message.new', message: stored(2, { author: ME, content: 'ok' }), nonce: 'n1' })
    state = drop(reducer(state, { type: 'message.optimistic', message: local('n2', 'ok') }))
    state = reducer(state, page(10, [stored(1), stored(2, { author: ME, content: 'ok' })]))
    expect(rows(state)).toEqual(['1:sent:m1', '2:sent:ok', '-1:failed:ok'])
  })

  it('a message.new from my other tab (its own nonce) does not take this tab\'s failed row', () => {
    let state = readyWith(10, [1])
    state = drop(reducer(state, { type: 'message.optimistic', message: local('n1', 'ok') }))
    state = server(state, { type: 'message.new', message: stored(2, { author: ME, content: 'ok' }), nonce: 'other-tab' })
    expect(rows(state)).toEqual(['1:sent:m1', '2:sent:ok', '-1:failed:ok'])
  })
})

/**
 * A fake of the server with nonce de-duplication: a repeated `message.send`
 * with the same (user, nonce) is not stored again; the original
 * `message.new` is sent back with the nonce. Without de-duplication it stores
 * a second copy.
 */
function fakeServer(dedup: boolean) {
  let nextId = 100
  const seen = new Map<string, Message>()
  return (send: { content: string; nonce: string; at: number }): ServerEvent => {
    const original = seen.get(send.nonce)
    if (dedup && original) return { type: 'message.new', message: original, nonce: send.nonce }
    const message = stored(nextId++, { author: ME, content: send.content, created_at: iso(send.at) })
    seen.set(send.nonce, message)
    return { type: 'message.new', message, nonce: send.nonce }
  }
}

describe('"Tekrar dene" with the same nonce', () => {
  it('a de-duplicating server echoes the original: one row, sent, with the original id', () => {
    const respond = fakeServer(true)
    let state = readyWith(10, [1])
    state = reducer(state, { type: 'message.optimistic', message: local('n1', 'selam') })
    respond({ content: 'selam', nonce: 'n1', at: T0 }) // stored, but the echo is lost
    state = reducer(state, { type: 'connection.down' }) // failed
    // Reconnected before the page came; the person retries with the SAME nonce.
    state = server(state, READY)
    state = reducer(state, { type: 'message.retry', channelId: 10, nonce: 'n1', at: T0 + 60_000 })
    expect(rows(state)).toEqual(['1:sent:m1', '-1:pending:selam'])
    state = server(state, respond({ content: 'selam', nonce: 'n1', at: T0 + 60_000 }))
    expect(rows(state)).toEqual(['1:sent:m1', '100:sent:selam'])
    // And the catch-up page that follows holds the same message once.
    state = reducer(state, page(10, [stored(1), stored(100, { author: ME, content: 'selam' })]))
    expect(rows(state)).toEqual(['1:sent:m1', '100:sent:selam'])
    expect(channelMessages(state, 10).items[1].key).toBe('n1')
  })

  it('if the page arrived first, the row is already sent and needs no retry', () => {
    const respond = fakeServer(true)
    let state = readyWith(10, [1])
    state = reducer(state, { type: 'message.optimistic', message: local('n1', 'selam') })
    const echo = respond({ content: 'selam', nonce: 'n1', at: T0 + 300 })
    state = drop(state)
    state = reducer(state, page(10, [stored(1), (echo as { message: Message }).message]))
    expect(rows(state)).toEqual(['1:sent:m1', '100:sent:selam'])
    // A late duplicate echo (another tab retried, say) changes nothing.
    state = server(state, echo)
    expect(rows(state)).toEqual(['1:sent:m1', '100:sent:selam'])
  })

  it('a server without de-duplication stores the retry again; the client shows what the server holds', () => {
    const respond = fakeServer(false)
    let state = readyWith(10, [1])
    state = reducer(state, { type: 'message.optimistic', message: local('n1', 'selam') })
    respond({ content: 'selam', nonce: 'n1', at: T0 })
    state = server(reducer(state, { type: 'connection.down' }), READY)
    state = reducer(state, { type: 'message.retry', channelId: 10, nonce: 'n1', at: T0 + 1000 })
    state = server(state, respond({ content: 'selam', nonce: 'n1', at: T0 + 1000 }))
    expect(rows(state)).toEqual(['1:sent:m1', '101:sent:selam'])
    state = reducer(state, page(10, [stored(1), stored(100, { author: ME, content: 'selam' }), stored(101, { author: ME, content: 'selam' })]))
    expect(rows(state)).toEqual(['1:sent:m1', '100:sent:selam', '101:sent:selam'])
  })

  it('retry keeps the nonce and records when it was sent', () => {
    let state = readyWith(10, [1])
    state = drop(reducer(state, { type: 'message.optimistic', message: local('n1', 'selam') }))
    state = reducer(state, { type: 'message.retry', channelId: 10, nonce: 'n1', at: T0 + 5 })
    expect(channelMessages(state, 10).items[1]).toMatchObject({ nonce: 'n1', key: 'n1', status: 'pending', sentAt: T0 + 5 })
  })
})
