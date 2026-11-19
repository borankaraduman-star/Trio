import { ContextKeeper } from './contextKeeper'
import { analyserSizeFor } from './speaking'

/**
 * The outgoing microphone, as ONE graph (CONTRACT-V2 §4):
 *
 *     microphone ──► [RNNoise worklet] ──► gate (mute · PTT) ──► sent track
 *
 * Everything that changes what the others hear acts here: the mute button,
 * push-to-talk, the noise-suppression toggle and a device change. The sent
 * track (`stream`) keeps its identity across all of them, so the peer
 * connections never renegotiate; only when the graph itself is unavailable
 * (no Web Audio, a context that will not run) is the raw microphone sent, and
 * then a device change replaces it through `onTrackReplaced`, which the
 * engine turns into `RTCRtpSender.replaceTrack`.
 *
 * The speaking indicator listens to `stream`, i.e. to what is actually sent:
 * gated means silent.
 *
 * Built-in noise suppression: while RNNoise is running the browser's own
 * `noiseSuppression` constraint is turned OFF (echo cancellation and gain
 * control stay on). Two suppressors in series smear consonants and pump the
 * noise floor, and RNNoise was trained on unprocessed noisy speech. When
 * RNNoise is off — by choice or because it failed to load — the browser's
 * suppressor is turned back on, so "off" means the v1 behaviour, and a
 * fallback is never worse than v1.
 */

export type NoiseState = 'off' | 'active' | 'unavailable'

export interface PipelineOptions {
  /** '' = default device. */
  deviceId: string
  noiseSuppression: boolean
}

export interface PipelineDeps {
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>
  /** Null when Web Audio cannot be used: the raw microphone is sent. */
  createContext: () => AudioContext | null
  /** Resolves with a ready RNNoise node, or rejects. */
  createNoiseNode: (context: AudioContext) => Promise<AudioNode>
  /**
   * Calls `listener` on every device change (a microphone plugged in);
   * returns the unsubscribe. Default: `navigator.mediaDevices` `devicechange`.
   */
  watchDevices?: (listener: () => void) => () => void
  /** V6: creates the input gate node (lazy import of audio/gate by default). */
  createGateNode?: (context: AudioContext, thresholdLinear: number) => Promise<AudioWorkletNode>
}

/** V6 (CONTRACT-V6-VOICE §4): the input gate after RNNoise. */
export type GateState = 'off' | 'active' | 'unavailable'

async function defaultGateNode(context: AudioContext, thresholdLinear: number): Promise<AudioWorkletNode> {
  const { createGateNode } = await import('./gate')
  return createGateNode(context, thresholdLinear)
}

function defaultWatchDevices(listener: () => void): () => void {
  const media = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices
  if (!media?.addEventListener) return () => undefined
  media.addEventListener('devicechange', listener)
  return () => media.removeEventListener('devicechange', listener)
}

export function micConstraints(deviceId: string, browserNoiseSuppression: boolean): MediaStreamConstraints {
  return {
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      echoCancellation: true,
      noiseSuppression: browserNoiseSuppression,
      autoGainControl: true,
      channelCount: { ideal: 1 },
    },
  }
}

/** The effective gate: the track is sent only when neither mute nor PTT closes it. */
export function gateOpen(muted: boolean, pttOpen: boolean): boolean {
  return !muted && pttOpen
}

const CONTEXT_START_TIMEOUT_MS = 1500
const NOISE_LOAD_TIMEOUT_MS = 5000

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function stopTracks(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) {
    track.onended = null
    track.stop()
  }
}

function isDeviceMissing(error: unknown): boolean {
  const name = error instanceof Error ? error.name : ''
  return name === 'OverconstrainedError' || name === 'NotFoundError'
}

export class MicPipeline {
  /** What the peer connections send. Stable for the pipeline's life. */
  readonly stream: MediaStream
  /** Called when the sent track had to be swapped (raw mode only). */
  onTrackReplaced: ((track: MediaStreamTrack) => void) | null = null
  /** Called when `noiseState` or `deviceId` changes. */
  onChange: (() => void) | null = null

