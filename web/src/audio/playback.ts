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
 *     MediaStreamAudioSourceNode ─► GainNode (the slider) ─► DynamicsCompressor
 *       (a soft limiter: a boost must not clip) ─► GainNode (0 while deafened) ─► out
 *
 * `out` is the context's destination on the chosen output device
 * (`AudioContext.setSinkId`), or, where the context cannot choose one, a
 * MediaStreamAudioDestinationNode played by a detached <audio> element that
 * can (`HTMLMediaElement.setSinkId`, the existing path).
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
  limiter: DynamicsCompressorNode
  output: GainNode
  deafened: boolean
}

/** The soft limiter: transparent below -6 dBFS, a hard knee by 0 dBFS. */
function makeLimiter(context: AudioContext): DynamicsCompressorNode {
  const limiter = context.createDynamicsCompressor()
  limiter.threshold.value = -6
  limiter.knee.value = 6
  limiter.ratio.value = 20
  limiter.attack.value = 0.003
  limiter.release.value = 0.25
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
        output.connect(this.outNode ?? context.destination)
        route = { stream, source, volume: gain, limiter, output, deafened }
        this.routes.set(key, route)
        this.exposeTap(key, context, output)
      } catch (error) {
        console.warn('trio: could not route the stream through Web Audio', error)
        return false
      }
    }
    route.volume.gain.setTargetAtTime(volume, context.currentTime, 0.01)
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
    if (typeof context.setSinkId === 'function') {
      try {
        if (context.sinkId !== wanted) await context.setSinkId(wanted)
        this.useDestination(context, null)
        return
      } catch (error) {
        console.warn('trio: the boosted audio could not use the chosen output device', error)
        if (wanted !== '') {
          try {
            await context.setSinkId('')
          } catch {
            // Default it is.
          }
        }
      }
    }
    // No AudioContext.setSinkId: the default output is the destination; any
    // other goes out through an element that can choose it.
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
    if (node === null && this.outElement) {
      this.outElement.pause()
      this.outElement.srcObject = null
      this.outElement = null
      this.outNode = null
    }
    for (const route of this.routes.values()) {
      try {
        route.output.disconnect()
      } catch {
        // Not connected.
      }
      route.output.connect(node ?? context.destination)
    }
  }

  /** e2e: an analyser on each route's output (after volume, limiter and deafen). */
  private exposeTap(key: string, context: AudioContext, output: AudioNode): void {
    const w = globalThis as ProbeWindow
    if (!w.__trioVolumeProbe) return
    const analyser = context.createAnalyser()
    analyser.fftSize = 2048
    output.connect(analyser)
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
