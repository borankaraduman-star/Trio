import { describe, expect, it, vi } from 'vitest'
import { cueAudible, cueTones, CuePlayer, ringPeriods, ringTones, RING_MAX_S, RING_PERIOD_S, type CueKind } from '../audio/cues'

const KINDS: CueKind[] = ['mute', 'unmute', 'deafen', 'undeafen', 'join', 'leave', 'ring']

describe('cue scheduling', () => {
  it('every cue is short, audible and ordered', () => {
    for (const kind of KINDS) {
      const tones = cueTones(kind)
      expect(tones.length).toBeGreaterThan(0)
      let last = -1
      for (const t of tones) {
        expect(t.start).toBeGreaterThanOrEqual(last)
        last = t.start
        expect(t.freq).toBeGreaterThan(100)
        expect(t.freq).toBeLessThan(4000)
        expect(t.gain).toBeGreaterThan(0)
        expect(t.gain).toBeLessThanOrEqual(1)
      }
      const end = Math.max(...tones.map((t) => t.start + t.dur))
      expect(end).toBeLessThan(kind === 'ring' ? RING_PERIOD_S : 0.5)
    }
  })

  it('pairs of cues are mirror images, so on and off sound different', () => {
    const freqs = (k: CueKind) => cueTones(k).map((t) => t.freq)
    expect(freqs('unmute')).toEqual([...freqs('mute')].reverse())
    expect(freqs('undeafen')).toEqual([...freqs('deafen')].reverse())
    expect(freqs('leave')).toEqual([...freqs('join')].reverse())
    expect(freqs('mute')).not.toEqual(freqs('unmute'))
  })

  it('the ring loops whole periods up to 20 s', () => {
    expect(RING_MAX_S).toBe(20)
    expect(ringPeriods()).toBe(10)
    expect(ringPeriods(5)).toBe(2)
    expect(ringPeriods(0)).toBe(0)
    expect(ringTones()).toEqual(cueTones('ring'))
  })

  it('off, at zero volume, or deafened (except my own deafen click) nothing is heard', () => {
    const on = { enabled: true, volume: 0.5, deafened: false }
    for (const kind of KINDS) expect(cueAudible(kind, on)).toBe(true)
    for (const kind of KINDS) expect(cueAudible(kind, { ...on, enabled: false })).toBe(false)
    for (const kind of KINDS) expect(cueAudible(kind, { ...on, volume: 0 })).toBe(false)
    const deaf = { ...on, deafened: true }
    expect(KINDS.filter((kind) => cueAudible(kind, deaf))).toEqual(['deafen', 'undeafen'])
  })
})

/** A fake AudioContext that records what is scheduled. */
function fakeContext() {
  const started: { freq: number; at: number }[] = []
  const param = () => ({ value: 0, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn() })
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn(), gain: param() })
  const context = {
    currentTime: 10,
    state: 'running',
    destination: {},
    resume: vi.fn(async () => undefined),
    createGain: () => node(),
    createOscillator: () => {
      const osc = {
        ...node(),
        type: 'sine',
        frequency: { value: 0 },
        onended: null,
        start: vi.fn((at: number) => started.push({ freq: osc.frequency.value, at })),
        stop: vi.fn(),
      }
      return osc
    },
  }
  return { context: context as unknown as AudioContext, started }
}

describe('CuePlayer', () => {
  it('schedules exactly the cue tones, after a small lead, through one context', () => {
    const { context, started } = fakeContext()
    const create = vi.fn(() => context)
    const player = new CuePlayer(create)
    player.play('mute')
    player.play('join')
    expect(create).toHaveBeenCalledTimes(1)
    expect(started.map((s) => s.freq)).toEqual([...cueTones('mute'), ...cueTones('join')].map((t) => t.freq))
    expect(started[0].at).toBeCloseTo(10.02)
  })

  it('plays nothing it may not, and a ring stops when deafened', () => {
    vi.useFakeTimers()
    const { context, started } = fakeContext()
    const player = new CuePlayer(() => context)
    player.setPrefs({ enabled: false, volume: 0.5, deafened: false })
    player.play('mute')
    player.startRing()
    expect(started).toEqual([])
    expect(player.ringing).toBe(false)
    player.setPrefs({ enabled: true, volume: 0.5, deafened: false })
    player.startRing()
    expect(player.ringing).toBe(true)
    expect(started).toHaveLength(ringTones().length)
    vi.advanceTimersByTime(RING_PERIOD_S * 1000)
    expect(started).toHaveLength(2 * ringTones().length)
    player.setPrefs({ enabled: true, volume: 0.5, deafened: true })
    expect(player.ringing).toBe(false)
    vi.useRealTimers()
  })

  it('the ring stops by itself after its time', () => {
    vi.useFakeTimers()
    const { context, started } = fakeContext()
    const player = new CuePlayer(() => context)
    player.startRing(RING_MAX_S)
    vi.advanceTimersByTime(60_000)
    expect(player.ringing).toBe(false)
    expect(started).toHaveLength(ringPeriods() * ringTones().length)
    vi.useRealTimers()
  })
})