  private raw: MediaStream
  private source: MediaStreamAudioSourceNode | null = null
  private noiseNode: AudioNode | null = null
  private readonly context: AudioContext | null
  private readonly gain: GainNode | null
  private muted = false
  private pttOpen = true
  private wantNoise: boolean
  private state: NoiseState = 'off'
  private device: string
  /** The device the user chose (`device` may be the default it fell back to). */
  private wanted: string
  /** The microphone ended and could not be opened again: nothing is sent. */
  private lost = false
  private unwatchDevices: (() => void) | null = null
  /** 10b: resumes the graph's context after an interruption (iOS phone call). */
  private keeper: ContextKeeper | null = null
  private stopped = false
  /** Serialises device and noise changes so two at once cannot interleave. */
  private queue: Promise<void> = Promise.resolve()
  // V6: microphone ──► [RNNoise] ──► [gate] ──► mute·PTT gain, with a level tap before the gate.
  private gateNode: AudioWorkletNode | null = null
  private gateWanted: number | null = null
  private gateStateValue: GateState = 'off'
  private gateIsOpen = false
  private tap: AnalyserNode | null = null
  private tapData: Float32Array<ArrayBuffer> | null = null

  private constructor(
    private readonly deps: PipelineDeps,
    raw: MediaStream,
    context: AudioContext | null,
    options: PipelineOptions,
  ) {
    this.raw = raw
    this.context = context
    this.wantNoise = options.noiseSuppression
    this.device = options.deviceId
    this.wanted = options.deviceId
    if (context) {
      this.gain = context.createGain()
      const destination = context.createMediaStreamDestination()
      destination.channelCount = 1
      this.gain.connect(destination)
      this.stream = destination.stream
      try {
        this.tap = context.createAnalyser()
        this.tap.fftSize = analyserSizeFor(context.sampleRate, 100)
        this.tapData = new Float32Array(new ArrayBuffer(this.tap.fftSize * 4))
      } catch {
        this.tap = null
      }
    } else {
      this.gain = null
      this.stream = new MediaStream(raw.getAudioTracks())
    }
  }

  /** Opens the microphone. Rejects only when the microphone itself cannot be opened. */
  static async create(deps: PipelineDeps, options: PipelineOptions): Promise<MicPipeline> {
    let context: AudioContext | null = null
    try {
      context = deps.createContext()
      if (context) {
        await withTimeout(context.resume(), CONTEXT_START_TIMEOUT_MS, 'AudioContext start')
        if (context.state !== 'running') throw new Error(`AudioContext is ${context.state}`)
      }
    } catch (error) {
      // A context that does not run would send silence: send the raw microphone instead.
      console.warn('trio: Web Audio unavailable, sending the raw microphone', error)
      if (context) void context.close().catch(() => undefined)
      context = null
    }

    let noiseNode: AudioNode | null = null
    let state: NoiseState = 'off'
    if (options.noiseSuppression) {
      if (context) {
        try {
          noiseNode = await withTimeout(deps.createNoiseNode(context), NOISE_LOAD_TIMEOUT_MS, 'RNNoise load')
          state = 'active'
        } catch (error) {
          console.warn('trio: noise suppression unavailable, using the raw microphone', error)
          state = 'unavailable'
        }
      } else {
        state = 'unavailable'
      }
    }

    let raw: MediaStream
    let deviceId = options.deviceId
    try {
      raw = await MicPipeline.open(deps, deviceId, state !== 'active')
    } catch (error) {
      if (!deviceId || !isDeviceMissing(error)) {
        if (context) void context.close().catch(() => undefined)
        throw error
      }
      // The chosen device is gone: the default one is better than nothing.
      deviceId = ''
      try {
        raw = await MicPipeline.open(deps, '', state !== 'active')
      } catch (second) {
        if (context) void context.close().catch(() => undefined)
        throw second
      }
    }

    const pipeline = new MicPipeline(deps, raw, context, { ...options, deviceId })
    pipeline.wanted = options.deviceId
    if (context) {
      pipeline.keeper = ContextKeeper.watch(context)
      if (pipeline.keeper) pipeline.keeper.onChange = () => pipeline.onChange?.()
    }
    pipeline.noiseNode = noiseNode
    pipeline.state = state
    if (context) pipeline.connect()
    else pipeline.watchRaw()
    pipeline.applyGate()
    return pipeline
  }

