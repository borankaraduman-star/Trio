import { describe, expect, it } from 'vitest'
import {
  cameraEncodingFor,
  cameraEncodingKey,
  filterMentionNames,
  mentionQueryAt,
  namesWithMore,
  roomCount,
  roomFullMessage,
  roomIsFull,
} from '../lib/groups'
import { AVATAR_COLORS, avatarColor } from '../components/Avatar'
import { talkingLine } from '../lib/phone'
import { stageLayout, type StageTile } from '../components/CallStage'

const NAMES = ['Ayşe', 'Mehmet', 'Zeynep', 'Ali', 'Berk', 'Cem', 'Deniz', 'Ece', 'Fatih', 'Gül', 'Hakan', 'Işıl', 'Kerem', 'Lale', 'Mert']
const people = NAMES.map((name, i) => ({ id: i + 1, name }))

describe('room count and cap', () => {
  it('shows n/max only with a known cap and somebody in the room', () => {
    expect(roomCount(5, 8)).toBe('5/8')
    expect(roomCount(0, 8)).toBeNull()
    expect(roomCount(3, null)).toBeNull()
  })
  it('a full room refuses everybody but its own members', () => {
    expect(roomIsFull(8, 8, false)).toBe(true)
    expect(roomIsFull(8, 8, true)).toBe(false)
    expect(roomIsFull(7, 8, false)).toBe(false)
    expect(roomIsFull(20, null, false)).toBe(false)
    expect(roomFullMessage(8)).toMatch(/^Oda dolu \(8\/8\)/)
  })
})

describe('camera encoding by room size', () => {
  it('leaves small rooms alone and sends less per viewer as the room grows', () => {
    expect(cameraEncodingFor(2)).toBeNull()
    expect(cameraEncodingFor(4)).toBeNull()
    const five = cameraEncodingFor(5)!
    const eight = cameraEncodingFor(8)!
    expect(eight.maxBitrate).toBeLessThan(five.maxBitrate)
    expect(eight.scaleResolutionDownBy).toBeGreaterThan(five.scaleResolutionDownBy)
    // Total upload for a camera stays bounded: 7 viewers × the per-viewer cap.
    expect(7 * eight.maxBitrate).toBeLessThanOrEqual(2_500_000)
    expect(cameraEncodingKey(null)).toBe('default')
    expect(cameraEncodingKey(five)).not.toBe(cameraEncodingKey(eight))
  })
})

describe('talking line with many speakers', () => {
  it('names two and counts the rest', () => {
    expect(namesWithMore(['A', 'B', 'C'])).toBe('A, B, C')
    expect(namesWithMore(['A', 'B', 'C', 'D', 'E'])).toBe('A, B +3')
    const nameOf = (id: number) => NAMES[id - 1]
    expect(talkingLine([2, 3, 4, 5, 1], 1, 8, nameOf)).toBe('5 kişi konuşuyor: Mehmet, Zeynep +3')
    expect(talkingLine([2, 3, 1], 1, 8, nameOf)).toBe('Konuşuyor: Mehmet, Zeynep, Sen')
    expect(talkingLine([2, 1], 1, 8, nameOf)).toBe('Konuşuyor: Mehmet, Sen')
  })
})

describe('avatar colours', () => {
  it('fifteen consecutive ids get fifteen different colours', () => {
    for (const start of [1, 7, 100]) {
      const colours = new Set(Array.from({ length: 15 }, (_, i) => avatarColor(start + i)))
      expect(colours.size).toBe(15)
    }
    expect(AVATAR_COLORS.length).toBeGreaterThanOrEqual(15)
  })
  it('keeps the first accounts’ colours of before', () => {
    const before = ['#52638f', '#37766c', '#97505f', '#86652f', '#a0574a', '#3e6e85', '#75507a']
    for (let id = 1; id <= 6; id += 1) expect(avatarColor(id)).toBe(before[id % 7])
  })
  it('every colour carries the white initial at AA (4.5:1)', () => {
    const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
    for (const hex of AVATAR_COLORS) {
      const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255))
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b
      expect(1.05 / (l + 0.05), hex).toBeGreaterThanOrEqual(4.5)
    }
  })
})

