import { describe, expect, it } from 'vitest'
import { createInitialState, reducer, type Action, type AppState, type UiMessage } from '../store'
import type { Message, ServerEvent } from '../types'
import { lastEditable, sortPins, updatePins } from '../lib/messageFamily'

const ME = { id: 1, name: 'Ada' }
const BORA = { id: 2, name: 'Bora' }

const READY: ServerEvent = {
  type: 'ready',
  user: ME,
  users: [
    { ...ME, online: true },
    { ...BORA, online: true },
  ],
  channels: [
    { id: 10, name: 'genel', kind: 'text' },
    { id: 11, name: 'oyun', kind: 'text' },
  ],
  voice: {},
}

function msg(id: number, extra: Partial<Message> = {}): Message {
  return {
    id,
    channel_id: 10,
    author: BORA,
    content: `m${id}`,
    created_at: `2026-11-18T10:00:${String(id % 60).padStart(2, '0')}Z`,
    attachments: [],
    edited_at: null,
    reply_to: null,
    reactions: [],
    pinned_at: null,
    pinned_by: null,
    rev: 0,
    ...extra,
  }
}

function server(state: AppState, event: ServerEvent): AppState {
  return reducer(state, { type: 'server', event, now: 1000, viewing: true })
}

function run(state: AppState, ...actions: Action[]): AppState {
  return actions.reduce(reducer, state)
}

function start(messages: Message[]): AppState {
  const ready = server(createInitialState({ me: ME, activeChannelId: 10 }), READY)
  return reducer(ready, { type: 'messages.loaded', channelId: 10, messages, hasMore: false, mode: 'replace', viewing: true })
}

function items(state: AppState, channelId = 10): UiMessage[] {
  return state.messages[channelId]?.items ?? []
}

function byId(state: AppState, id: number): UiMessage | undefined {
  return items(state).find((item) => item.id === id)
}

describe('message.updated and rev', () => {
  it('replaces the held copy and keeps its key', () => {
    const state = server(start([msg(1), msg(2)]), { type: 'message.updated', message: msg(2, { content: 'yeni', rev: 1, edited_at: 'x' }) })
    expect(byId(state, 2)?.content).toBe('yeni')
    expect(byId(state, 2)?.key).toBe('m2')
  })

  it('keeps the highest rev whichever arrives first (REST answer and broadcast)', () => {
    const base = start([msg(1)])
    const newer = msg(1, { rev: 2, reactions: [{ key: '👍', count: 1, user_ids: [1] }] })
    const older = msg(1, { rev: 1, content: 'eski' })
    for (const order of [
      [newer, older],
      [older, newer],
    ]) {
      const state = order.reduce((s, m) => server(s, { type: 'message.updated', message: m }), base)
      expect(byId(state, 1)?.rev).toBe(2)
      expect(byId(state, 1)?.reactions).toEqual(newer.reactions)
    }
  })

  it('a page older than what a broadcast brought does not roll it back', () => {
    let state = start([msg(1), msg(2)])
    state = server(state, { type: 'message.updated', message: msg(2, { rev: 3, content: 'son' }) })
    for (const mode of ['replace', 'prepend'] as const) {
      const next = reducer(state, { type: 'messages.loaded', channelId: 10, messages: [msg(1), msg(2, { rev: 1 })], hasMore: false, mode, viewing: true })
      expect(byId(next, 2)?.content).toBe('son')
    }
  })

  it('an unchanged row keeps its identity (memoised rows do not re-render)', () => {
    const before = start([msg(1), msg(2)])
    const after = server(before, { type: 'message.updated', message: msg(2, { rev: 1, reactions: [{ key: '🎉', count: 1, user_ids: [2] }] }) })
    expect(byId(after, 1)).toBe(byId(before, 1))
    expect(byId(after, 2)).not.toBe(byId(before, 2))
  })

  it('ignores an update for a message it does not hold', () => {
    const state = start([msg(1)])
    expect(server(state, { type: 'message.updated', message: msg(99, { rev: 1 }) })).toBe(state)
  })

  it('a retried nonce answering with a newer copy updates the held one', () => {
    const state = server(start([msg(1)]), { type: 'message.new', message: msg(1, { rev: 4, content: 'düzenli' }), nonce: 'n' })
    expect(byId(state, 1)?.content).toBe('düzenli')
  })
})

