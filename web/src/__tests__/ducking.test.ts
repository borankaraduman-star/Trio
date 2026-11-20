import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DUCK_PREFS,
  DUCK_ATTACK_MS,
  DUCK_HOLD_MS,
  DUCK_PREFS_KEY,
  DUCK_RELEASE_MS,
  DUCK_TICK_MS,
  Ducker,
  DuckPrefsStore,
  duckedPlayback,
  validateDuckPrefs,
  type DuckerClock,
  type DuckPrefs,
} from '../audio/ducking'

/** A clock the test moves by hand; interval callbacks run as time passes. */
class FakeClock implements DuckerClock {
  time = 0
  private timers = new Map<number, { fn: () => void; ms: number; next: number }>()
  private id = 1
  now = () => this.time
  setInterval = (fn: () => void, ms: number) => {
    const id = this.id++
    this.timers.set(id, { fn, ms, next: this.time + ms })
    return id
  }
  clearInterval = (handle: unknown) => {
    this.timers.delete(handle as number)
  }
  get active(): number {
    return this.timers.size
  }
  advance(ms: number): void {
    const end = this.time + ms
    for (;;) {
      let soonest: { fn: () => void; ms: number; next: number } | null = null
      for (const timer of this.timers.values()) if (!soonest || timer.next < soonest.next) soonest = timer
      if (!soonest || soonest.next > end) break
      this.time = soonest.next
      soonest.next += soonest.ms
      soonest.fn()
    }
    this.time = end
  }
}

function setup(prefs: Partial<DuckPrefs> = {}) {
  const clock = new FakeClock()
  const ducker = new Ducker({ ...DEFAULT_DUCK_PREFS, ...prefs }, clock)
  const share: number[] = []
  const music: number[] = []
  ducker.add('share', (f) => share.push(f))
  ducker.add('music', (f) => music.push(f))
  const last = (list: number[]) => list[list.length - 1]
  return { clock, ducker, share, music, last }
}

