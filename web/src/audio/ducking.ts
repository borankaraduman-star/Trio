/**
 * "Biri konuşunca yayın sesini kıs" (CONTRACT-V12-DUCKING): while somebody
 * speaks, the sound of remote shared SCREENS and (optionally) remote shared
 * MUSIC is lowered on THIS listener's speakers, then brought back. Purely
 * local: no voice, no microphone, nothing sent, nobody else is touched.
 *
 * Input: the call's own speaking detector (voice.ts, `snapshot.speaking`),
 * which reads every microphone over the whole interval between two polls
 * (audio/speaking.ts) and already holds a person "speaking" for 300 ms after
 * their last loud block. It never reads a screen's or music's sound, so a
 * share cannot duck itself. No second analyser is made here.
 *
 * Output: a factor in 0..1 per stream class, handed to the places that set a
 * stream's playback gain (useRemoteVolume for screens, RemoteMusic for
 * music). Each multiplies it into what it already applies — the per-person
 * "Yayın sesi" / music volume, deafen, the music mute — so they compose and
 * none of them changes path: an element stays an element (its `volume`), a
 * boosted stream stays on its Web Audio route (its gain node). Routing an
 * element through Web Audio just to duck it would take it out of what
 * Chromium's echo canceller hears (audio/playback.ts), so that is not done.
 *
 * The envelope: speech starts → the factor ramps down to `1 − amount` in
 * DUCK_ATTACK_MS; speech ends (the detector's 300 ms already past) → it holds
 * DUCK_HOLD_MS more, then ramps back up in DUCK_RELEASE_MS. Ramps are raised
 * cosines (no corner at either end) and a new target starts a new ramp from
 * wherever the factor is, so nothing ever jumps. Several speakers are one
 * duck.
 *
 * Time: the factor is a function of the clock, not of how many ticks ran, so
 * a late tick lands on the right value instead of lagging. Ticks are a plain
 * interval timer while something moves (none at rest): requestAnimationFrame
 * stops in a hidden tab, and a hidden page that is PLAYING SOUND — the only
 * case where ducking has anything to do — is exempt from Chromium's timer
 * throttling (measured in e2e 96 with the tab hidden).
 */

export const DUCK_PREFS_KEY = 'trio.duck12'

/** Ramp down to the ducked level, ms. */
export const DUCK_ATTACK_MS = 100
/**
 * Kept ducked after speech ends, ms — ON TOP of the detector's own 300 ms
 * (voice.ts SPEAKING_HOLD_MS), so ~550 ms after the last loud block: the gap
 * between words does not pump the share.
 */
export const DUCK_HOLD_MS = 250
/** Ramp back up, ms. */
export const DUCK_RELEASE_MS = 650
/** Tick period while a ramp runs. */
export const DUCK_TICK_MS = 10

export type DuckClass = 'share' | 'music'

export interface DuckPrefs {
  /** "Biri konuşunca yayın sesini kıs": screens. */
  enabled: boolean
  /** How much lower, 0..1 (0.6 = to 40 %). */
  amount: number
  /** "Müziği de kıs": shared music too (only while `enabled`). */
  music: boolean
  /** "Ben konuşurken de kıs": my own speech counts. */
  self: boolean
}

export const DEFAULT_DUCK_PREFS: DuckPrefs = { enabled: true, amount: 0.6, music: false, self: true }