describe('message.deleted', () => {
  it('removes it from the cache and from pins, and turns quotes into "deleted"', () => {
    let state = start([msg(1, { pinned_at: '2026-11-18T11:00:00Z', pinned_by: 2 }), msg(2, { reply_to: { id: 1, author: BORA, excerpt: 'm1' } })])
    state = reducer(state, { type: 'pins.loaded', channelId: 10, messages: [msg(1, { pinned_at: '2026-11-18T11:00:00Z', pinned_by: 2 })] })
    state = server(state, { type: 'message.deleted', channel_id: 10, message_id: 1 })
    expect(byId(state, 1)).toBeUndefined()
    expect(byId(state, 2)?.reply_to).toEqual({ id: 1, deleted: true })
    expect(state.pins[10].items).toEqual([])
    expect(state.deleted[1]).toBe(true)
  })

  it('a late page or frame cannot bring a deleted message back', () => {
    let state = start([msg(1), msg(2)])
    state = server(state, { type: 'message.deleted', channel_id: 10, message_id: 2 })
    state = reducer(state, { type: 'messages.loaded', channelId: 10, messages: [msg(1), msg(2)], hasMore: false, mode: 'replace', viewing: true })
    expect(byId(state, 2)).toBeUndefined()
    state = server(state, { type: 'message.new', message: msg(2) })
    expect(byId(state, 2)).toBeUndefined()
    state = server(state, { type: 'message.updated', message: msg(2, { rev: 5 }) })
    expect(byId(state, 2)).toBeUndefined()
  })

  it('with a nonce (a retried send deleted meanwhile) the unconfirmed row goes too', () => {
    let state = start([msg(1)])
    state = reducer(state, {
      type: 'message.optimistic',
      message: { ...msg(-1, { author: ME }), key: 'n1', nonce: 'n1', status: 'failed' },
    })
    state = server(state, { type: 'message.deleted', channel_id: 10, message_id: 7, nonce: 'n1' })
    expect(items(state).map((item) => item.key)).toEqual(['m1'])
  })

  it('a quote of a message not held stays the server snapshot until the target is deleted', () => {
    let state = start([msg(5, { reply_to: { id: 3, author: BORA, excerpt: 'eski metin' } })])
    expect(byId(state, 5)?.reply_to).toEqual({ id: 3, author: BORA, excerpt: 'eski metin' })
    state = server(state, { type: 'message.deleted', channel_id: 10, message_id: 3 })
    expect(byId(state, 5)?.reply_to).toEqual({ id: 3, deleted: true })
  })

  it('a page whose quote says deleted marks the target deleted everywhere', () => {
    let state = start([msg(1), msg(2, { reply_to: { id: 1, author: BORA, excerpt: 'm1' } })])
    state = reducer(state, {
      type: 'messages.loaded',
      channelId: 10,
      messages: [msg(2, { reply_to: { id: 1, author: BORA, excerpt: 'm1' } }), msg(3, { reply_to: { id: 1, deleted: true } })],
      hasMore: true,
      mode: 'replace',
      viewing: true,
    })
    expect(state.deleted[1]).toBe(true)
    expect(byId(state, 1)).toBeUndefined()
    expect(byId(state, 2)?.reply_to).toEqual({ id: 1, deleted: true })
  })
})