describe('the duck envelope', () => {
  it('attacks to 1 − amount within the attack time, smoothly and monotonically', () => {
    const { clock, ducker, share, last } = setup()
    expect(last(share)).toBe(1)
    ducker.setSpeaking(true, false)
    clock.advance(DUCK_ATTACK_MS / 2)
    const mid = last(share)
    expect(mid).toBeGreaterThan(0.4)
    expect(mid).toBeLessThan(1)
    clock.advance(DUCK_ATTACK_MS / 2 + DUCK_TICK_MS)
    expect(last(share)).toBeCloseTo(0.4, 5)
    for (let i = 1; i < share.length; i++) expect(share[i]).toBeLessThanOrEqual(share[i - 1] + 1e-9)
    // No step larger than a tick's worth of the steepest point of the cosine.
    const maxStep = Math.max(...share.slice(1).map((v, i) => Math.abs(v - share[i])))
    expect(maxStep).toBeLessThan(0.6 * (Math.PI / 2) * (DUCK_TICK_MS / DUCK_ATTACK_MS) + 1e-6)
    // At rest, nothing ticks.
    expect(clock.active).toBe(0)
  })

  it('holds after speech ends, then releases in the release time', () => {
    const { clock, ducker, share, last } = setup()
    ducker.setSpeaking(true, false)
    clock.advance(500)
    ducker.setSpeaking(false, false)
    clock.advance(DUCK_HOLD_MS - DUCK_TICK_MS)
    expect(last(share)).toBeCloseTo(0.4, 5)
    clock.advance(DUCK_TICK_MS + DUCK_RELEASE_MS / 2)
    expect(last(share)).toBeGreaterThan(0.45)
    expect(last(share)).toBeLessThan(0.95)
    clock.advance(DUCK_RELEASE_MS / 2 + DUCK_TICK_MS)
    expect(last(share)).toBe(1)
    expect(clock.active).toBe(0)
  })

  it('does not pump between words shorter than the hold', () => {
    const { clock, ducker, share } = setup()
    ducker.setSpeaking(true, false)
    clock.advance(300)
    const from = share.length
    for (let word = 0; word < 6; word++) {
      ducker.setSpeaking(false, false)
      clock.advance(DUCK_HOLD_MS - 50)
      ducker.setSpeaking(true, false)
      clock.advance(200)
    }
    for (const value of share.slice(from)) expect(value).toBeCloseTo(0.4, 5)
  })

  it('several speakers are one duck, and the release waits for the last', () => {
    const { clock, ducker, last, share } = setup()
    // The engine side: others = anyone else. Two people overlapping is still `true`.
    ducker.setSpeaking(true, false)
    clock.advance(200)
    ducker.setSpeaking(true, true)
    clock.advance(200)
    expect(last(share)).toBeCloseTo(0.4, 5)
    ducker.setSpeaking(false, true)
    clock.advance(DUCK_HOLD_MS + DUCK_RELEASE_MS + 50)
    expect(last(share)).toBeCloseTo(0.4, 5)
    ducker.setSpeaking(false, false)
    clock.advance(DUCK_HOLD_MS + DUCK_RELEASE_MS + 50)
    expect(last(share)).toBe(1)
  })

  it('my own speech counts only with "Ben konuşurken de kıs"', () => {
    const off = setup({ self: false })
    off.ducker.setSpeaking(false, true)
    off.clock.advance(300)
    expect(off.last(off.share)).toBe(1)
    const on = setup({ self: true })
    on.ducker.setSpeaking(false, true)
    on.clock.advance(300)
    expect(on.last(on.share)).toBeCloseTo(0.4, 5)
  })

  it('music ducks only with "Müziği de kıs"; screens follow the main switch', () => {
    const plain = setup()
    plain.ducker.setSpeaking(true, false)
    plain.clock.advance(300)
    expect(plain.last(plain.music)).toBe(1)
    const both = setup({ music: true, amount: 0.8 })
    both.ducker.setSpeaking(true, false)
    both.clock.advance(300)
    expect(both.last(both.music)).toBeCloseTo(0.2, 5)
    expect(both.last(both.share)).toBeCloseTo(0.2, 5)
    const none = setup({ enabled: false, music: true })
    none.ducker.setSpeaking(true, false)
    none.clock.advance(300)
    expect(none.last(none.share)).toBe(1)
    expect(none.last(none.music)).toBe(1)
  })

  it('turned off mid-duck, returns to full smoothly (a release, not a jump)', () => {
    const { clock, ducker, share, last } = setup()
    ducker.setSpeaking(true, false)
    clock.advance(DUCK_ATTACK_MS / 2)
    const at = last(share)
    ducker.setPrefs({ ...DEFAULT_DUCK_PREFS, enabled: false })
    clock.advance(DUCK_TICK_MS)
    expect(Math.abs(last(share) - at)).toBeLessThan(0.05)
    clock.advance(DUCK_RELEASE_MS)
    expect(last(share)).toBe(1)
    // And on again while still speaking: ducks again.
    ducker.setPrefs({ ...DEFAULT_DUCK_PREFS, enabled: true })
    clock.advance(DUCK_ATTACK_MS + DUCK_TICK_MS)
    expect(last(share)).toBeCloseTo(0.4, 5)
  })

  it('a late tick (a throttled timer) lands on the right value instead of lagging', () => {
    const { clock, ducker } = setup()
    ducker.setSpeaking(true, false)
    // No ticks run: the factor is still a function of the clock.
    clock.time += 1000
    expect(ducker.factor('share')).toBeCloseTo(0.4, 5)
  })

  it('a new target registers with the current factor at once', () => {
    const { clock, ducker } = setup()
    ducker.setSpeaking(true, false)
    clock.advance(300)
    const seen: number[] = []
    ducker.add('share', (f) => seen.push(f))
    expect(seen).toEqual([expect.closeTo(0.4, 5)])
  })
})

