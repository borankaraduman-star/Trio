import { describe, expect, it } from 'vitest'
import {
  channelMessages,
  createInitialState,
  reducer,
  totalUnread,
  typingNames,
  TYPING_TTL_MS,
  type Action,
  type AppState,
  type UiMessage,
} from '../store'
import type { Message, ServerEvent } from '../types'

const ME = { id: 1, name: 'Ada' }
const BORA = { id: 2, name: 'Bora' }

const READY: ServerEvent = {
  type: 'ready',
  user: ME,
  users: [
    { ...ME, online: true },
    { ...BORA, online: false },
  ],
  channels: [
    { id: 10, name: 'genel', kind: 'text' },
    { id: 11, name: 'oyun', kind: 'text' },
    { id: 20, name: 'Sohbet', kind: 'voice' },
  ],
  voice: { '20': [{ user_id: 2, muted: true, deafened: false, screensharing: false }] },
}

function server(state: AppState, event: ServerEvent, viewing = true, now = 1000): AppState {
  return reducer(state, { type: 'server', event, now, viewing })
}

function run(state: AppState, ...actions: Action[]): AppState {
  return actions.reduce(reducer, state)
}

function message(id: number, channelId = 10, author = BORA, content = `m${id}`): Message {
  return {
    id,
    channel_id: channelId,
    author,
    content,
    created_at: `2026-11-18T10:00:${String(id % 60).padStart(2, '0')}Z`,
  }
}

function loaded(state: AppState, channelId: number, ids: number[], hasMore = false): AppState {
  return reducer(state, {
    type: 'messages.loaded',
    channelId,
    messages: ids.map((id) => message(id, channelId)),
    hasMore,
    mode: 'replace',
    viewing: true,
  })
}

function optimistic(nonce: string, channelId = 10): UiMessage {
  return { ...message(-1, channelId, ME, 'selam'), key: nonce, nonce, status: 'pending' }
}

const fresh = () => createInitialState({ me: ME })
const ready = () => server(fresh(), READY)
const ids = (state: AppState, channelId = 10) =>
  channelMessages(state, channelId).items.map((item) => item.id)

describe('ready', () => {
  it('fills users, channels and voice, and opens the first text channel', () => {
    const state = ready()
    expect(state.ready).toBe(true)
    expect(state.connection).toBe('open')
    expect(state.users[2]).toEqual({ ...BORA, online: false })
    expect(state.channels).toHaveLength(3)
    expect(state.voice[20]).toEqual([
      { user_id: 2, muted: true, deafened: false, screensharing: false },
    ])
    expect(state.activeChannelId).toBe(10)
  })

  it('keeps a remembered text channel and refuses a voice or missing one', () => {
    expect(server(createInitialState({ me: ME, activeChannelId: 11 }), READY).activeChannelId).toBe(11)
    expect(server(createInitialState({ me: ME, activeChannelId: 20 }), READY).activeChannelId).toBe(10)
    expect(server(createInitialState({ me: ME, activeChannelId: 99 }), READY).activeChannelId).toBe(10)
  })

  it('after a reconnect keeps the open channel and drops every other cache', () => {
    let state = loaded(loaded(ready(), 10, [1, 2]), 11, [3])
    state = reducer(state, { type: 'connection.down' })
    expect(state.connection).toBe('reconnecting')
    state = server(state, READY)
    expect(state.connection).toBe('open')
    expect(ids(state, 10)).toEqual([1, 2])
    expect(channelMessages(state, 11).loaded).toBe(false)
  })

  it('rebuilds voice and presence from scratch', () => {
    let state = server(ready(), { type: 'presence', user_id: 2, online: true })
    state = server(state, { ...READY, voice: {} } as ServerEvent)
    expect(state.users[2].online).toBe(false)
    expect(state.voice).toEqual({})
  })
})

