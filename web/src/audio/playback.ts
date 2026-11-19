/**
 * Per-person volume above 100 % (CONTRACT-V6-VOICE §3).
 *
 * 0–100 % is the media element's own `volume`: the path every remote
 * microphone has always taken. It is the path Chromium's echo canceller
 * hears (audio played through Web Audio is not an echo reference in
 * Chromium), so a person whose slider is at or below 100 % sounds exactly as
 * before for somebody on loudspeakers.
 *
 * Above 100 % an element cannot go, so that one stream is routed through Web
 * Audio instead, with its element kept attached but MUTED — in Chromium a
 * remote WebRTC stream only flows into Web Audio while some media element
 * plays it:
 *
 *     MediaStreamAudioSourceNode ─► GainNode (the slider, halved) ─► WaveShaper
 *       (a soft limiter: a boost must not clip) ─► GainNode (0 while deafened) ─► out
 *
 * `out` is the context's destination for the default output device; for any
 * other, a MediaStreamAudioDestinationNode played by a detached <audio>
 * element on that device (`HTMLMediaElement.setSinkId`, the existing path —
 * see applySink for why not `AudioContext.setSinkId`).
 *
 * The speaking detector reads the remote stream itself (voice.ts), so the
 * ring reflects what they send, not my slider. The cue sounds have their own
 * context (cues.ts) and never pass through here.
 */
import { ContextKeeper } from './contextKeeper'

type SinkContext = AudioContext & { setSinkId?: (id: string) => Promise<void>; sinkId?: string }
type SinkElement = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }

interface Route {
  stream: MediaStream
  source: MediaStreamAudioSourceNode
  volume: GainNode
  limiter: WaveShaperNode
  output: GainNode
  deafened: boolean
}

/**
 * The soft limiter's curve. Not a DynamicsCompressorNode: Chromium's applies
 * an automatic makeup gain, so a quiet voice at "150 %" came out at ~200 %
 * (measured in e2e 52). A WaveShaper is an exact identity below the knee.
 * Its input range is −1..1, so the slider's gain is applied HALVED before it
 * (`LIMITER_HEADROOM`) and the curve maps x back to y = 2x: identity up to
 * |y| = 0.5 (−6 dBFS), then a tanh knee that approaches full scale and never
 * passes it.
 */
export const LIMITER_HEADROOM = 2

export function limiterCurve(size = 4096): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(new ArrayBuffer(size * 4))
  const knee = 0.5
  for (let i = 0; i < size; i++) {
    const x = (i / (size - 1)) * 2 - 1
    const y = x * LIMITER_HEADROOM
    const magnitude = Math.abs(y)
    const shaped = magnitude <= knee ? magnitude : knee + (1 - knee) * Math.tanh((magnitude - knee) / (1 - knee))
    curve[i] = Math.sign(y) * shaped
  }
  return curve
}

function makeLimiter(context: AudioContext): WaveShaperNode {
  const limiter = context.createWaveShaper()
  limiter.curve = limiterCurve()
  limiter.oversample = '4x'
  return limiter
}

interface ProbeWindow {
  __trioVolumeProbe?: boolean
  __trioVolumeTaps?: Record<string, AnalyserNode>
}

export class PlaybackMixer {
  private context: SinkContext | null = null
  private keeper: ContextKeeper | null = null
  private failed = false
  private readonly routes = new Map<string, Route>()
  private sinkId = ''
  /** The fallback output (an element that can choose a device), when the context cannot. */
  private outElement: SinkElement | null = null
  private outNode: MediaStreamAudioDestinationNode | null = null
  /** Where the routes are connected now (null = the context's destination). */
  private target: MediaStreamAudioDestinationNode | null = null

  /** Web Audio is usable here (boosts above 100 % are possible). */
  get available(): boolean {
    if (this.failed) return false
    const w = globalThis as { AudioContext?: unknown; webkitAudioContext?: unknown }
    return typeof w.AudioContext === 'function' || typeof w.webkitAudioContext === 'function'
  }

  /** Play `stream` at `volume` (> 1) through Web Audio under `key`. Returns false if it cannot. */
  route(key: string, stream: MediaStream, volume: number, deafened: boolean): boolean {
    if (stream.getAudioTracks().length === 0) return false
    const context = this.ensureContext()
    if (!context) return false
    let route = this.routes.get(key)
    if (route && route.stream !== stream) {
      this.unroute(key)
      route = undefined
    }
    if (!route) {
      try {
        const source = context.createMediaStreamSource(stream)
        const gain = context.createGain()
        const limiter = makeLimiter(context)
        const output = context.createGain()
        source.connect(gain).connect(limiter).connect(output)
        output.connect(this.target ?? context.destination)
        route = { stream, source, volume: gain, limiter, output, deafened }
        this.routes.set(key, route)
        this.exposeTap(key, context, output)
      } catch (error) {
        console.warn('trio: could not route the stream through Web Audio', error)
        return false
      }
    }
    route.volume.gain.setTargetAtTime(volume / LIMITER_HEADROOM, context.currentTime, 0.01)
    route.deafened = deafened
    route.output.gain.setTargetAtTime(deafened ? 0 : 1, context.currentTime, 0.005)
    void context.resume().catch(() => undefined)
    return true
  }