describe('composition with volume, mute and deafen', () => {
  it('multiplies on the path the slider chose, and never changes the path', () => {
    expect(duckedPlayback(0.5, false, 0.4)).toEqual({ boost: false, routeGain: 0, elementVolume: 0.2, elementMuted: false })
    expect(duckedPlayback(1, true, 0.4)).toMatchObject({ boost: false, elementVolume: 0.4, elementMuted: true })
    expect(duckedPlayback(0, false, 0.4).elementVolume).toBe(0)
    // 150 % ducked to 60 % stays on the boost route (its gain), not back on the element.
    const boosted = duckedPlayback(1.5, false, 0.4)
    expect(boosted.boost).toBe(true)
    expect(boosted.routeGain).toBeCloseTo(0.6)
    expect(duckedPlayback(1.5, false, 1).routeGain).toBe(1.5)
    // Undeafen keeps the duck.
    expect(duckedPlayback(1, false, 0.4).elementVolume).toBeCloseTo(0.4)
  })
})

describe('the follow of a voice engine', () => {
  it('splits others from me, and my own needs the microphone sent', () => {
    const clock = new FakeClock()
    const ducker = new Ducker({ ...DEFAULT_DUCK_PREFS }, clock)
    let snapshot = { status: 'connected', speaking: [] as number[], remoteAudio: [{ userId: 2 }, { userId: 3 }], transmitting: true }
    const listeners = new Set<() => void>()
    const off = ducker.follow({
      subscribe: (l) => {
        listeners.add(l)
        return () => listeners.delete(l)
      },
      getSnapshot: () => snapshot,
    })
    const emit = (next: Partial<typeof snapshot>) => {
      snapshot = { ...snapshot, ...next }
      for (const l of listeners) l()
    }
    emit({ speaking: [1], transmitting: false })
    clock.advance(300)
    expect(ducker.factor('share')).toBe(1)
    emit({ speaking: [1], transmitting: true })
    clock.advance(300)
    expect(ducker.factor('share')).toBeCloseTo(0.4, 5)
    emit({ speaking: [] })
    clock.advance(DUCK_HOLD_MS + DUCK_RELEASE_MS + 20)
    expect(ducker.factor('share')).toBe(1)
    emit({ speaking: [3] })
    clock.advance(300)
    expect(ducker.factor('share')).toBeCloseTo(0.4, 5)
    // Leaving the call ends the duck.
    off()
    clock.advance(DUCK_HOLD_MS + DUCK_RELEASE_MS + 20)
    expect(ducker.factor('share')).toBe(1)
  })
})

describe('the preferences', () => {
  it('repair field by field and are kept under trio.duck12', () => {
    expect(DUCK_PREFS_KEY).toBe('trio.duck12')
    expect(validateDuckPrefs(null)).toEqual(DEFAULT_DUCK_PREFS)
    expect(DEFAULT_DUCK_PREFS).toEqual({ enabled: true, amount: 0.6, music: false, self: true })
    expect(validateDuckPrefs({ enabled: false, amount: 7, music: 'yes', self: false })).toEqual({
      enabled: false,
      amount: 1,
      music: false,
      self: false,
    })
    expect(validateDuckPrefs({ amount: -1 }).amount).toBe(0)
    const memory = new Map<string, string>()
    const storage = { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v) }
    const store = new DuckPrefsStore(storage)
    store.set({ amount: 0.8, music: true })
    expect(JSON.parse(memory.get(DUCK_PREFS_KEY)!)).toEqual({ enabled: true, amount: 0.8, music: true, self: true })
    expect(new DuckPrefsStore(storage).getSnapshot().amount).toBe(0.8)
    memory.set(DUCK_PREFS_KEY, '{nope')
    expect(new DuckPrefsStore(storage).getSnapshot()).toEqual(DEFAULT_DUCK_PREFS)
  })
})
