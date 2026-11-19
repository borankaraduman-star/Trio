/**
 * CONTRACT-V4 A4: the cue sounds — self mute/unmute, self deafen/undeafen,
 * somebody joined or left my room, and the ringtone. Synthesised with WebAudio
 * (short sine/triangle tones with a soft envelope): no audio files to license
 * or load, nothing fetched.
 *
 * They play in their OWN AudioContext, routed to the chosen OUTPUT device
 * (`AudioContext.setSinkId` where it exists). Nothing connects it to the
 * microphone graph (`audio/pipeline.ts`), so a cue never reaches the call;
 * the only way back in is acoustic, which the browser's echo cancellation
 * handles as for any other playback.
 *
 * Deafened, I hear no cues at all except the click of my own deafen and
 * undeafen (otherwise there is no feedback that the button did something),
 * and no ringtone — a ring still shows its band. "Rahatsız etme" silences the
 * ringtone only.
 *
 * `cueTones`/`ringTones`/`cueAudible` are pure and unit-tested; the player
 * schedules exactly what they return. Every cue it starts is announced as
 * a `trio-cue` window event ({kind, tones}), and the ringtone's end as
 * {kind: 'ring-stop'} — what the e2e probes count.
 */

export type CueKind = 'mute' | 'unmute' | 'deafen' | 'undeafen' | 'join' | 'leave' | 'ring'

export interface Tone {
  /** Hz. */
  freq: number
  /** Seconds after the cue starts. */
  start: number
  /** Seconds. */
  dur: number
  /** Peak gain before the master volume, 0–1. */
  gain: number
  type: OscillatorType
}

/** One ringtone period; the ring repeats it every RING_PERIOD_S for at most RING_MAX_S. */
export const RING_PERIOD_S = 2
export const RING_MAX_S = 20

function tone(freq: number, start: number, dur: number, gain = 0.5, type: OscillatorType = 'sine'): Tone {
  return { freq, start, dur, gain, type }
}

/** The tones of one cue (the ringtone: one period of it). */
export function cueTones(kind: CueKind): Tone[] {
  switch (kind) {
    case 'mute':
      return [tone(660, 0, 0.07), tone(440, 0.08, 0.09)]
    case 'unmute':
      return [tone(440, 0, 0.07), tone(660, 0.08, 0.09)]
    case 'deafen':
      return [tone(520, 0, 0.06, 0.45, 'triangle'), tone(330, 0.07, 0.12, 0.45, 'triangle')]
    case 'undeafen':
      return [tone(330, 0, 0.06, 0.45, 'triangle'), tone(520, 0.07, 0.12, 0.45, 'triangle')]
    case 'join':
      return [tone(523.25, 0, 0.09, 0.4), tone(783.99, 0.1, 0.16, 0.4)]
    case 'leave':
      return [tone(783.99, 0, 0.09, 0.4), tone(523.25, 0.1, 0.16, 0.4)]
    case 'ring':
      return ringTones()
  }
}

/** Two short double-chimes, then quiet until the period ends. */
export function ringTones(): Tone[] {
  return [
    tone(880, 0, 0.12, 0.45),
    tone(1108.73, 0.14, 0.18, 0.45),
    tone(880, 0.5, 0.12, 0.45),
    tone(1108.73, 0.64, 0.18, 0.45),
  ]
}

/** How many ring periods fit in `seconds` (the ring is looped up to RING_MAX_S). */
export function ringPeriods(seconds = RING_MAX_S): number {
  return Math.max(0, Math.floor(seconds / RING_PERIOD_S))
}

export interface CuePrefs {
  enabled: boolean
  /** 0–1. */
  volume: number
  deafened: boolean
}

/** Whether `kind` is heard at all under these preferences. */
export function cueAudible(kind: CueKind, prefs: CuePrefs): boolean {
  if (!prefs.enabled || !(prefs.volume > 0)) return false
  if (prefs.deafened) return kind === 'deafen' || kind === 'undeafen'
  return true
}

export interface CueEventDetail {
  kind: CueKind
  tones: number
}

type SinkContext = AudioContext & { setSinkId?: (id: string) => Promise<void>; sinkId?: string }

/** Plays cues; one per tab (module singleton `cues`). */
export class CuePlayer {
  private context: SinkContext | null = null
  private master: GainNode | null = null
  private prefs: CuePrefs = { enabled: true, volume: 0.6, deafened: false }
  private sinkId = ''
  private ringTimer: ReturnType<typeof setInterval> | null = null
  private ringStop: ReturnType<typeof setTimeout> | null = null
  private ringNodes: OscillatorNode[] = []

  constructor(private readonly createContext: () => AudioContext | null = defaultContext) {}