  private static open(deps: PipelineDeps, deviceId: string, browserNoise: boolean): Promise<MediaStream> {
    return deps.getUserMedia(micConstraints(deviceId, browserNoise))
  }

  get noiseState(): NoiseState {
    return this.state
  }

  get deviceId(): string {
    return this.device
  }

  /** The device actually in use (its settings), for a dialog that wants to show it. */
  get rawTrack(): MediaStreamTrack | null {
    return this.raw.getAudioTracks()[0] ?? null
  }

  get sentTrack(): MediaStreamTrack | null {
    return this.stream.getAudioTracks()[0] ?? null
  }

  get usesGraph(): boolean {
    return this.context !== null
  }

  setMuted(muted: boolean): void {
    this.muted = muted
    this.applyGate()
  }

  setPttOpen(open: boolean): void {
    this.pttOpen = open
    this.applyGate()
  }

  get transmitting(): boolean {
    return gateOpen(this.muted, this.pttOpen) && !this.lost
  }

  /** The microphone ended and could not be opened again (finding 4). */
  get micLost(): boolean {
    return this.lost
  }

  /** Try to open the microphone again; resolves true when it is back (or was never lost). */
  retry(): Promise<boolean> {
    return this.enqueue(() => this.recover()).then(
      () => !this.lost,
      () => !this.lost,
    )
  }

  setDevice(deviceId: string): Promise<void> {
    return this.enqueue(async () => {
      this.wanted = deviceId
      if (deviceId === this.device && !this.lost) return
      await this.reopen(deviceId)
    })
  }

  setNoiseSuppression(on: boolean): Promise<void> {
    return this.enqueue(async () => {
      this.wantNoise = on
      if (on && this.state === 'active') return
      if (!on && this.state === 'off') return
      const browserNoiseBefore = this.state !== 'active'

      const context = this.context
      if (!on) {
        this.dropNoiseNode()
        this.state = 'off'
      } else if (!context) {
        this.state = 'unavailable'
      } else {
        try {
          this.noiseNode = await withTimeout(this.deps.createNoiseNode(context), NOISE_LOAD_TIMEOUT_MS, 'RNNoise load')
          if (this.stopped || !this.wantNoise) {
            this.dropNoiseNode()
            return
          }
          this.state = 'active'
        } catch (error) {
          console.warn('trio: noise suppression unavailable, using the raw microphone', error)
          this.state = 'unavailable'
        }
      }
      // The browser's own suppressor follows (see the module comment): reopen with it flipped.
      if (browserNoiseBefore !== (this.state !== 'active')) await this.reopen(this.device)
      else {
        this.disconnect()
        this.connect()
      }
      this.onChange?.()
    })
  }