describe('message.new', () => {
  it('appends a message from somebody else', () => {
    const state = server(loaded(ready(), 10, [1, 2]), { type: 'message.new', message: message(3) })
    expect(ids(state)).toEqual([1, 2, 3])
    expect(state.latest[10]).toBe(3)
  })

  it('reconciles the optimistic row by nonce, keeping its key', () => {
    let state = loaded(ready(), 10, [1])
    state = reducer(state, { type: 'message.optimistic', message: optimistic('n1') })
    expect(channelMessages(state, 10).items[1].status).toBe('pending')

    state = server(state, { type: 'message.new', message: message(2, 10, ME, 'selam'), nonce: 'n1' })
    const items = channelMessages(state, 10).items
    expect(items).toHaveLength(2)
    expect(items[1]).toMatchObject({ id: 2, status: 'sent', key: 'n1', content: 'selam' })
  })

  it('puts the confirmed message before rows still pending, in id order', () => {
    let state = loaded(ready(), 10, [1])
    state = run(
      state,
      { type: 'message.optimistic', message: optimistic('n1') },
      { type: 'message.optimistic', message: optimistic('n2') },
    )
    // Somebody else's message was stored between our two.
    state = server(state, { type: 'message.new', message: message(3) })
    state = server(state, { type: 'message.new', message: message(2, 10, ME), nonce: 'n1' })
    const items = channelMessages(state, 10).items
    expect(items.map((item) => [item.id, item.status])).toEqual([
      [1, 'sent'],
      [2, 'sent'],
      [3, 'sent'],
      [-1, 'pending'],
    ])
    expect(items[3].nonce).toBe('n2')
  })

  it('ignores a message it already has', () => {
    const before = loaded(ready(), 10, [1, 2])
    const after = server(before, { type: 'message.new', message: message(2) })
    expect(ids(after)).toEqual([1, 2])
    expect(totalUnread(after)).toBe(0)
  })

  it('treats an unknown nonce as an ordinary message (another tab of ours)', () => {
    const state = server(loaded(ready(), 10, [1]), {
      type: 'message.new',
      message: message(2, 10, ME),
      nonce: 'other-tab',
    })
    expect(ids(state)).toEqual([1, 2])
    expect(totalUnread(state)).toBe(0)
  })

  it('counts unread for another channel, and for the open one while the tab is hidden', () => {
    let state = loaded(ready(), 10, [1])
    state = server(state, { type: 'message.new', message: message(5, 11) })
    expect(state.unread[11]).toBe(1)
    state = server(state, { type: 'message.new', message: message(6, 10) }, false)
    expect(state.unread[10]).toBe(1)
    expect(totalUnread(state)).toBe(2)

    state = reducer(state, { type: 'viewing' })
    expect(state.unread[10]).toBe(0)
    expect(state.lastRead[10]).toBe(6)

    state = reducer(state, { type: 'channel.select', channelId: 11 })
    expect(state.activeChannelId).toBe(11)
    expect(totalUnread(state)).toBe(0)
    expect(state.lastRead[11]).toBe(5)
  })

  it('never counts our own message as unread, and reads what we are looking at', () => {
    let state = loaded(ready(), 10, [1])
    state = server(state, { type: 'message.new', message: message(2, 11, ME) })
    state = server(state, { type: 'message.new', message: message(3, 10) })
    expect(totalUnread(state)).toBe(0)
    expect(state.lastRead[10]).toBe(3)
  })

  it('clears the author from the typing line', () => {
    let state = server(ready(), { type: 'typing', channel_id: 10, user_id: 2 })
    expect(typingNames(state, 10, 1000)).toEqual(['Bora'])
    state = server(state, { type: 'message.new', message: message(1) })
    expect(typingNames(state, 10, 1000)).toEqual([])
  })
})