  setPrefs(prefs: CuePrefs): void {
    this.prefs = prefs
    if (this.master) this.master.gain.value = prefs.volume
    if (this.ringing && !cueAudible('ring', prefs)) this.stopRing()
  }

  /** The output device id ('' = default). */
  setOutput(deviceId: string): void {
    this.sinkId = deviceId
    this.applySink()
  }

  play(kind: Exclude<CueKind, 'ring'>): void {
    if (!cueAudible(kind, this.prefs)) return
    this.schedule(kind, cueTones(kind), 0)
  }

  get ringing(): boolean {
    return this.ringTimer !== null
  }

  /** Loop the ringtone for at most `maxSeconds` (RING_MAX_S); a second call restarts it. */
  startRing(maxSeconds = RING_MAX_S): void {
    this.stopRing()
    if (!cueAudible('ring', this.prefs)) return
    const periods = ringPeriods(maxSeconds)
    if (periods === 0) return
    let played = 0
    const once = () => {
      if (played >= periods) {
        this.stopRing()
        return
      }
      played += 1
      this.ringNodes.push(...this.schedule('ring', ringTones(), 0))
    }
    once()
    this.ringTimer = setInterval(once, RING_PERIOD_S * 1000)
    this.ringStop = setTimeout(() => this.stopRing(), maxSeconds * 1000)
  }

  stopRing(): void {
    const was = this.ringTimer !== null
    if (this.ringTimer !== null) clearInterval(this.ringTimer)
    if (this.ringStop !== null) clearTimeout(this.ringStop)
    this.ringTimer = null
    this.ringStop = null
    for (const node of this.ringNodes) {
      try {
        node.stop()
      } catch {
        // Already stopped.
      }
    }
    this.ringNodes = []
    if (was && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('trio-cue', { detail: { kind: 'ring-stop', tones: 0 } }))
    }
  }

  private ensureContext(): { context: AudioContext; master: GainNode } | null {
    if (!this.context) {
      const context = this.createContext() as SinkContext | null
      if (!context) return null
      this.context = context
      this.master = context.createGain()
      this.master.gain.value = this.prefs.volume
      this.master.connect(context.destination)
      this.applySink()
      // Autoplay rules may keep a context made without a gesture suspended:
      // the next touch or key on the page lets it play.
      if (typeof document !== 'undefined') {
        const wake = () => void context.resume().catch(() => undefined)
        document.addEventListener('pointerdown', wake, { capture: true })
        document.addEventListener('keydown', wake, { capture: true })
      }
    }
    if (this.context.state === 'suspended') void this.context.resume().catch(() => undefined)
    return this.master ? { context: this.context, master: this.master } : null
  }

  private applySink(): void {
    const context = this.context
    if (!context || typeof context.setSinkId !== 'function') return
    if ((context.sinkId ?? '') === this.sinkId) return
    context.setSinkId(this.sinkId).catch(() => {
      if (this.sinkId !== '') void context.setSinkId?.('').catch(() => undefined)
    })
  }

  private schedule(kind: CueKind, tones: readonly Tone[], offset: number): OscillatorNode[] {
    const graph = this.ensureContext()
    if (!graph) return []
    const { context, master } = graph
    const base = context.currentTime + 0.02 + offset
    const nodes: OscillatorNode[] = []
    for (const t of tones) {
      try {
        const osc = context.createOscillator()
        const env = context.createGain()
        osc.type = t.type
        osc.frequency.value = t.freq
        const at = base + t.start
        env.gain.setValueAtTime(0, at)
        env.gain.linearRampToValueAtTime(t.gain, at + 0.01)
        env.gain.setValueAtTime(t.gain, at + Math.max(0.01, t.dur - 0.03))
        env.gain.linearRampToValueAtTime(0, at + t.dur)
        osc.connect(env)
        env.connect(master)
        osc.onended = () => {
          osc.disconnect()
          env.disconnect()
        }
        osc.start(at)
        osc.stop(at + t.dur + 0.02)
        nodes.push(osc)
      } catch (error) {
        console.warn('trio: could not play a cue', error)
      }
    }
    if (typeof window !== 'undefined' && nodes.length > 0) {
      window.dispatchEvent(new CustomEvent<CueEventDetail>('trio-cue', { detail: { kind, tones: nodes.length } }))
    }
    return nodes
  }
}

function defaultContext(): AudioContext | null {
  const Context =
    typeof window === 'undefined'
      ? undefined
      : (window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
  if (!Context) return null
  try {
    return new Context({ latencyHint: 'interactive' })
  } catch {
    return null
  }
}

/** The tab's cue player. */
export const cues = new CuePlayer()
