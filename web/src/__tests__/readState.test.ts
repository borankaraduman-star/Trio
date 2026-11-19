import { describe, expect, it } from 'vitest'
import { mergeEntry, readsToSend } from '../lib/readState'
import { createInitialState, reducer, totalUnread, type AppState } from '../store'
import type { Message, ReadStateEntry, ServerEvent } from '../types'

const ME = { id: 1, name: 'Ada' }
const BORA = { id: 2, name: 'Bora' }
const CHANNELS = [
  { id: 10, name: 'genel', kind: 'text' as const },
  { id: 11, name: 'oyun', kind: 'text' as const },
  { id: 20, name: 'Sohbet', kind: 'voice' as const },
]

function ready(readState?: Record<string, ReadStateEntry>): ServerEvent {
  return {
    type: 'ready',
    user: ME,
    users: [
      { ...ME, online: true },
      { ...BORA, online: true },
    ],
    channels: CHANNELS,
    voice: { '20': [] },
    ...(readState ? { read_state: readState } : {}),
  }
}

function server(state: AppState, event: ServerEvent, viewing = true): AppState {
  return reducer(state, { type: 'server', event, now: 1000, viewing })
}

function message(id: number, channelId = 10, author = BORA): Message {
  return { id, channel_id: channelId, author, content: `m${id}`, created_at: '2026-11-18T10:00:00Z' }
}

describe('mergeEntry', () => {
  it('takes the server mark and its exact count when the device knows less', () => {
    expect(mergeEntry(undefined, { last_read: 5, latest: 9, unread: 3 })).toEqual({
      lastRead: 5,
      serverRead: 5,
      latest: 9,
      unread: 3,
    })
  })
  it('keeps a device mark that is further (to be told to the server), counting "at least one"', () => {
    expect(mergeEntry(7, { last_read: 5, latest: 9, unread: 3 })).toEqual({ lastRead: 7, serverRead: 5, latest: 9, unread: 1 })
    expect(mergeEntry(9, { last_read: 0, latest: 9, unread: 4 })).toEqual({ lastRead: 9, serverRead: 0, latest: 9, unread: 0 })
  })
  it('a channel read to its end is not unread', () => {
    expect(mergeEntry(3, { last_read: 9, latest: 9, unread: 0 }).unread).toBe(0)
  })
})

describe('readsToSend', () => {
  it('lists only text channels whose device mark is ahead of the server', () => {
    expect(readsToSend({ 10: 8, 11: 4, 99: 50 }, { 10: 8, 11: 2 }, [10, 11])).toEqual([[11, 4]])
    expect(readsToSend({ 10: 3 }, {}, [10, 11])).toEqual([[10, 3]])
  })
})

describe('the store with server read state', () => {
  const base = () => createInitialState({ me: ME, activeChannelId: 10, lastRead: { 11: 40 } })

  it('merges ready.read_state: counts, marks and what is left to tell', () => {
    const state = server(
      base(),
      ready({
        '10': { last_read: 30, latest: 30, unread: 0 },
        '11': { last_read: 20, latest: 45, unread: 7 },
      }),
    )
    expect(state.readSync).toBe(true)
    expect(state.lastRead).toEqual({ 10: 30, 11: 40 })
    expect(state.serverRead).toEqual({ 10: 30, 11: 20 })
    expect(state.unread[11]).toBe(1)
    expect(readsToSend(state.lastRead, state.serverRead, [10, 11])).toEqual([[11, 40]])
  })

  it('an older server (no read_state) leaves read sync off', () => {
    expect(server(base(), ready()).readSync).toBe(false)
  })

  it('channel.read from another device of mine clears or recounts a channel', () => {
    let state = server(base(), ready({ '10': { last_read: 30, latest: 30, unread: 0 }, '11': { last_read: 40, latest: 50, unread: 6 } }))
    expect(totalUnread(state)).toBe(6)
    state = server(state, { type: 'channel.read', channel_id: 11, message_id: 47, unread: 2 })
    expect(state.unread[11]).toBe(2)
    expect(state.lastRead[11]).toBe(47)
    expect(state.serverRead[11]).toBe(47)
    state = server(state, { type: 'channel.read', channel_id: 11, message_id: 50, unread: 0 })
    expect(totalUnread(state)).toBe(0)
    // Backwards: ignored.
    expect(server(state, { type: 'channel.read', channel_id: 11, message_id: 3, unread: 9 }).lastRead[11]).toBe(50)
  })

  it('opening a channel with unread messages remembers the divider; leaving ends it', () => {
    let state = server(base(), ready({ '10': { last_read: 30, latest: 30, unread: 0 }, '11': { last_read: 40, latest: 44, unread: 4 } }), false)
    state = reducer(state, { type: 'channel.select', channelId: 11 })
    expect(state.divider).toEqual({ channelId: 11, after: 40 })
    expect(state.lastRead[11]).toBe(44)
    // Loading the page again keeps the visit's divider.
    state = reducer(state, { type: 'messages.loaded', channelId: 11, messages: [41, 42, 43, 44].map((id) => message(id, 11)), hasMore: true, mode: 'replace', viewing: true })
    expect(state.divider).toEqual({ channelId: 11, after: 40 })
    state = reducer(state, { type: 'channel.select', channelId: 10 })
    expect(state.divider).toBeNull()
  })

  it('no divider without a mark (a device that never read the channel lands at the bottom)', () => {
    const fresh = createInitialState({ me: ME, activeChannelId: 10 })
    let state = server(fresh, ready({ '10': { last_read: 0, latest: 5, unread: 5 }, '11': { last_read: 0, latest: 0, unread: 0 } }))
    state = reducer(state, { type: 'messages.loaded', channelId: 10, messages: [message(5)], hasMore: true, mode: 'replace', viewing: true })
    expect(state.divider).toBeNull()
  })

  it('channel.updated renames; channel.deleted forgets the channel and moves away from it', () => {
    let state = server(base(), ready({ '10': { last_read: 1, latest: 3, unread: 2 }, '11': { last_read: 40, latest: 40, unread: 0 } }), false)
    state = server(state, { type: 'channel.updated', channel: { id: 11, name: 'oyunlar', kind: 'text' } })
    expect(state.channels.find((c) => c.id === 11)?.name).toBe('oyunlar')
    state = server(state, { type: 'channel.deleted', channel_id: 10 })
    expect(state.channels.map((c) => c.id)).toEqual([11, 20])
    expect(state.activeChannelId).toBe(11)
    expect(state.unread[10]).toBeUndefined()
    expect(state.lastRead[10]).toBeUndefined()
    expect(totalUnread(state)).toBe(0)
  })
})