  /** Releases the microphone and the graph. The sent track ends. */
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.unwatchDevices?.()
    this.unwatchDevices = null
    this.keeper?.stop()
    this.keeper = null
    this.disconnect()
    this.dropNoiseNode()
    this.dropGateNode()
    stopTracks(this.raw)
    stopTracks(this.stream)
    if (this.context) void this.context.close().catch(() => undefined)
  }

  // --- V6: input gate and level ---------------------------------------------

  get gateState(): GateState {
    return this.gateStateValue
  }

  /** The gate lets sound through now (always true while it is off). */
  get gateOpen(): boolean {
    return this.gateStateValue !== 'active' || this.gateIsOpen
  }

  /**
   * The loudest sample of the last ~150 ms after RNNoise and BEFORE the gate
   * and the mute (0..1); null without the graph. The settings' level bar and
   * the AFK speech check read it.
   */
  inputPeak(): number | null {
    const tap = this.tap
    const data = this.tapData
    if (!tap || !data) return null
    tap.getFloatTimeDomainData(data)
    let peak = 0
    for (let i = 0; i < data.length; i++) {
      const v = data[i] < 0 ? -data[i] : data[i]
      if (v > peak) peak = v
    }
    return peak
  }

  /**
   * The gate's threshold as a peak amplitude, or null for "Otomatik" (no gate,
   * nothing added to the path). The sent track stays the same object; a gate
   * that cannot be loaded leaves the microphone ungated (`unavailable`).
   */
  setGate(thresholdLinear: number | null): Promise<void> {
    this.gateWanted = thresholdLinear
    return this.enqueue(async () => {
      const wanted = this.gateWanted
      const context = this.context
      const gain = this.gain
      if (wanted === null || !context || !gain) {
        if (this.gateNode) {
          this.disconnect()
          this.dropGateNode()
          this.connect()
        }
        this.gateStateValue = wanted === null ? 'off' : 'unavailable'
        this.onChange?.()
        return
      }
      if (this.gateNode) {
        this.gateNode.port.postMessage({ threshold: wanted })
        return
      }
      let node: AudioWorkletNode
      try {
        node = await withTimeout(
          (this.deps.createGateNode ?? defaultGateNode)(context, wanted),
          NOISE_LOAD_TIMEOUT_MS,
          'gate load',
        )
      } catch (error) {
        console.warn('trio: the input gate could not be loaded; sending without it', error)
        this.gateStateValue = 'unavailable'
        this.onChange?.()
        return
      }
      if (this.stopped || this.gateWanted === null) {
        node.disconnect()
        return
      }
      node.port.postMessage({ threshold: this.gateWanted })
      node.port.onmessage = (event: MessageEvent<{ open?: unknown }>) => {
        if (typeof event.data?.open !== 'boolean' || this.gateNode !== node) return
        this.gateIsOpen = event.data.open
        this.onChange?.()
      }
      node.onprocessorerror = () => {
        console.warn('trio: the input gate stopped working; sending without it')
        if (this.gateNode !== node) return
        this.disconnect()
        this.dropGateNode()
        this.gateStateValue = 'unavailable'
        this.connect()
        this.onChange?.()
      }
      this.disconnect()
      this.gateNode = node
      node.connect(gain)
      this.gateIsOpen = false
      this.gateStateValue = 'active'
      this.connect()
      this.onChange?.()
    })
  }

  private dropGateNode(): void {
    const node = this.gateNode
    this.gateNode = null
    this.gateIsOpen = false
    if (!node) return
    node.port.onmessage = null
    node.onprocessorerror = null
    try {
      node.disconnect()
    } catch {
      // Gone already.
    }
  }

  // --- internals -------------------------------------------------------------

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(() => (this.stopped ? undefined : task()))
    this.queue = run.catch((error: unknown) => console.warn('trio: microphone change failed', error))
    return run
  }

  private async reopen(deviceId: string): Promise<void> {
    let next: MediaStream
    let usedDevice = deviceId
    try {
      next = await MicPipeline.open(this.deps, deviceId, this.state !== 'active')
    } catch (error) {
      if (!deviceId || !isDeviceMissing(error)) throw error
      usedDevice = ''
      next = await MicPipeline.open(this.deps, '', this.state !== 'active')
    }
    if (this.stopped) {
      stopTracks(next)
      return
    }
    const old = this.raw
    this.disconnect()
    this.raw = next
    this.device = usedDevice
    this.setLost(false)
    if (this.context) {
      this.connect()
    } else {
      this.watchRaw()
      // Raw mode: the sent stream keeps its id, its track is swapped.
      const track = next.getAudioTracks()[0]
      for (const oldTrack of this.stream.getAudioTracks()) this.stream.removeTrack(oldTrack)
      if (track) {
        this.stream.addTrack(track)
        this.onTrackReplaced?.(track)
      }
    }
    this.applyGate()
    stopTracks(old)
    this.onChange?.()
  }

  /**
   * The device went away (unplugged, permission revoked): open it again (the
   * chosen one, else the default). When that fails too, the pipeline is
   * `micLost` and says so (`onChange`) instead of carrying on as if
   * connected, and it tries again on every device change (finding 4).
   */
  private watchRaw(): void {
    const raw = this.raw
    for (const track of raw.getAudioTracks()) {
      track.onended = () => {
        if (this.stopped || this.raw !== raw) return
        console.warn('trio: microphone ended, opening it again')
        void this.enqueue(() => this.recover())
      }
    }
  }

  /** Open the microphone again after it ended; on failure mark it lost. Never rejects. */
  private async recover(): Promise<void> {
    if (this.stopped) return
    const live = this.raw.getAudioTracks().some((track) => track.readyState === 'live')
    if (live && !this.lost) return
    try {
      await this.reopen(this.wanted)
    } catch (error) {
      console.warn('trio: the microphone could not be opened again', error)
      if (this.stopped) return
      // The ended source sends nothing: take it out of the graph.
      this.disconnect()
      this.setLost(true)
    }
  }

  private setLost(lost: boolean): void {
    if (this.lost === lost) return
    this.lost = lost
    if (lost) {
      const watch = this.deps.watchDevices ?? defaultWatchDevices
      this.unwatchDevices ??= watch(() => {
        if (this.lost && !this.stopped) void this.enqueue(() => this.recover())
      })
    } else {
      this.unwatchDevices?.()
      this.unwatchDevices = null
    }
    this.applyGate()
    this.onChange?.()
  }

  private connect(): void {
    this.watchRaw()
    const context = this.context
    const gain = this.gain
    if (!context || !gain) return
    try {
      this.source = context.createMediaStreamSource(this.raw)
    } catch (error) {
      console.warn('trio: could not read the microphone through Web Audio', error)
      this.source = null
      return
    }
    // V6: the gate (when on) sits between RNNoise and the mute gain; the level tap before it.
    const next: AudioNode = this.gateNode ?? gain
    const head: AudioNode = this.noiseNode ?? this.source
    if (this.tap) head.connect(this.tap)
    if (this.noiseNode) {
      this.source.connect(this.noiseNode)
      this.noiseNode.connect(next)
      const node = this.noiseNode as AudioNode & { onprocessorerror?: (() => void) | null }
      // A crashing processor outputs silence; bypass it rather than go mute.
      node.onprocessorerror = () => {
        console.warn('trio: noise suppression stopped working, using the raw microphone')
        this.disconnect()
        this.dropNoiseNode()
        this.state = 'unavailable'
        this.connect()
        this.onChange?.()
      }
    } else {
      this.source.connect(next)
    }
  }

  private disconnect(): void {
    try {
      this.source?.disconnect()
    } catch {
      // Already disconnected.
    }
    try {
      this.noiseNode?.disconnect()
    } catch {
      // Already disconnected.
    }
    this.source = null
  }

  private dropNoiseNode(): void {
    const node = this.noiseNode as (AudioNode & { destroy?: () => void }) | null
    this.noiseNode = null
    if (!node) return
    try {
      node.disconnect()
      node.destroy?.()
    } catch {
      // Gone already.
    }
  }

  private applyGate(): void {
    const open = gateOpen(this.muted, this.pttOpen) && !this.lost
    if (this.gain && this.context) {
      // A 5 ms ramp: no click when the gate opens or closes.
      this.gain.gain.setTargetAtTime(open ? 1 : 0, this.context.currentTime, 0.005)
    }
    // The sent track itself too: a disabled track sends true silence (and
    // keeps the v1 meaning of mute: `track.enabled = false`).
    for (const track of this.stream.getAudioTracks()) track.enabled = open
  }
}
