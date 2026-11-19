import { describe, expect, it } from 'vitest'
import {
  reduceRing,
  ringCooldownLeft,
  ringErrorMessage,
  ringSounding,
  roomOpenedBy,
  RING_BAND_MS,
  RING_COOLDOWN_MS,
  RING_SOUND_MS,
} from '../lib/ring'

const ring = (now = 1000, channelId = 2, from = 7) =>
  ({ type: 'ring', channelId, from, now, myVoiceChannel: null }) as const

describe('the incoming ring', () => {
  it('a ring shows; a second replaces it', () => {
    const one = reduceRing(null, ring())
    expect(one).toEqual({ channelId: 2, from: 7, at: 1000 })
    expect(reduceRing(one, ring(2000, 3, 8))).toEqual({ channelId: 3, from: 8, at: 2000 })
  })

  it('is ignored when I am already in that room', () => {
    expect(reduceRing(null, { ...ring(), myVoiceChannel: 2 })).toBeNull()
  })

  it('ends on Katıl/Kapat, my joining anywhere, or the ringer leaving that room', () => {
    const one = reduceRing(null, ring())
    expect(reduceRing(one, { type: 'dismiss' })).toBeNull()
    expect(reduceRing(one, { type: 'self-joined' })).toBeNull()
    expect(reduceRing(one, { type: 'left', userId: 7, channelId: 2 })).toBeNull()
    expect(reduceRing(one, { type: 'left', userId: 8, channelId: 2 })).toBe(one)
    expect(reduceRing(one, { type: 'left', userId: 7, channelId: 3 })).toBe(one)
  })

  it('the band lasts two minutes, the sound twenty seconds, and never with DND or deafened', () => {
    const one = reduceRing(null, ring(0))
    expect(reduceRing(one, { type: 'tick', now: RING_BAND_MS - 1 })).toBe(one)
    expect(reduceRing(one, { type: 'tick', now: RING_BAND_MS })).toBeNull()
    const opts = { doNotDisturb: false, deafened: false }
    expect(ringSounding(one, RING_SOUND_MS - 1, opts)).toBe(true)
    expect(ringSounding(one, RING_SOUND_MS, opts)).toBe(false)
    expect(ringSounding(one, 0, { ...opts, doNotDisturb: true })).toBe(false)
    expect(ringSounding(one, 0, { ...opts, deafened: true })).toBe(false)
    expect(ringSounding(null, 0, opts)).toBe(false)
  })
})

describe('ringing out', () => {
  it('waits 30 s after a ring', () => {
    expect(ringCooldownLeft(null, 5)).toBe(0)
    expect(ringCooldownLeft(1000, 1000)).toBe(RING_COOLDOWN_MS)
    expect(ringCooldownLeft(1000, 1000 + RING_COOLDOWN_MS)).toBe(0)
  })

  it('every refusal has a Turkish sentence', () => {
    expect(ringErrorMessage('RATE_LIMITED')).toMatch(/30 saniye/)
    expect(ringErrorMessage('NOT_IN_VOICE')).toMatch(/ses odasında/)
    expect(ringErrorMessage('INVALID_CHANNEL')).toMatch(/bulunamadı/)
    expect(ringErrorMessage('???')).toBe('Çağrı gönderilemedi.')
  })
})

describe('a room going from empty to one person', () => {
  it('names the joiner only in that case and never me', () => {
    expect(roomOpenedBy([], [5], 5, 1)).toBe(5)
    expect(roomOpenedBy([3], [3, 5], 5, 1)).toBeNull()
    expect(roomOpenedBy([], [1], 1, 1)).toBeNull()
  })
})