describe('reply quotes follow their target', () => {
  it('an edit of the target updates the quote of a held reply', () => {
    let state = start([msg(1), msg(2, { reply_to: { id: 1, author: BORA, excerpt: 'm1' } })])
    state = server(state, { type: 'message.updated', message: msg(1, { rev: 1, content: 'düzeltildi' }) })
    expect(byId(state, 2)?.reply_to).toEqual({ id: 1, author: { id: 2, name: 'Bora' }, excerpt: 'düzeltildi' })
  })

  it('an attachment-only target quotes its first file', () => {
    let state = start([msg(1), msg(2, { reply_to: { id: 1, author: BORA, excerpt: 'm1' } })])
    const file = { id: 'a', filename: 'plan.pdf', content_type: 'application/pdf', size: 1, url: '/api/files/a/plan.pdf' }
    state = server(state, { type: 'message.updated', message: msg(1, { rev: 1, content: '', attachments: [file] }) })
    expect(byId(state, 2)?.reply_to).toMatchObject({ excerpt: '📎 plan.pdf' })
  })

  it('a reply that arrives live is quoted from the held target', () => {
    let state = start([msg(1, { content: 'güncel' })])
    state = server(state, { type: 'message.new', message: msg(2, { reply_to: { id: 1, author: BORA, excerpt: 'eski' } }) })
    expect(byId(state, 2)?.reply_to).toMatchObject({ excerpt: 'güncel' })
  })
})

describe('optimistic edits', () => {
  it('shows the edit at once and rolls back when settled without an answer', () => {
    let state = start([msg(1, { author: ME })])
    state = run(state, { type: 'message.edit-local', channelId: 10, messageId: 1, content: 'yeni' })
    expect(byId(state, 1)?.pendingEdit).toBe('yeni')
    // A reaction arriving meanwhile keeps the edit on screen.
    state = server(state, { type: 'message.updated', message: msg(1, { author: ME, rev: 1, reactions: [{ key: '👍', count: 1, user_ids: [2] }] }) })
    expect(byId(state, 1)?.pendingEdit).toBe('yeni')
    state = run(state, { type: 'message.edit-settled', channelId: 10, messageId: 1 })
    expect(byId(state, 1)?.pendingEdit).toBeUndefined()
    expect(byId(state, 1)?.content).toBe('m1')
  })
})

describe('messages.refresh (after a reconnect)', () => {
  it('updates and drops held messages in its range and adds nothing', () => {
    let state = start([msg(1), msg(2), msg(3), msg(4)])
    state = reducer(state, {
      type: 'messages.refresh',
      channelId: 10,
      messages: [msg(2, { rev: 1, content: 'değişti' }), msg(3), msg(9)],
      before: 4,
      hasMore: true,
    })
    expect(items(state).map((item) => item.id)).toEqual([1, 2, 3, 4])
    expect(byId(state, 2)?.content).toBe('değişti')
    state = reducer(state, { type: 'messages.refresh', channelId: 10, messages: [msg(3)], before: 4, hasMore: false })
    expect(items(state).map((item) => item.id)).toEqual([3, 4])
  })
})

describe('pins', () => {
  const pin = (id: number, at: string, rev = 1) => msg(id, { pinned_at: at, pinned_by: 1, rev })

  it('newest pin first; a pin, an unpin and an older copy', () => {
    let state = start([msg(1), msg(2)])
    state = reducer(state, { type: 'pins.loaded', channelId: 10, messages: [pin(1, '2026-11-18T10:00:00Z')] })
    state = server(state, { type: 'message.updated', message: pin(2, '2026-11-18T12:00:00Z') })
    expect(state.pins[10].items.map((m) => m.id)).toEqual([2, 1])
    state = server(state, { type: 'message.updated', message: msg(1, { rev: 2 }) })
    expect(state.pins[10].items.map((m) => m.id)).toEqual([2])
    expect(updatePins([pin(2, 'b', 3)], msg(2, { rev: 1 })).map((m) => m.id)).toEqual([2])
    expect(sortPins([pin(1, 'a'), msg(3), pin(2, 'b')]).map((m) => m.id)).toEqual([2, 1])
  })

  it('a reconnect drops the pins (they are re-read)', () => {
    let state = reducer(start([]), { type: 'pins.loaded', channelId: 10, messages: [pin(1, 'a')] })
    state = server(state, READY)
    expect(state.pins).toEqual({})
  })
})

describe('lastEditable', () => {
  it('my newest confirmed message', () => {
    const rows = [
      { id: 1, status: 'sent', author: ME },
      { id: 2, status: 'sent', author: BORA },
      { id: -1, status: 'pending', author: ME },
    ]
    expect(lastEditable(rows, 1)?.id).toBe(1)
    expect(lastEditable(rows, 3)).toBeNull()
  })
})