describe('message pages', () => {
  it('prepends an older page and records has_more', () => {
    let state = loaded(ready(), 10, [5, 6], true)
    state = reducer(state, { type: 'messages.loading-older', channelId: 10 })
    expect(channelMessages(state, 10).loadingOlder).toBe(true)
    state = reducer(state, {
      type: 'messages.loaded',
      channelId: 10,
      messages: [message(3), message(4), message(5)],
      hasMore: false,
      mode: 'prepend',
      viewing: true,
    })
    const channel = channelMessages(state, 10)
    expect(ids(state)).toEqual([3, 4, 5, 6])
    expect(channel.hasMore).toBe(false)
    expect(channel.loadingOlder).toBe(false)
  })

  it('a refetch keeps live messages newer than the page and unconfirmed rows', () => {
    let state = server(ready(), { type: 'message.new', message: message(9) })
    state = reducer(state, { type: 'message.optimistic', message: optimistic('n1') })
    state = loaded(state, 10, [7, 8])
    const items = channelMessages(state, 10).items
    expect(items.map((item) => item.id)).toEqual([7, 8, 9, -1])
    expect(channelMessages(state, 10).loaded).toBe(true)
  })

  it('a refetch drops confirmed rows the server no longer returns in range', () => {
    const state = loaded(loaded(ready(), 10, [1, 2, 3]), 10, [2, 3, 4])
    expect(ids(state)).toEqual([2, 3, 4])
  })

  it('a failed first load is an error; a failed older page is not', () => {
    let state = reducer(ready(), { type: 'messages.load-failed', channelId: 10 })
    expect(channelMessages(state, 10).error).toBe(true)
    state = loaded(state, 10, [1], true)
    state = run(
      state,
      { type: 'messages.loading-older', channelId: 10 },
      { type: 'messages.load-failed', channelId: 10 },
    )
    expect(channelMessages(state, 10)).toMatchObject({ error: false, loadingOlder: false })
  })

  it('marks unread from a probe of a channel that is not open', () => {
    let state = createInitialState({ me: ME, lastRead: { 11: 5, 10: 5 } })
    state = server(state, READY)
    state = reducer(state, { type: 'latest.loaded', channelId: 11, latestId: 5 })
    expect(totalUnread(state)).toBe(0)
    state = reducer(state, { type: 'latest.loaded', channelId: 11, latestId: 8 })
    expect(state.unread[11]).toBe(1)
    state = reducer(state, { type: 'latest.loaded', channelId: 10, latestId: 8 })
    expect(state.unread[10] ?? 0).toBe(0)
  })
})

describe('sending', () => {
  it('fails and retries by nonce', () => {
    let state = loaded(ready(), 10, [1])
    state = reducer(state, { type: 'message.optimistic', message: optimistic('n1') })
    state = reducer(state, { type: 'message.failed', channelId: 10, nonce: 'n1' })
    expect(channelMessages(state, 10).items[1].status).toBe('failed')
    state = reducer(state, { type: 'message.retry', channelId: 10, nonce: 'n1' })
    expect(channelMessages(state, 10).items[1].status).toBe('pending')
  })

  it('a late timeout does not fail a message that was confirmed', () => {
    let state = loaded(ready(), 10, [1])
    state = reducer(state, { type: 'message.optimistic', message: optimistic('n1') })
    state = server(state, { type: 'message.new', message: message(2, 10, ME), nonce: 'n1' })
    const after = reducer(state, { type: 'message.failed', channelId: 10, nonce: 'n1' })
    expect(after).toBe(state)
  })

  it('losing the connection fails everything still pending', () => {
    let state = loaded(ready(), 10, [1])
    state = reducer(state, { type: 'message.optimistic', message: optimistic('n1') })
    state = reducer(state, { type: 'connection.down' })
    expect(channelMessages(state, 10).items[1].status).toBe('failed')
  })
})