  unroute(key: string): void {
    const route = this.routes.get(key)
    if (!route) return
    this.routes.delete(key)
    for (const node of [route.source, route.volume, route.limiter, route.output]) {
      try {
        node.disconnect()
      } catch {
        // Already disconnected.
      }
    }
    const taps = (globalThis as ProbeWindow).__trioVolumeTaps
    if (taps) delete taps[key]
  }

  /** Follow the output device chosen in the settings ('' = default). */
  setSink(sinkId: string): void {
    if (sinkId === this.sinkId) return
    this.sinkId = sinkId
    if (this.context) void this.applySink(this.context)
  }

  private ensureContext(): SinkContext | null {
    if (this.context) return this.context
    if (!this.available) return null
    try {
      const w = globalThis as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }
      const Context = (w.AudioContext ?? w.webkitAudioContext) as typeof AudioContext
      this.context = new Context({ latencyHint: 'interactive' }) as SinkContext
    } catch (error) {
      console.warn('trio: Web Audio unavailable; volume above 100 % is off', error)
      this.failed = true
      return null
    }
    this.keeper = ContextKeeper.watch(this.context)
    void this.applySink(this.context)
    return this.context
  }

  private async applySink(context: SinkContext): Promise<void> {
    const wanted = this.sinkId
    // The default output is the context's own destination; any other goes
    // out through an element that can choose it. NOT AudioContext.setSinkId,
    // although Chromium has it: a context moved to another output device got
    // only zeros from MediaStreamAudioSourceNodes of REMOTE WebRTC streams
    // (an oscillator in the same context played; a fresh context created with
    // that sinkId got zeros too; measured in e2e 52, Chromium 1243's build).
    if (wanted === '') {
      this.useDestination(context, null)
      return
    }
    if (!this.outNode) this.outNode = context.createMediaStreamDestination()
    if (!this.outElement) {
      this.outElement = new Audio() as SinkElement
      this.outElement.autoplay = true
    }
    this.outElement.srcObject = this.outNode.stream
    void this.outElement.play().catch(() => undefined)
    if (typeof this.outElement.setSinkId === 'function') {
      await this.outElement.setSinkId(wanted).catch(() => this.outElement?.setSinkId?.('').catch(() => undefined))
    }
    this.useDestination(context, this.outNode)
  }

  /** Reconnect every route to `node` (null = the context's destination). */
  private useDestination(context: AudioContext, node: MediaStreamAudioDestinationNode | null): void {
    const previous: AudioNode = this.target ?? context.destination
    const next: AudioNode = node ?? context.destination
    if (node === null && this.outElement) {
      this.outElement.pause()
      this.outElement.srcObject = null
      this.outElement = null
      this.outNode = null
    }
    this.target = node
    if (previous === next) return
    for (const route of this.routes.values()) {
      // Only that connection: the output also feeds the e2e tap.
      try {
        route.output.disconnect(previous)
      } catch {
        // Not connected there.
      }
      route.output.connect(next)
    }
  }

  /** Where boosted audio goes now: the context's own device, or the fallback element's. */
  get output(): { via: 'context' | 'element' | 'none'; sinkId: string } {
    if (!this.context) return { via: 'none', sinkId: this.sinkId }
    if (this.outElement) return { via: 'element', sinkId: (this.outElement as { sinkId?: string }).sinkId ?? '' }
    return { via: 'context', sinkId: this.context.sinkId ?? '' }
  }

  /** e2e: an analyser on each route's output (after volume, limiter and deafen). */
  private exposeTap(key: string, context: AudioContext, output: AudioNode): void {
    const w = globalThis as ProbeWindow
    if (!w.__trioVolumeProbe) return
    const analyser = context.createAnalyser()
    analyser.fftSize = 2048
    output.connect(analyser)
    ;(w as ProbeWindow & { __trioMixer?: PlaybackMixer }).__trioMixer = this
    w.__trioVolumeTaps ??= {}
    w.__trioVolumeTaps[key] = analyser
  }

  close(): void {
    for (const key of [...this.routes.keys()]) this.unroute(key)
    this.keeper?.stop()
    this.keeper = null
    const context = this.context
    this.context = null
    if (context) void context.close().catch(() => undefined)
  }
}

/** One mixer per page. */
export const playbackMixer = new PlaybackMixer()