export function validateDuckPrefs(raw: unknown): DuckPrefs {
  const result: DuckPrefs = { ...DEFAULT_DUCK_PREFS }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return result
  const record = raw as Record<string, unknown>
  if (typeof record.enabled === 'boolean') result.enabled = record.enabled
  if (typeof record.music === 'boolean') result.music = record.music
  if (typeof record.self === 'boolean') result.self = record.self
  if (typeof record.amount === 'number' && Number.isFinite(record.amount)) {
    result.amount = Math.min(1, Math.max(0, Math.round(record.amount * 100) / 100))
  }
  return result
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export class DuckPrefsStore {
  private value: DuckPrefs
  private readonly listeners = new Set<() => void>()

  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage()) {
    let raw: unknown = null
    try {
      const text = storage?.getItem(DUCK_PREFS_KEY) ?? null
      raw = text === null ? null : JSON.parse(text)
    } catch {
      raw = null
    }
    this.value = validateDuckPrefs(raw)
  }

  getSnapshot = (): DuckPrefs => this.value

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  set(patch: Partial<DuckPrefs>): void {
    const valid = validateDuckPrefs({ ...this.value, ...patch })
    if (JSON.stringify(valid) === JSON.stringify(this.value)) return
    this.value = valid
    try {
      this.storage?.setItem(DUCK_PREFS_KEY, JSON.stringify(valid))
    } catch {
      // Private mode: kept until the tab closes.
    }
    for (const listener of [...this.listeners]) listener()
  }
}

/** Raised cosine 0→1: zero slope at both ends. */
function ease(x: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  return (1 - Math.cos(Math.PI * x)) / 2
}

interface Ramp {
  from: number
  to: number
  start: number
  duration: number
}

/** The duck depth (0 = untouched) of one class over time. */
class DepthRamp {
  private ramp: Ramp = { from: 0, to: 0, start: 0, duration: 0 }

  at(now: number): number {
    const { from, to, start, duration } = this.ramp
    if (duration <= 0) return to
    return from + (to - from) * ease((now - start) / duration)
  }

  target(): number {
    return this.ramp.to
  }

  moving(now: number): boolean {
    return this.ramp.duration > 0 && now - this.ramp.start < this.ramp.duration
  }

  retarget(to: number, now: number): void {
    if (to === this.ramp.to) return
    const from = this.at(now)
    // Deeper = attack, shallower = release; the same duration whatever the
    // distance, so "ducked within 100 ms" holds for any amount.
    const duration = from === to ? 0 : to > from ? DUCK_ATTACK_MS : DUCK_RELEASE_MS
    this.ramp = { from, to, start: now, duration }
  }
}

export interface DuckerClock {
  now(): number
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

const realClock: DuckerClock = {
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
}

type Apply = (factor: number) => void

interface DuckProbe {
  __trioDuckProbe?: boolean
  __trioDuck?: {
    share: number
    music: number
    ticks: number
    /** Longest gap between two ticks of one running ramp, ms. */
    maxGapMs: number
    /** Ticks seen while `document.visibilityState` was hidden. */
    hiddenTicks: number
    hiddenMaxGapMs: number
    speech: boolean
  }
}

/** Minimal view of the voice engine the ducker follows. */
export interface DuckSource {
  subscribe(listener: () => void): () => void
  getSnapshot(): {
    status: string
    speaking: readonly number[]
    remoteAudio: readonly { userId: number }[]
    transmitting: boolean
  }
}

export class Ducker {
  private prefs: DuckPrefs
  private othersSpeaking = false
  private selfSpeaking = false
  /** When speech (as counted) last stopped; null while it goes on or never was. */
  private endedAt: number | null = null
  private speech = false
  private readonly depth: Record<DuckClass, DepthRamp> = { share: new DepthRamp(), music: new DepthRamp() }
  private readonly targets = new Map<number, { cls: DuckClass; apply: Apply; last: number }>()
  private nextId = 1
  private timer: unknown = null
  private lastTick: number | null = null

  constructor(
    prefs: DuckPrefs = DEFAULT_DUCK_PREFS,
    private readonly clock: DuckerClock = realClock,
  ) {
    this.prefs = prefs
  }

  /** The current gain factor of a class (1 = untouched). */
  factor(cls: DuckClass, now = this.clock.now()): number {
    return 1 - this.depth[cls].at(now)
  }

  /** Register a stream's gain setter; called at once with the current factor. Returns the unregister. */
  add(cls: DuckClass, apply: Apply): () => void {
    const id = this.nextId++
    const factor = this.factor(cls)
    this.targets.set(id, { cls, apply, last: factor })
    apply(factor)
    return () => {
      this.targets.delete(id)
    }
  }