describe('presence and members', () => {
  it('flips the online flag', () => {
    const state = server(ready(), { type: 'presence', user_id: 2, online: true })
    expect(state.users[2].online).toBe(true)
  })

  it('ignores presence for somebody it does not know', () => {
    const before = ready()
    expect(server(before, { type: 'presence', user_id: 77, online: true })).toBe(before)
  })

  it('adds a new account offline and does not reset a known one', () => {
    let state = server(ready(), { type: 'user.joined', user: { id: 3, name: 'Cem' } })
    expect(state.users[3]).toEqual({ id: 3, name: 'Cem', online: false })
    state = server(state, { type: 'presence', user_id: 3, online: true })
    state = server(state, { type: 'user.joined', user: { id: 3, name: 'Cem' } })
    expect(state.users[3].online).toBe(true)
  })

  it('adds a channel once', () => {
    const channel = { id: 12, name: 'yeni', kind: 'text' as const }
    let state = server(ready(), { type: 'channel.new', channel })
    state = server(state, { type: 'channel.new', channel })
    expect(state.channels.filter((item) => item.id === 12)).toHaveLength(1)
  })

  it('selecting a voice or unknown channel changes nothing', () => {
    const before = ready()
    expect(reducer(before, { type: 'channel.select', channelId: 20 })).toBe(before)
    expect(reducer(before, { type: 'channel.select', channelId: 99 })).toBe(before)
  })
})

describe('voice', () => {
  const flags = { muted: false, deafened: false, screensharing: false }

  it('adds a participant', () => {
    const state = server(ready(), { type: 'voice.joined', channel_id: 20, user_id: 1, ...flags })
    expect(state.voice[20].map((participant) => participant.user_id)).toEqual([2, 1])
  })

  it('a user is in one channel only, and is never listed twice', () => {
    let state = server(ready(), {
      type: 'channel.new',
      channel: { id: 21, name: 'Oyun', kind: 'voice' },
    })
    state = server(state, { type: 'voice.joined', channel_id: 21, user_id: 2, ...flags })
    expect(state.voice[20]).toEqual([])
    expect(state.voice[21]).toHaveLength(1)
    state = server(state, { type: 'voice.joined', channel_id: 21, user_id: 2, ...flags, muted: true })
    expect(state.voice[21]).toEqual([{ user_id: 2, ...flags, muted: true }])
  })

  it('removes a participant on voice.left', () => {
    const state = server(ready(), { type: 'voice.left', channel_id: 20, user_id: 2 })
    expect(state.voice[20]).toEqual([])
  })

  it('updates flags on voice.state', () => {
    const state = server(ready(), {
      type: 'voice.state',
      channel_id: 20,
      user_id: 2,
      muted: false,
      deafened: true,
      screensharing: true,
    })
    expect(state.voice[20][0]).toEqual({
      user_id: 2,
      muted: false,
      deafened: true,
      screensharing: true,
    })
  })

  it('leaves the state untouched for frames the engine owns', () => {
    const before = ready()
    expect(server(before, { type: 'voice.peers', channel_id: 20, peers: [2] })).toBe(before)
    expect(server(before, { type: 'signal', from: 2, data: { candidate: null } })).toBe(before)
    expect(server(before, { type: 'error', code: 'NOT_IN_VOICE', message: '' })).toBe(before)
  })
})

describe('typing', () => {
  it('expires after the TTL and never shows ourselves', () => {
    let state = server(ready(), { type: 'typing', channel_id: 10, user_id: 2 }, true, 1000)
    state = server(state, { type: 'typing', channel_id: 10, user_id: 1 }, true, 1000)
    expect(typingNames(state, 10, 1000 + TYPING_TTL_MS - 1)).toEqual(['Bora'])
    expect(typingNames(state, 10, 1000 + TYPING_TTL_MS)).toEqual([])
    expect(typingNames(state, 11, 1000)).toEqual([])

    const unchanged = reducer(state, { type: 'typing.prune', now: 1001 })
    expect(unchanged).toBe(state)
    const pruned = reducer(state, { type: 'typing.prune', now: 1000 + TYPING_TTL_MS })
    expect(pruned.typing[10]).toEqual({})
  })
})