describe('@ suggestions', () => {
  it('finds the query at the caret', () => {
    expect(mentionQueryAt('selam @ay', 9)).toEqual({ start: 6, query: 'ay' })
    expect(mentionQueryAt('@', 1)).toEqual({ start: 0, query: '' })
    expect(mentionQueryAt('ali@example', 11)).toBeNull()
    expect(mentionQueryAt('selam @ay\nnasıl', 15)).toBeNull()
    expect(mentionQueryAt('@ ay', 4)).toBeNull()
  })
  it('filters fifteen names, prefix first, folded like mentions', () => {
    expect(filterMentionNames(people, 'm').map((p) => p.name)).toEqual(['Mehmet', 'Mert', 'Cem', 'Kerem'])
    expect(filterMentionNames(people, 'IŞI').map((p) => p.name)).toEqual(['Işıl'])
    expect(filterMentionNames(people, 'e').map((p) => p.name)[0]).toBe('Ece')
    expect(filterMentionNames(people, '')).toHaveLength(8)
  })
})

describe('a crowded stage', () => {
  const tile = (userId: number | null, kind: 'screen' | 'camera'): StageTile =>
    ({ key: `${kind}-${userId}`, kind, userId, label: String(userId), testId: '', silent: false, mirrored: false, stream: {} as MediaStream })
  const tiles = [tile(1, 'camera'), tile(2, 'camera'), tile(3, 'screen'), ...[4, 5, 6, 7, 8, 9].map((u) => tile(u, 'camera')), tile(null, 'camera')]
  it('shows everything that fits', () => {
    expect(stageLayout(tiles.slice(0, 4), 4, false).folded).toEqual([])
  })
  it('folds the rest behind +N, screens first and my own tile last', () => {
    const { shown, folded } = stageLayout(tiles, 4, false)
    expect(shown.map((t) => t.key)).toEqual(['screen-3', 'camera-1', 'camera-2'])
    expect(folded).toHaveLength(7)
    expect(folded.at(-1)?.userId).toBeNull()
    expect(stageLayout(tiles, 4, true).folded).toEqual([])
  })
})

describe('the member panel toggle', async () => {
  const { loadMembersHidden, saveMembersHidden, membersTitle, MEMBERS_HIDDEN_KEY } = await import('../lib/membersPanel')
  it('is shown unless hidden on this device, and says what it lists', () => {
    const store = new Map<string, string>()
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    }
    expect(loadMembersHidden(storage)).toBe(false)
    saveMembersHidden(true, storage)
    expect(store.get(MEMBERS_HIDDEN_KEY)).toBe('1')
    expect(loadMembersHidden(storage)).toBe(true)
    saveMembersHidden(false, storage)
    expect(loadMembersHidden(storage)).toBe(false)
    expect(membersTitle(5)).toBe('Üyeler — 5 çevrimiçi')
  })
})

describe('who is in which text channel', async () => {
  const { viewersFromReady, viewersOf, hereLine } = await import('../lib/viewers')
  const { createInitialState, reducer } = await import('../store')
  const users = Object.fromEntries(people.map((p) => [p.id, { ...p, online: true, avatar_url: null }]))
  it('reads ready.viewers and lists me first, then by name', () => {
    const viewers = viewersFromReady({ '1': [3, 1, 2], '7': [5], bad: [1], '9': 'x' })
    expect(viewers).toEqual({ 1: 1, 2: 1, 3: 1, 5: 7 })
    expect(viewersOf(viewers, 1, users, 3).map((p) => p.name)).toEqual(['Zeynep', 'Ayşe', 'Mehmet'])
    expect(hereLine(viewersOf(viewers, 1, users, 3), 3)).toBe('Burada: Sen, Ayşe, Mehmet')
    expect(hereLine([], 3)).toBeNull()
  })
  it('follows presence.viewing and forgets everything when the connection drops', () => {
    let state = createInitialState({ me: { id: 1, name: 'Ayşe' } })
    const server = (event: unknown) => (state = reducer(state, { type: 'server', event: event as never, now: 0, viewing: true }))
    server({ type: 'presence.viewing', user_id: 2, channel_id: 1 })
    server({ type: 'presence.viewing', user_id: 3, channel_id: 4 })
    expect(state.viewers).toEqual({ 2: 1, 3: 4 })
    server({ type: 'presence.viewing', user_id: 2, channel_id: null })
    expect(state.viewers).toEqual({ 3: 4 })
    state = reducer(state, { type: 'connection.down' })
    expect(state.viewers).toEqual({})
  })
})