  setPrefs(prefs: DuckPrefs): void {
    this.prefs = prefs
    this.update()
  }

  /** Who speaks now: anybody else, and me. */
  setSpeaking(others: boolean, self: boolean): void {
    if (others === this.othersSpeaking && self === this.selfSpeaking) return
    this.othersSpeaking = others
    this.selfSpeaking = self
    this.update()
  }

  /** Follow a voice engine's speaking set. Returns the unsubscribe. */
  follow(source: DuckSource): () => void {
    const read = () => {
      const snapshot = source.getSnapshot()
      if (snapshot.status === 'idle') {
        this.setSpeaking(false, false)
        return
      }
      const remote = new Set(snapshot.remoteAudio.map((media) => media.userId))
      let others = false
      let self = false
      for (const id of snapshot.speaking) {
        if (remote.has(id)) others = true
        else self = true
      }
      // My own ring needs the microphone actually sent (muted, PTT closed: not speaking).
      this.setSpeaking(others, self && snapshot.transmitting)
    }
    read()
    const off = source.subscribe(read)
    return () => {
      off()
      this.setSpeaking(false, false)
    }
  }

  /** Re-evaluate targets, push factors, keep the timer running while anything moves. */
  update(now = this.clock.now()): void {
    const counted = this.othersSpeaking || (this.prefs.self && this.selfSpeaking)
    if (counted) {
      this.speech = true
      this.endedAt = null
    } else if (this.speech) {
      this.speech = false
      this.endedAt = now
    }
    const holding = this.endedAt !== null && now - this.endedAt < DUCK_HOLD_MS
    const ducked = this.speech || holding
    for (const cls of ['share', 'music'] as const) {
      const on = this.prefs.enabled && (cls === 'share' || this.prefs.music)
      this.depth[cls].retarget(ducked && on ? this.prefs.amount : 0, now)
    }
    for (const target of this.targets.values()) {
      const factor = this.factor(target.cls, now)
      if (factor === target.last) continue
      target.last = factor
      target.apply(factor)
    }
    this.probe(now)
    const busy = holding || this.depth.share.moving(now) || this.depth.music.moving(now)
    if (busy && this.timer === null) {
      this.lastTick = now
      this.timer = this.clock.setInterval(() => this.tick(), DUCK_TICK_MS)
    } else if (!busy && this.timer !== null) {
      this.clock.clearInterval(this.timer)
      this.timer = null
      this.lastTick = null
    }
  }

  private tick(): void {
    const now = this.clock.now()
    const w = globalThis as DuckProbe
    if (w.__trioDuckProbe && w.__trioDuck && this.lastTick !== null) {
      const gap = now - this.lastTick
      w.__trioDuck.ticks += 1
      w.__trioDuck.maxGapMs = Math.max(w.__trioDuck.maxGapMs, gap)
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        w.__trioDuck.hiddenTicks += 1
        w.__trioDuck.hiddenMaxGapMs = Math.max(w.__trioDuck.hiddenMaxGapMs, gap)
      }
    }
    this.lastTick = now
    this.update(now)
  }

  /** Is a ramp or a hold in progress (the timer is running)? For tests. */
  get running(): boolean {
    return this.timer !== null
  }

  private probe(now: number): void {
    const w = globalThis as DuckProbe
    if (!w.__trioDuckProbe) return
    w.__trioDuck ??= { share: 1, music: 1, ticks: 0, maxGapMs: 0, hiddenTicks: 0, hiddenMaxGapMs: 0, speech: false }
    w.__trioDuck.share = this.factor('share', now)
    w.__trioDuck.music = this.factor('music', now)
    w.__trioDuck.speech = this.speech || this.endedAt !== null
  }
}

/** One per page, following the settings. */
export const duckPrefsStore = new DuckPrefsStore()
export const ducker = new Ducker(duckPrefsStore.getSnapshot())
duckPrefsStore.subscribe(() => ducker.setPrefs(duckPrefsStore.getSnapshot()))
