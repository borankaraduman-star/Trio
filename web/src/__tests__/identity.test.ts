import { describe, expect, it } from 'vitest'
import { createInitialState, reducer, type AppState } from '../store'
import type { Message, ServerEvent } from '../types'
import { DEFAULT_SERVER, namesSignature, normalizeUser, resolveAuthor, serverProfile, stablePeople } from '../lib/identity'

const ME = { id: 1, name: 'Ada', avatar_url: null }
const BORA = { id: 2, name: 'Bora', avatar_url: '/api/avatars/2/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.webp' }

const READY: ServerEvent = {
  type: 'ready',
  user: ME,
  users: [
    { ...ME, online: true },
    { ...BORA, online: true },
  ],
  channels: [{ id: 10, name: 'genel', kind: 'text' }],
  voice: {},
  server_version: '0.2.0',
  server: { name: 'Bizim Ev', icon_url: '/api/server/icon/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png' },
}

function server(state: AppState, event: ServerEvent): AppState {
  return reducer(state, { type: 'server', event, now: 1000, viewing: true })
}
const ready = () => server(createInitialState({ me: { id: 1, name: 'Ada' } }), READY)

describe('ready (v4)', () => {
  it('takes the server profile, the server version and avatars', () => {
    const state = ready()
    expect(state.server).toEqual(READY.type === 'ready' ? READY.server : null)
    expect(state.serverVersion).toBe('0.2.0')
    expect(state.users[2].avatar_url).toBe(BORA.avatar_url)
    expect(state.me).toEqual(ME)
  })

  it('keeps the defaults with a server that predates v4', () => {
    const old: ServerEvent = { type: 'ready', user: { id: 1, name: 'Ada' }, users: [], channels: [], voice: {} }
    const state = server(createInitialState({ me: { id: 1, name: 'Ada' } }), old)
    expect(state.server).toEqual(DEFAULT_SERVER)
    expect(state.server.name).toBe('Trio')
    expect(state.serverVersion).toBeNull()
  })

  it('ignores an avatar URL that is not one of ours', () => {
    const bad: ServerEvent = {
      ...(READY as Extract<ServerEvent, { type: 'ready' }>),
      users: [{ id: 2, name: 'Bora', avatar_url: 'https://evil.example/x.png', online: true }],
    }
    const state = server(createInitialState({ me: { id: 1, name: 'Ada' } }), bad)
    expect(state.users[2].avatar_url).toBeNull()
  })
})

describe('user.updated', () => {
  it('renames and re-pictures a member, keeping presence', () => {
    let state = ready()
    state = server(state, { type: 'user.updated', user: { id: 2, name: 'Borak', avatar_url: null } })
    expect(state.users[2]).toEqual({ id: 2, name: 'Borak', avatar_url: null, online: true })
    expect(state.me).toEqual(ME)
  })

  it('updates me when it is me (another device of mine, or my own answer)', () => {
    let state = ready()
    const next = { id: 1, name: 'Ada K.', avatar_url: '/api/avatars/1/cccccccccccccccccccccccccccccccc.jpg' }
    state = server(state, { type: 'user.updated', user: next })
    expect(state.me).toEqual(next)
    expect(state.users[1]).toEqual({ ...next, online: true })
  })

  it('does not bring back a removed member', () => {
    let state = server(ready(), { type: 'user.removed', user_id: 2 })
    state = server(state, { type: 'user.updated', user: { id: 2, name: 'Bora', avatar_url: null } })
    expect(state.users[2]).toBeUndefined()
  })
})

describe('server.updated', () => {
  it('replaces the profile', () => {
    const state = server(ready(), { type: 'server.updated', server: { name: 'Yeni', icon_url: null } })
    expect(state.server).toEqual({ name: 'Yeni', icon_url: null })
  })

  it('ignores a malformed one', () => {
    const before = ready()
    const after = server(before, { type: 'server.updated', server: { name: '', icon_url: null } })
    expect(after).toBe(before)
  })
})

describe('the author a row shows', () => {
  const snapshot = { id: 2, name: 'Bora (eski ad)', avatar_url: null }
  const msg: Message = { id: 5, channel_id: 10, author: snapshot, content: 'x', created_at: '2026-11-18T10:00:00Z' }

  it('is the current member when known', () => {
    const state = server(ready(), { type: 'user.updated', user: { id: 2, name: 'Bora Y.', avatar_url: BORA.avatar_url } })
    const author = resolveAuthor(msg.author, state.users)
    expect(author.name).toBe('Bora Y.')
    expect(author.avatar_url).toBe(BORA.avatar_url)
    // The same object while nothing changed (memoised rows stay put).
    expect(resolveAuthor(msg.author, state.users)).toBe(author)
  })

  it('is the message snapshot for a former member or before the list is known', () => {
    const state = server(ready(), { type: 'user.removed', user_id: 2 })
    expect(resolveAuthor(msg.author, state.users)).toBe(snapshot)
    expect(resolveAuthor(msg.author, undefined)).toBe(snapshot)
  })
})

describe('wire helpers', () => {
  it('serverProfile accepts only a name and a /api/ icon', () => {
    expect(serverProfile(null)).toBeNull()
    expect(serverProfile({ name: 3 })).toBeNull()
    expect(serverProfile({ name: 'A', icon_url: 'javascript:alert(1)' })).toEqual({ name: 'A', icon_url: null })
  })

  it('normalizeUser leaves a v3 user unchanged', () => {
    const user = { id: 1, name: 'Ada' }
    expect(normalizeUser(user)).toBe(user)
  })
})

describe('stablePeople and namesSignature (memoised message rows)', () => {
  const members = { 1: { ...ME, online: true }, 2: { ...BORA, online: false } }

  it('gives back the same map when only presence changed', () => {
    const first = stablePeople({}, members)
    expect(first[2]).toEqual({ id: 2, name: 'Bora', avatar_url: BORA.avatar_url })
    const again = stablePeople(first, { ...members, 2: { ...BORA, online: true } })
    expect(again).toBe(first)
  })

  it('a rename is a new map in which only that person is a new object', () => {
    const first = stablePeople({}, members)
    const renamed = stablePeople(first, { ...members, 2: { ...BORA, name: 'Boracık', online: false } })
    expect(renamed).not.toBe(first)
    expect(renamed[1]).toBe(first[1])
    expect(renamed[2].name).toBe('Boracık')
  })

  it('a new avatar and a member leaving are changes too', () => {
    const first = stablePeople({}, members)
    expect(stablePeople(first, { ...members, 1: { ...ME, avatar_url: '/api/avatars/1/bb.png', online: true } })[1]).not.toBe(first[1])
    const left = stablePeople(first, { 1: members[1] })
    expect(left).not.toBe(first)
    expect(left[2]).toBeUndefined()
  })

  it('the signature changes exactly when a shown name changes', () => {
    const first = stablePeople({}, members)
    const renamed = stablePeople(first, { ...members, 2: { ...BORA, name: 'Boracık', online: false } })
    expect(namesSignature([1], renamed)).toBe(namesSignature([1], first))
    expect(namesSignature([1, 2], renamed)).not.toBe(namesSignature([1, 2], first))
    // A former member (not in the map) has a stable, empty entry.
    expect(namesSignature([9], first)).toBe(namesSignature([9], renamed))
  })
})
