import { ContextKeeper } from './audio/contextKeeper'
import { MicPipeline, type NoiseState } from './audio/pipeline'
import { displayMediaOptions } from './audio/screenAudio'
import { classifyStreams, EMPTY_META, parseMeta, sameMeta } from './lib/streamMeta'
import type { ClientEvent, ServerEvent, SignalData, StreamMeta } from './types'

export interface RemoteMedia {
  userId: number
  stream: MediaStream
}

export type VoiceStatus = 'idle' | 'joining' | 'connected'

/**
 * The media connection to one other member (review finding 10a):
 * `connecting` until ICE first connects, `connected`, `reconnecting` while an
 * ICE restart (or a fresh connection) is under way, `failed` after the
 * bounded restarts gave up (it keeps retrying slowly; the network between the
 * two may need a TURN server).
 */
export type PeerHealth = 'connecting' | 'connected' | 'reconnecting' | 'failed'

export interface VoiceSnapshot {
  /** The voice channel this tab is in, or joining. */
  channelId: number | null
  status: VoiceStatus
  muted: boolean
  deafened: boolean
  screensharing: boolean
  /** A Turkish sentence to show the user, or null. */
  error: string | null
  /** User ids (own included) whose audio is currently above the threshold. */
  speaking: readonly number[]
  /** One microphone stream per remote peer. */
  remoteAudio: readonly RemoteMedia[]
  /** Shared screens of remote peers. */
  remoteVideo: readonly RemoteMedia[]
  /** The screen this tab is sharing, for a local preview. */
  localScreen: MediaStream | null
  /** v2: this tab's camera is on. */
  camera: boolean
  /** v2: this tab's camera, for a local preview. */
  localCamera: MediaStream | null
  /** v2: cameras of remote peers. */
  remoteCamera: readonly RemoteMedia[]
  /** v2: RNNoise on the outgoing microphone. */
  noiseState: NoiseState
  /** v2: the microphone is actually being sent (not muted, PTT open). */
  transmitting: boolean
  /**
   * The microphone ended (unplugged, permission revoked) and could not be
   * opened again: nothing is sent. Retried on every device change and by
   * `retryMic()`.
   */
  micLost: boolean
  /** The connection to each other member, by user id. */
  peerHealth: Readonly<Record<number, PeerHealth>>
}

/** Shown for `micLost`. */
export const MIC_LOST_MESSAGE = 'Mikrofon bağlantısı kesildi'

/** v2: what the engine needs to know about the user's settings, read when needed. */
export interface VoiceMediaPrefs {
  micDeviceId: string
  cameraDeviceId: string
  noiseSuppression: boolean
  /** Share the screen's sound too (off by default: it can echo the call back, finding 9). */
  shareScreenAudio?: boolean
}

export interface VoiceDeps {
  myId: number
  /** Sends a frame on the WebSocket; false when it could not be sent. */
  send: (event: ClientEvent) => boolean
  fetchIce: () => Promise<RTCIceServer[]>
  /** v2: current device and noise-suppression choices. */
  prefs?: () => VoiceMediaPrefs
  /** v2: creates the RNNoise node (lazy import by default; tests may stub it). */
  createNoiseNode?: (context: AudioContext) => Promise<AudioNode>
}

interface Peer {
  id: number
  pc: RTCPeerConnection
  /** Perfect negotiation: the peer with the larger user id is polite. */
  polite: boolean
  makingOffer: boolean
  ignoreOffer: boolean
  settingRemoteAnswer: boolean
  /**
   * Signals from this peer, handled one at a time in arrival order. Handled
   * concurrently, a candidate's addIceCandidate can land between an implicit
   * rollback and our answer, and Chrome then never gathers a candidate for
   * the answer.
   */
  signals: Promise<void>
  // Turn-taking, so that the two sides never offer at once (see "turn-taking").
  /** Polite side: a `request` is out and no `grant` has come back yet. */
  awaitingGrant: boolean
  /** Polite side: the grant came while we were busy; offer once stable. */
  offerWhenStable: boolean
  /** Impolite side: the peer asked for a turn we could not give yet. */
  requestPending: boolean
  /** Impolite side: we granted a turn and offer nothing until the peer's offer is answered. */
  holding: boolean
  /** Impolite side: a negotiation we put off while holding. */
  deferredOffer: boolean
  turnTimer: ReturnType<typeof setTimeout> | null
  screenSenders: RTCRtpSender[]
  /** v2: senders of our camera and microphone tracks on this connection. */
  cameraSenders: RTCRtpSender[]
  micSenders: RTCRtpSender[]
  /** Every remote stream seen on this connection, by id. */
  streams: Map<string, MediaStream>
  audio: MediaStream | null
  video: MediaStream | null
  /** v2: the remote camera stream, and the remote's last `meta` signal. */
  camera: MediaStream | null
  meta: StreamMeta
  /**
   * Stream ids an earlier `meta` named and a later one no longer does: that
   * camera or screen was stopped. Ignored from then on, so that its track,
   * still present until the removal offer is applied (or even re-announced by
   * an offer created just before the stop), is never shown, nor taken for a
   * screen by the "named by neither" fallback. Stream ids are never reused.
   */
  retired: Set<string>
  /** 10a: the state the UI shows, and the ICE restarts tried since it last connected. */
  health: PeerHealth
  iceAttempts: number
  healthTimer: ReturnType<typeof setTimeout> | null
  /**
   * V4 A1: the server holds this member's place while their socket is gone
   * (`reconnecting`): they cannot be signalled (`NOT_IN_VOICE`), but the media
   * between us may well still flow. Negotiations, ICE restarts and resets are
   * held until they are back, and nothing counts against them meanwhile.
   */
  reconnecting: boolean
  /** A negotiation came up while it could not be signalled; run it when it can. */
  negotiationWanted: boolean
  /** A fresh connection was wanted while it could not be signalled. */
  recoverWanted: boolean
}

interface Monitor {
  source: MediaStreamAudioSourceNode
  analyser: AnalyserNode
  data: Uint8Array<ArrayBuffer>
  lastLoudAt: number
}

/**
 * How long either side of a turn waits for the other before going ahead
 * anyway (a peer that does not take turns, or a lost frame). The fallback is
 * plain perfect negotiation.
 */
const TURN_TIMEOUT_MS = 4000

/** The server's cap on one signal's `data` (CONTRACT-V3 §6); a bigger one is refused. */
const SIGNAL_DATA_MAX_BYTES = 64 * 1024
/** A refused description is attributed to the last one sent within this time. */
const REFUSAL_WINDOW_MS = 10_000
/** At most this many fresh connections per peer in RESET_WINDOW_MS, so a failure cannot loop. */
const MAX_RESETS = 3
const RESET_WINDOW_MS = 120_000

/** 10a: connection health. */
const CONNECT_TIMEOUT_MS = 10_000
const DISCONNECTED_GRACE_MS = 3_000
const ICE_ATTEMPT_TIMEOUT_MS = 8_000
const MAX_ICE_RESTARTS = 3
const FAILED_RETRY_MS = 15_000

const SPEAKING_THRESHOLD = 0.02
const SPEAKING_HOLD_MS = 300
const SPEAKING_POLL_MS = 100

/** v2 camera constraints (CONTRACT-V2 §4). */
function cameraConstraints(deviceId: string): MediaStreamConstraints {
  return {
    video: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
  }
}

export function cameraErrorMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : ''
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Kamera izni verilmedi. Tarayıcı ayarlarından kameraya izin ver.'
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'Kamera bulunamadı.'
    case 'NotReadableError':
    case 'AbortError':
      return 'Kamera açılamadı. Başka bir uygulama kullanıyor olabilir.'
    default:
      return 'Kameraya erişilemedi.'
  }
}

const DEFAULT_PREFS: VoiceMediaPrefs = { micDeviceId: '', cameraDeviceId: '', noiseSuppression: true }

function createAudioContext(): AudioContext | null {
  const Context =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Context) return null
  // RNNoise works on 48 kHz frames; the browser resamples the microphone to it.
  return new Context({ sampleRate: 48000, latencyHint: 'interactive' })
}

async function defaultNoiseNode(context: AudioContext): Promise<AudioNode> {
  const { createRnnoiseNode } = await import('./audio/rnnoise')
  return createRnnoiseNode(context)
}

export function micErrorMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : ''
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Mikrofon izni verilmedi. Sesli kanala katılmak için tarayıcı ayarlarından mikrofona izin ver.'
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'Mikrofon bulunamadı. Bir mikrofon bağlayıp tekrar dene.'
    case 'NotReadableError':
    case 'AbortError':
      return 'Mikrofon açılamadı. Başka bir uygulama kullanıyor olabilir.'
    default:
      return 'Mikrofona erişilemedi.'
  }
}

/**
 * Pair epoch (see "fresh connections"): every signal of a pair after its
 * first reset carries `g`, and a signal of an older epoch is dropped. 0 (no
 * `g`) is the epoch of a pair that was never reset: the wire is unchanged.
 */
function signalEpoch(data: unknown): number {
  const g = typeof data === 'object' && data !== null ? (data as { g?: unknown }).g : undefined
  return typeof g === 'number' && Number.isSafeInteger(g) && g > 0 ? g : 0
}

/** `{reset: N}` (start epoch N with a fresh connection) or `{reset: 'request'}`. */
function parseReset(data: unknown): number | 'request' | null {
  if (typeof data !== 'object' || data === null) return null
  const reset = (data as { reset?: unknown }).reset
  if (reset === 'request') return reset
  return typeof reset === 'number' && Number.isSafeInteger(reset) && reset > 0 ? reset : null
}

type WireSignal =
  | SignalData
  | { meta: StreamMeta }
  | { reset: number | 'request'; why?: ResetReason }

/**
 * Why a pair starts again: `refused` (a description the server would not
 * relay) counts against MAX_RESETS; `resume` (a negotiation lost across a
 * signalling drop, CONTRACT-V4 A1) and `fresh` (one side has a new connection
 * for a resumed member) do not: they happen once per drop, not in a loop.
 */
type ResetReason = 'refused' | 'resume' | 'fresh'

function resetReason(data: unknown): ResetReason {
  const why = typeof data === 'object' && data !== null ? (data as { why?: unknown }).why : undefined
  return why === 'resume' || why === 'fresh' ? why : 'refused'
}

function parseSignal(data: unknown): SignalData | null {
  if (typeof data !== 'object' || data === null) return null
  const record = data as Record<string, unknown>
  if (typeof record.description === 'object' && record.description !== null) {
    const description = record.description as { type?: unknown }
    if (typeof description.type !== 'string') return null
    return { description: record.description as RTCSessionDescriptionInit }
  }
  if (record.negotiate === 'request' || record.negotiate === 'grant') {
    return { negotiate: record.negotiate }
  }
  if ('candidate' in record) {
    const candidate = record.candidate
    if (candidate === null) return { candidate: null }
    if (typeof candidate === 'object') return { candidate: candidate as RTCIceCandidateInit }
  }
  return null
}

function stopStream(stream: MediaStream | null): void {
  if (!stream) return
  for (const track of stream.getTracks()) {
    track.onended = null
    track.stop()
  }
}

/**
 * Ends what these senders send, for good, by STOPPING their transceivers.
 *
 * Not `removeTrack`: that only turns a transceiver to `recvonly`, it stays in
 * the description, and the next `addTrack` never reuses it (its receiving
 * direction is still in use by the other side's view). Every camera or
 * screen cycle then added m-lines; the offer grew ~5.4 KB per camera cycle
 * and on the 12th it passed the server's 64 KiB signal cap (review finding
 * 1). A stopped transceiver's m-line is rejected (port 0) in the next offer,
 * and once that is negotiated Chromium recycles the m-line for the next new
 * transceiver, so the description stays the size of what is live
 * (`e2e/tests/22-renegotiation-growth.spec.ts` measures it). Stopping goes
 * through `onnegotiationneeded`, so through the turn-taking, as removeTrack did.
 */
function stopSenders(pc: RTCPeerConnection, senders: readonly RTCRtpSender[]): void {
  if (senders.length === 0) return
  for (const transceiver of pc.getTransceivers()) {
    if (!senders.includes(transceiver.sender)) continue
    try {
      // removeTrack first: it lets go of the track at once (`sender.track`
      // is null now), while a stop alone keeps it until negotiated.
      pc.removeTrack(transceiver.sender)
      transceiver.stop()
    } catch {
      // The connection is already closed.
    }
  }
}

/**
 * Owns everything about voice in this tab: the microphone, one
 * RTCPeerConnection per other member of the channel (full mesh, perfect
 * negotiation), the shared screen, and speaking detection. Framework-free:
 * the UI subscribes and reads immutable snapshots.
 */
export class VoiceEngine {
  private readonly listeners = new Set<() => void>()
  private snapshot: VoiceSnapshot

  private channelId: number | null = null
  private status: VoiceStatus = 'idle'
  private muted = false
  private deafened = false
  private mutedBeforeDeafen = false
  private error: string | null = null

  /** Bumped by every join and leave, so that an await can tell it was overtaken. */
  private generation = 0
  /** `voice.join` has been sent on the current connection. */
  private joinSent = false
  private iceServers: RTCIceServer[] = []

  private micStream: MediaStream | null = null
  private screenStream: MediaStream | null = null
  /** v2: the microphone graph; `micStream` is its sent stream. */
  private pipeline: MicPipeline | null = null
  private cameraStream: MediaStream | null = null
  private cameraStarting = false
  /** v2: push-to-talk gate (true in activity mode). */
  private pttOpen = true
  private readonly peers = new Map<number, Peer>()
  /** V4 A1: members of my channel in the server's reconnect grace (`reconnecting`). */
  private readonly reconnectingIds = new Set<number>()
  /** Fresh connections: the pair epoch per peer, and when each reset happened. */
  private readonly pairEpochs = new Map<number, number>()
  private readonly resets = new Map<number, number[]>()
  /** The last description sent, so that a refusal (`error TOO_LARGE`) can be attributed. */
  private lastDescription: { peerId: number; at: number } | null = null
  /** 10b: resumes the speaking-detection context after an interruption. */
  private speakingKeeper: ContextKeeper | null = null

  private audioContext: AudioContext | null = null
  private readonly monitors = new Map<number, Monitor>()
  private speaking = new Set<number>()
  private speakingTimer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly deps: VoiceDeps) {
    this.snapshot = this.buildSnapshot()
  }

  // --- subscription --------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): VoiceSnapshot => this.snapshot

  private buildSnapshot(): VoiceSnapshot {
    const peers = [...this.peers.values()].sort((a, b) => a.id - b.id)
    const remoteAudio: RemoteMedia[] = []
    const remoteVideo: RemoteMedia[] = []
    const peerHealth: Record<number, PeerHealth> = {}
    for (const peer of peers) {
      peerHealth[peer.id] = peer.health
      if (peer.audio) remoteAudio.push({ userId: peer.id, stream: peer.audio })
      if (peer.video) remoteVideo.push({ userId: peer.id, stream: peer.video })
    }
    return {
      channelId: this.channelId,
      status: this.status,
      muted: this.muted,
      deafened: this.deafened,
      screensharing: this.screenStream !== null,
      error: this.error,
      speaking: [...this.speaking].sort((a, b) => a - b),
      remoteAudio,
      remoteVideo,
      localScreen: this.screenStream,
      camera: this.cameraStream !== null,
      localCamera: this.cameraStream,
      remoteCamera: peers
        .filter((peer) => peer.camera !== null)
        .map((peer) => ({ userId: peer.id, stream: peer.camera as MediaStream })),
      noiseState: this.pipeline?.noiseState ?? 'off',
      transmitting: this.pipeline?.transmitting ?? false,
      micLost: this.pipeline?.micLost ?? false,
      peerHealth,
    }
  }

  private emit(): void {
    this.snapshot = this.buildSnapshot()
    for (const listener of [...this.listeners]) listener()
  }

  // --- joining and leaving -------------------------------------------------

  async join(channelId: number): Promise<void> {
    if (this.status !== 'idle' && this.channelId === channelId) return
    if (this.status !== 'idle') this.leave()

    const generation = ++this.generation
    this.channelId = channelId
    this.status = 'joining'
    this.error = null
    this.emit()

    if (!navigator.mediaDevices?.getUserMedia) {
      this.fail('Bu tarayıcı mikrofona erişemiyor. Güvenli bağlantı (HTTPS) gerekir.')
      return
    }

    let pipeline: MicPipeline
    const prefs = this.prefs()
    try {
      pipeline = await MicPipeline.create(
        {
          getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
          createContext: createAudioContext,
          createNoiseNode: this.deps.createNoiseNode ?? defaultNoiseNode,
        },
        { deviceId: prefs.micDeviceId, noiseSuppression: prefs.noiseSuppression },
      )
    } catch (error) {
      if (generation === this.generation) this.fail(micErrorMessage(error))
      return
    }
    if (generation !== this.generation) {
      pipeline.stop()
      return
    }
    this.pipeline = pipeline
    pipeline.onChange = () => {
      if (this.pipeline === pipeline) this.emit()
    }
    pipeline.onTrackReplaced = (track) => {
      if (this.pipeline !== pipeline) return
      for (const peer of this.peers.values()) {
        for (const sender of peer.micSenders) void sender.replaceTrack(track).catch(() => undefined)
      }
    }
    const stream = pipeline.stream
    this.micStream = stream
    this.applyMute()
    this.startSpeakingDetection()
    this.watch(this.deps.myId, stream)

    await this.loadIce()
    // A `ready` that arrived meanwhile may already have sent the join.
    if (generation !== this.generation || this.joinSent) return

    if (!this.sendJoin()) {
      this.fail('Sunucu bağlantısı yok. Bağlantı gelince tekrar dene.')
    }
  }

  /** Leave the voice channel and release every device. Safe to call anytime. */
  leave(): void {
    this.generation += 1
    if (this.joinSent) this.deps.send({ type: 'voice.leave' })
    this.reset()
    this.emit()
  }

  /** Same as leave, for when the owner goes away. */
  destroy(): void {
    this.leave()
  }

  clearError(): void {
    if (this.error === null) return
    this.error = null
    this.emit()
  }

  /** Try to open the microphone again after it was lost (the notice's button). */
  async retryMic(): Promise<void> {
    await this.pipeline?.retry()
  }

  /** The WebSocket dropped: the server has already removed us from the channel. */
  handleDisconnected(): void {
    if (this.status === 'idle') return
    this.joinSent = false
    this.closeAllPeers()
    this.status = 'joining'
    this.emit()
  }

  /** A `ready` frame arrived: if we were in voice before the drop, go back in. */
  handleReady(): void {
    if (this.status === 'idle' || this.joinSent || !this.micStream) return
    void this.rejoin()
  }

  private async rejoin(): Promise<void> {
    const generation = this.generation
    this.closeAllPeers()
    await this.loadIce()
    if (generation !== this.generation || this.joinSent || this.status === 'idle') return
    // A failed send means the socket dropped again; the next `ready` retries.
    this.sendJoin()
  }

  private sendJoin(): boolean {
    if (this.channelId === null) return false
    const sent = this.deps.send({
      type: 'voice.join',
      channel_id: this.channelId,
      muted: this.muted,
      deafened: this.deafened,
      camera: this.cameraStream !== null,
    })
    this.joinSent = sent
    return sent
  }

  private async loadIce(): Promise<void> {
    try {
      this.iceServers = await this.deps.fetchIce()
    } catch (error) {
      // Without ICE servers only host candidates work (same network).
      console.warn('trio: could not load ICE servers', error)
      this.iceServers = []
    }
  }

  private fail(message: string): void {
    this.generation += 1
    if (this.joinSent) this.deps.send({ type: 'voice.leave' })
    this.reset()
    this.error = message
    this.emit()
  }

  private reset(): void {
    this.closeAllPeers()
    this.pipeline?.stop()
    this.pipeline = null
    stopStream(this.micStream)
    stopStream(this.screenStream)
    stopStream(this.cameraStream)
    this.micStream = null
    this.screenStream = null
    this.cameraStream = null
    this.stopSpeakingDetection()
    this.channelId = null
    this.status = 'idle'
    this.joinSent = false
  }

  // --- local controls ------------------------------------------------------

  setMuted(muted: boolean): void {
    // Speaking while deafened makes no sense: unmuting also undeafens.
    if (!muted && this.deafened) this.deafened = false
    this.muted = muted
    this.applyMute()
    this.sendState()
    this.emit()
  }

  toggleMute(): void {
    this.setMuted(!this.muted)
  }

  setDeafened(deafened: boolean): void {
    if (deafened === this.deafened) return
    if (deafened) {
      this.mutedBeforeDeafen = this.muted
      this.muted = true
    } else {
      this.muted = this.mutedBeforeDeafen
    }
    this.deafened = deafened
    this.applyMute()
    this.sendState()
    this.emit()
  }

  toggleDeafen(): void {
    this.setDeafened(!this.deafened)
  }

  private applyMute(): void {
    // The pipeline owns the sent track's gate (mute and PTT together).
    if (this.pipeline) {
      this.pipeline.setMuted(this.muted)
      this.pipeline.setPttOpen(this.pttOpen)
      return
    }
    for (const track of this.micStream?.getAudioTracks() ?? []) track.enabled = !this.muted
  }

  private sendState(): void {
    if (!this.joinSent) return
    this.deps.send({
      type: 'voice.state',
      muted: this.muted,
      deafened: this.deafened,
      screensharing: this.screenStream !== null,
      camera: this.cameraStream !== null,
    })
  }

  // --- screen sharing ------------------------------------------------------

  async toggleScreen(): Promise<void> {
    if (this.screenStream) this.stopScreen()
    else await this.startScreen()
  }

  async startScreen(): Promise<void> {
    if (this.status === 'idle' || this.screenStream) return
    if (!navigator.mediaDevices?.getDisplayMedia) {
      this.error = 'Bu tarayıcı ekran paylaşımını desteklemiyor.'
      this.emit()
      return
    }
    const generation = this.generation
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getDisplayMedia(
        displayMediaOptions(this.prefs().shareScreenAudio === true, navigator.mediaDevices.getSupportedConstraints?.() ?? {}),
      )
    } catch (error) {
      const name = error instanceof Error ? error.name : ''
      // Closing the picker is a decision, not a failure: say nothing. The
      // desktop app's picker rejects with AbortError, others differ, so ANY
      // rejection is treated as cancelled; unexpected ones are only logged.
      if (name !== 'NotAllowedError' && name !== 'AbortError') {
        console.warn('trio: screen share did not start', error)
      }
      return
    }
    // (Read through a method: the checks above the await no longer hold.)
    if (generation !== this.generation || this.isIdle() || this.screenStream) {
      stopStream(stream)
      return
    }

    this.screenStream = stream
    for (const track of stream.getTracks()) {
      // The browser's own "stop sharing" bar ends the track.
      track.onended = () => {
        if (this.screenStream === stream) this.stopScreen()
      }
    }
    // v2: tell every peer which stream is the screen BEFORE its tracks arrive.
    this.sendMetaToAll()
    for (const peer of this.peers.values()) this.addScreenTracks(peer)
    this.sendState()
    this.emit()
  }

  private isIdle(): boolean {
    return this.status === 'idle'
  }

  stopScreen(): void {
    const stream = this.screenStream
    if (!stream) return
    this.screenStream = null
    for (const peer of this.peers.values()) {
      stopSenders(peer.pc, peer.screenSenders)
      peer.screenSenders = []
    }
    stopStream(stream)
    this.sendMetaToAll()
    this.sendState()
    this.emit()
  }

  private addScreenTracks(peer: Peer): void {
    const stream = this.screenStream
    if (!stream) return
    // The audio track is optional: not every source or browser offers one.
    for (const track of stream.getTracks()) {
      if (track.readyState !== 'live') continue
      try {
        peer.screenSenders.push(peer.pc.addTrack(track, stream))
      } catch (error) {
        console.warn('trio: could not add screen track', error)
      }
    }
  }

  // --- v2: camera ------------------------------------------------------------

  async toggleCamera(): Promise<void> {
    if (this.cameraStream) this.stopCamera()
    else await this.startCamera()
  }

  async startCamera(): Promise<void> {
    if (this.status === 'idle' || this.cameraStream || this.cameraStarting) return
    if (!navigator.mediaDevices?.getUserMedia) {
      this.error = 'Bu tarayıcı kameraya erişemiyor.'
      this.emit()
      return
    }
    const generation = this.generation
    this.cameraStarting = true
    let stream: MediaStream
    try {
      stream = await this.openCamera(this.prefs().cameraDeviceId)
    } catch (error) {
      if (generation === this.generation) {
        this.error = cameraErrorMessage(error)
        this.emit()
      }
      return
    } finally {
      this.cameraStarting = false
    }
    if (generation !== this.generation || this.isIdle() || this.cameraStream) {
      stopStream(stream)
      return
    }
    this.cameraStream = stream
    this.watchCameraTracks(stream)
    // Which stream is the camera goes out BEFORE its track does (CONTRACT-V2 §4).
    this.sendMetaToAll()
    for (const peer of this.peers.values()) this.addCameraTracks(peer)
    this.sendState()
    this.emit()
  }

  /** Stops the camera and releases the device (its light goes off). */
  stopCamera(): void {
    const stream = this.cameraStream
    if (!stream) return
    this.cameraStream = null
    for (const peer of this.peers.values()) {
      stopSenders(peer.pc, peer.cameraSenders)
      peer.cameraSenders = []
    }
    stopStream(stream)
    this.sendMetaToAll()
    this.sendState()
    this.emit()
  }

  /** Switches the camera device while it is on, with replaceTrack: no renegotiation. */
  async setCameraDevice(deviceId: string): Promise<void> {
    const stream = this.cameraStream
    if (!stream) return
    let next: MediaStream
    try {
      next = await this.openCamera(deviceId)
    } catch (error) {
      console.warn('trio: could not switch the camera', error)
      return
    }
    const track = next.getVideoTracks()[0]
    if (this.cameraStream !== stream || !track) {
      stopStream(next)
      return
    }
    // The stream keeps its id (the peers know it from `meta`); only its track changes.
    const old = stream.getVideoTracks()
    for (const oldTrack of old) stream.removeTrack(oldTrack)
    stream.addTrack(track)
    this.watchCameraTracks(stream)
    for (const peer of this.peers.values()) {
      for (const sender of peer.cameraSenders) {
        if (sender.track?.kind === 'video' || sender.track === null) {
          void sender.replaceTrack(track).catch(() => undefined)
        }
      }
    }
    for (const oldTrack of old) {
      oldTrack.onended = null
      oldTrack.stop()
    }
    this.emit()
  }

  private async openCamera(deviceId: string): Promise<MediaStream> {
    try {
      return await navigator.mediaDevices.getUserMedia(cameraConstraints(deviceId))
    } catch (error) {
      const name = error instanceof Error ? error.name : ''
      // A remembered camera that is unplugged: the default one instead.
      if (deviceId && (name === 'OverconstrainedError' || name === 'NotFoundError')) {
        return navigator.mediaDevices.getUserMedia(cameraConstraints(''))
      }
      throw error
    }
  }

  private watchCameraTracks(stream: MediaStream): void {
    for (const track of stream.getVideoTracks()) {
      // Unplugged, or revoked by the system: the camera is off.
      track.onended = () => {
        if (this.cameraStream === stream) this.stopCamera()
      }
    }
  }

  private addCameraTracks(peer: Peer): void {
    const stream = this.cameraStream
    if (!stream) return
    for (const track of stream.getVideoTracks()) {
      if (track.readyState !== 'live') continue
      try {
        peer.cameraSenders.push(peer.pc.addTrack(track, stream))
      } catch (error) {
        console.warn('trio: could not add camera track', error)
      }
    }
  }

  // --- v2: stream identity -----------------------------------------------------

  private currentMeta(): StreamMeta {
    return { camera: this.cameraStream?.id ?? null, screen: this.screenStream?.id ?? null }
  }

  private sendMeta(peer: Peer): void {
    this.signal(peer.id, { meta: this.currentMeta() })
  }

  private sendMetaToAll(): void {
    for (const peer of this.peers.values()) this.sendMeta(peer)
  }

  // --- v2: microphone settings and push-to-talk ----------------------------------

  private prefs(): VoiceMediaPrefs {
    return this.deps.prefs?.() ?? DEFAULT_PREFS
  }

  /** Push-to-talk gate: local only, `voice.state.muted` does not change. */
  setPttOpen(open: boolean): void {
    if (open === this.pttOpen) return
    this.pttOpen = open
    this.pipeline?.setPttOpen(open)
    this.emit()
  }

  async setMicDevice(deviceId: string): Promise<void> {
    await this.pipeline?.setDevice(deviceId)
  }

  async setNoiseSuppression(on: boolean): Promise<void> {
    await this.pipeline?.setNoiseSuppression(on)
  }

  // --- server events -------------------------------------------------------

  handleEvent(event: ServerEvent): void {
    switch (event.type) {
      case 'voice.peers':
        if (!this.joinSent || event.channel_id !== this.channelId) return
        // Members in their reconnect grace are listed apart and are not
        // connected to: they come back with a voice.joined of their own.
        for (const peerId of event.reconnecting ?? []) this.markReconnecting(peerId, true)
        for (const peerId of event.peers) this.ensurePeer(peerId)
        return

      case 'voice.joined':
        if (!this.joinSent || event.channel_id !== this.channelId) return
        if (event.user_id === this.deps.myId) {
          if (this.status !== 'connected') {
            this.status = 'connected'
            // `voice.join` carries no screen flag; a rejoin while sharing says so now.
            if (this.screenStream) this.sendState()
            this.emit()
          }
        } else {
          const existing = this.peers.get(event.user_id)
          if (existing?.reconnecting) this.markReconnecting(event.user_id, false)
          else {
            this.reconnectingIds.delete(event.user_id)
            this.ensurePeer(event.user_id)
          }
        }
        return

      case 'voice.left':
        if (event.user_id === this.deps.myId) {
          // Only a CONFIRMED membership can be taken away (another tab joined).
          // While a join is on its way, this is the echo of the membership it
          // replaces and must not undo it.
          if (this.status === 'connected' && event.channel_id === this.channelId) {
            this.generation += 1
            this.reset()
            this.emit()
          }
          return
        }
        if (event.channel_id === this.channelId) {
          this.reconnectingIds.delete(event.user_id)
          this.closePeer(event.user_id)
        }
        return

      case 'voice.state': {
        if (event.channel_id !== this.channelId) return
        // V4 A1: the server's grace starts with `reconnecting: true`; it ends
        // with a voice.joined (or voice.left), but a later state saying false
        // ends it as well.
        if (event.reconnecting === true) this.markReconnecting(event.user_id, true)
        else if (this.reconnectingIds.has(event.user_id)) this.markReconnecting(event.user_id, false)
        const peer = this.peers.get(event.user_id)
        // v2: a camera turned off goes away now, as a stopped screen does.
        if (peer?.camera && event.camera === false) {
          peer.retired.add(peer.camera.id)
          peer.streams.delete(peer.camera.id)
          peer.camera = null
          this.emit()
        }
        if (event.screensharing) return
        if (peer?.video) {
          peer.streams.delete(peer.video.id)
          peer.video = null
          this.emit()
        }
        return
      }

      case 'signal': {
        if (!this.joinSent || event.from === this.deps.myId) return
        const reset = parseReset(event.data)
        if (reset !== null) {
          this.onReset(event.from, reset, event.data)
          return
        }
        // A signal of an earlier connection of this pair: it has nowhere to go.
        if (signalEpoch(event.data) !== (this.pairEpochs.get(event.from) ?? 0)) return
        const meta = parseMeta(event.data)
        const data = meta ? null : parseSignal(event.data)
        if (!meta && !data) return
        // Normally the peer exists already (voice.peers / voice.joined come
        // first); creating it here keeps a reordered frame from being lost.
        const peer = this.ensurePeer(event.from)
        if (!peer) return
        // ONE queue per peer for everything it signals, `meta` included. The
        // peer sends a `meta` before it adds the tracks it describes, so it
        // is ahead of the offer carrying them on the socket; queued with the
        // descriptions it is also APPLIED before that offer, and a later
        // `meta` (the camera turned off again) cannot overtake an offer
        // still waiting in the queue.
        peer.signals = peer.signals.then(() =>
          meta ? this.applyMeta(peer, meta) : data ? this.handleSignal(peer, data) : undefined,
        )
        return
      }

      case 'error':
        if (event.code === 'INVALID_CHANNEL' && this.joinSent && this.status === 'joining') {
          this.joinSent = false
          this.fail('Bu ses kanalına katılınamadı.')
        }
        // A description the server would not relay (over its size cap): that
        // negotiation is lost, and without it the pair can never take another
        // turn. Start the pair again on a fresh connection.
        if (event.code === 'TOO_LARGE') this.onDescriptionRefused((event as { to?: unknown }).to)
        return

      default:
        return
    }
  }

  // --- peer connections (perfect negotiation) -------------------------------

  private ensurePeer(peerId: number): Peer | null {
    if (peerId === this.deps.myId || this.status === 'idle') return null
    const existing = this.peers.get(peerId)
    if (existing) return existing

    let pc: RTCPeerConnection
    try {
      pc = new RTCPeerConnection({ iceServers: this.iceServers })
    } catch (error) {
      console.warn('trio: could not create a peer connection', error)
      return null
    }
    const peer: Peer = {
      id: peerId,
      pc,
      polite: this.deps.myId > peerId,
      makingOffer: false,
      ignoreOffer: false,
      settingRemoteAnswer: false,
      signals: Promise.resolve(),
      awaitingGrant: false,
      offerWhenStable: false,
      requestPending: false,
      holding: false,
      deferredOffer: false,
      turnTimer: null,
      screenSenders: [],
      cameraSenders: [],
      micSenders: [],
      streams: new Map(),
      audio: null,
      video: null,
      camera: null,
      meta: EMPTY_META,
      retired: new Set(),
      health: 'connecting',
      iceAttempts: 0,
      healthTimer: null,
      reconnecting: this.reconnectingIds.has(peerId),
      negotiationWanted: false,
      recoverWanted: false,
    }
    this.peers.set(peerId, peer)
    const alive = () => this.peers.get(peerId) === peer

    pc.onnegotiationneeded = () => {
      if (alive()) this.negotiationNeeded(peer)
    }

    pc.onsignalingstatechange = () => {
      if (alive() && pc.signalingState === 'stable') this.onStable(peer)
    }

    pc.onicecandidate = ({ candidate }) => {
      if (alive()) this.signal(peerId, { candidate: candidate ? candidate.toJSON() : null })
    }

    pc.onconnectionstatechange = () => {
      if (!alive()) return
      this.updateHealth(peer)
      // v2: (re)connected — repeat which stream is which; cheap and idempotent.
      if (pc.connectionState === 'connected') this.sendMeta(peer)
    }

    pc.ontrack = ({ streams }) => {
      if (!alive()) return
      for (const stream of streams) {
        if (peer.retired.has(stream.id)) continue
        peer.streams.set(stream.id, stream)
        stream.onremovetrack = () => {
          if (alive()) this.classifyStreams(peer)
        }
        stream.onaddtrack = () => {
          if (alive()) this.classifyStreams(peer)
        }
      }
      this.classifyStreams(peer)
    }

    // v2: which stream is which, BEFORE any track reaches the peer.
    this.sendMeta(peer)

    // Adding tracks is what triggers the first offer. Both sides do it at
    // once; turn-taking (below) keeps that from becoming a glare.
    if (this.micStream) {
      for (const track of this.micStream.getAudioTracks()) {
        peer.micSenders.push(pc.addTrack(track, this.micStream))
      }
    }
    this.addScreenTracks(peer)
    this.addCameraTracks(peer)
    this.updateHealth(peer)
    return peer
  }

  /**
   * v2: the peer's `meta` signal says which stream is the camera and which the
   * screen; a stream in neither is the screen when it has video (the v1 guess,
   * kept as the fallback) and the microphone when audio-only.
   */
  private classifyStreams(peer: Peer): void {
    for (const [id, stream] of peer.streams) {
      if (stream.getTracks().length === 0 || peer.retired.has(id)) {
        stream.onremovetrack = null
        stream.onaddtrack = null
        peer.streams.delete(id)
      }
    }
    const { audio, screen: video, camera } = classifyStreams(peer.streams.values(), peer.meta)
    if (audio === peer.audio && video === peer.video && camera === peer.camera) return
    if (audio !== peer.audio) {
      if (audio) this.watch(peer.id, audio)
      else this.unwatch(peer.id)
    }
    peer.audio = audio
    peer.video = video
    peer.camera = camera
    this.emit()
  }

  /** A `meta` signal, applied in its place in the peer's signal queue. */
  private applyMeta(peer: Peer, meta: StreamMeta): void {
    if (this.peers.get(peer.id) !== peer || sameMeta(peer.meta, meta)) return
    const named = new Set([meta.camera, meta.screen])
    for (const id of [peer.meta.camera, peer.meta.screen]) {
      if (id !== null && !named.has(id)) peer.retired.add(id)
    }
    peer.meta = meta
    this.classifyStreams(peer)
  }

  // --- turn-taking --------------------------------------------------------
  //
  // Perfect negotiation resolves two simultaneous offers by having the polite
  // side roll its own back. In Chrome (seen in 153) a rollback on a
  // connection that is already receiving audio leaves that audio track
  // silent for good: RTP keeps arriving and is decoded (getStats shows the
  // energy), but the MediaStreamTrack delivers only zeros, to an <audio>
  // element and WebAudio alike. Two people starting a screen share at the
  // same moment hit it, and so did every join (both sides add their
  // microphone at once). So offers take turns: the impolite side offers when
  // it likes; the polite side asks first (`request`), and the impolite side
  // answers `grant` when it is stable and then holds its own offers until the
  // polite side's offer has been answered. Every negotiation goes through
  // `onnegotiationneeded` and so through this: the microphone at connection
  // time, a screen share, the camera on or off (also both at once), an ICE
  // restart. Device and noise-suppression changes never renegotiate
  // (`replaceTrack`). A `meta` signal is sent before the tracks it describes
  // are added, so it always leaves before the offer that carries them, however
  // long that offer waits for its turn. Signal data stays opaque to the
  // server; a peer that does not answer a request is waited for TURN_TIMEOUT_MS,
  // after which plain perfect negotiation (with its rollback) takes over.

  /** The peer can be signalled now (V4 A1: not while it is in the server's grace). */
  private canSignal(peer: Peer): boolean {
    return this.joinSent && !peer.reconnecting
  }

  private negotiationNeeded(peer: Peer): void {
    // A negotiation the peer cannot hear about would sit in have-local-offer:
    // remember it and run it when the peer is back (see resumePeer).
    if (!this.canSignal(peer)) {
      peer.negotiationWanted = true
      return
    }
    if (peer.polite) {
      this.requestTurn(peer)
    } else if (peer.holding) {
      peer.deferredOffer = true
    } else {
      void this.makeOffer(peer)
    }
  }

  private async makeOffer(peer: Peer): Promise<void> {
    const { pc } = peer
    if (!this.canSignal(peer)) {
      peer.negotiationWanted = true
      return
    }
    try {
      peer.makingOffer = true
      await pc.setLocalDescription()
      if (this.peers.get(peer.id) === peer && pc.localDescription) {
        this.signal(peer.id, { description: pc.localDescription.toJSON() })
      }
    } catch (error) {
      if (this.peers.get(peer.id) === peer) console.warn('trio: negotiation failed', error)
    } finally {
      peer.makingOffer = false
    }
  }

  private setTurnTimer(peer: Peer, action: (() => void) | null): void {
    if (peer.turnTimer !== null) clearTimeout(peer.turnTimer)
    peer.turnTimer = null
    if (!action) return
    peer.turnTimer = setTimeout(() => {
      peer.turnTimer = null
      if (this.peers.get(peer.id) === peer) action()
    }, TURN_TIMEOUT_MS)
  }

  /** Polite side: ask the peer for a turn to offer. */
  private requestTurn(peer: Peer): void {
    if (peer.awaitingGrant || peer.offerWhenStable) return
    if (!this.canSignal(peer)) {
      peer.negotiationWanted = true
      return
    }
    peer.awaitingGrant = true
    this.signal(peer.id, { negotiate: 'request' })
    this.setTurnTimer(peer, () => {
      if (!peer.awaitingGrant) return
      peer.awaitingGrant = false
      void this.makeOffer(peer)
    })
  }

  /** Polite side: the turn is ours. */
  private onGrant(peer: Peer): void {
    if (!peer.awaitingGrant) return
    peer.awaitingGrant = false
    this.setTurnTimer(peer, null)
    // The offer covers every change made so far, including any made after the request.
    if (peer.pc.signalingState === 'stable' && !peer.makingOffer) void this.makeOffer(peer)
    else peer.offerWhenStable = true
  }

  /** Impolite side: give the peer its turn as soon as we are not negotiating ourselves. */
  private grantIfPossible(peer: Peer): void {
    if (!peer.requestPending || peer.holding || !this.canSignal(peer)) return
    if (peer.makingOffer || peer.pc.signalingState !== 'stable') return
    peer.requestPending = false
    peer.holding = true
    this.signal(peer.id, { negotiate: 'grant' })
    this.setTurnTimer(peer, () => this.releaseHold(peer))
  }

  /** Impolite side: the peer's turn is over (its offer is answered, or it never came). */
  private releaseHold(peer: Peer): void {
    if (!peer.holding) return
    peer.holding = false
    this.setTurnTimer(peer, null)
    if (peer.deferredOffer) {
      peer.deferredOffer = false
      void this.makeOffer(peer)
    } else {
      this.grantIfPossible(peer)
    }
  }

  private onStable(peer: Peer): void {
    if (peer.polite) {
      if (peer.offerWhenStable && !peer.makingOffer) {
        peer.offerWhenStable = false
        void this.makeOffer(peer)
      }
    } else {
      this.grantIfPossible(peer)
    }
  }

  private async handleSignal(peer: Peer, data: SignalData): Promise<void> {
    const { pc } = peer
    const alive = () => this.peers.get(peer.id) === peer
    try {
      if ('negotiate' in data) {
        if (data.negotiate === 'grant' && peer.polite) {
          this.onGrant(peer)
        } else if (data.negotiate === 'request' && !peer.polite) {
          if (peer.holding) {
            // The peer asked again (its first request or our grant was lost): grant again.
            this.signal(peer.id, { negotiate: 'grant' })
          } else {
            peer.requestPending = true
            this.grantIfPossible(peer)
          }
        }
      } else if ('description' in data) {
        const description = data.description
        const readyForOffer =
          !peer.makingOffer && (pc.signalingState === 'stable' || peer.settingRemoteAnswer)
        const offerCollision = description.type === 'offer' && !readyForOffer
        peer.ignoreOffer = !peer.polite && offerCollision
        if (peer.ignoreOffer) return

        peer.settingRemoteAnswer = description.type === 'answer'
        // For the polite side in a collision this rolls our own offer back.
        await pc.setRemoteDescription(description)
        peer.settingRemoteAnswer = false
        if (description.type === 'offer') {
          await pc.setLocalDescription()
          if (alive() && pc.localDescription) {
            this.signal(peer.id, { description: pc.localDescription.toJSON() })
          }
          // The offer we held for is answered: our own changes may go now.
          if (alive() && !peer.polite) this.releaseHold(peer)
        }
      } else {
        try {
          // Chrome wants `undefined`, not `null`, for end-of-candidates.
          await pc.addIceCandidate(data.candidate ?? undefined)
        } catch (error) {
          // Candidates of an offer we ignored have nowhere to go; that is expected.
          if (!peer.ignoreOffer) throw error
        }
      }
    } catch (error) {
      peer.settingRemoteAnswer = false
      if (alive()) console.warn('trio: signalling error', error)
    }
  }

  private signal(to: number, data: WireSignal): void {
    if (!this.joinSent) return
    // V4 A1: the server would answer NOT_IN_VOICE; what matters is redone on resume.
    if (this.peers.get(to)?.reconnecting) return
    const epoch = this.pairEpochs.get(to) ?? 0
    const stamped = epoch > 0 ? { ...data, g: epoch } : data
    if ('description' in data) {
      // Known to be refused: do not send it, start the pair again instead.
      if (new TextEncoder().encode(JSON.stringify(stamped)).length > SIGNAL_DATA_MAX_BYTES) {
        console.warn('trio: a session description is over the signal cap; starting the connection again')
        const peer = this.peers.get(to)
        if (peer) queueMicrotask(() => this.recoverPeer(peer))
        return
      }
      this.lastDescription = { peerId: to, at: Date.now() }
    }
    this.deps.send({ type: 'signal', to, data: stamped as SignalData })
  }

  // --- fresh connections ------------------------------------------------------
  //
  // A negotiation that can never complete (the server refused the
  // description as too large, review finding 1) leaves the connection in
  // `have-local-offer` for good, and turns are only granted when stable, so
  // nothing either side does would recover it. The pair then starts again on
  // NEW peer connections. Only the impolite side (the lower user id) starts a
  // pair again, so two resets can never cross; the polite side asks for one
  // with `{reset: 'request'}`. The impolite side sends `{reset: N}` and
  // creates its new connection; the polite side, on `{reset: N}`, drops its
  // own and creates a new one too. Both then add their tracks, which is the
  // ordinary join (turn-taking included). Every later signal of the pair
  // carries `g: N`, and anything from an older connection still on its way is
  // dropped by its epoch. Each side allows MAX_RESETS per RESET_WINDOW_MS per
  // peer; past that the peer is shown as failed instead of looping.

  /**
   * `to` is the peer the refused signal was for (CONTRACT-V3 §6). Without it
   * (a server from before that field) the refusal is taken for the last
   * description sent, if recent.
   */
  private onDescriptionRefused(to: unknown): void {
    let peerId: number | null = null
    if (typeof to === 'number') {
      peerId = to
    } else if (this.lastDescription && Date.now() - this.lastDescription.at <= REFUSAL_WINDOW_MS) {
      peerId = this.lastDescription.peerId
    }
    this.lastDescription = null
    const peer = peerId === null ? undefined : this.peers.get(peerId)
    if (peer) this.recoverPeer(peer)
  }

  private allowReset(peerId: number): boolean {
    const now = Date.now()
    const recent = (this.resets.get(peerId) ?? []).filter((at) => now - at < RESET_WINDOW_MS)
    if (recent.length >= MAX_RESETS) {
      this.resets.set(peerId, recent)
      return false
    }
    recent.push(now)
    this.resets.set(peerId, recent)
    return true
  }

  /** Start this pair again on fresh connections (or ask the impolite side to). */
  private recoverPeer(peer: Peer): void {
    if (this.peers.get(peer.id) !== peer) return
    // Unreachable now: the reset could not be heard. It is done on resume,
    // and an outage does not count against the peer's resets.
    if (!this.canSignal(peer)) {
      peer.recoverWanted = true
      return
    }
    if (!this.allowReset(peer.id)) {
      console.warn('trio: giving up on the connection to', peer.id)
      this.setHealthTimer(peer, null)
      peer.health = 'failed'
      this.emit()
      return
    }
    this.restartPair(peer, 'refused')
  }

  /** Start the pair again on fresh connections; counted by the caller (or not at all). */
  private restartPair(peer: Peer, why: ResetReason): void {
    const extra = why === 'refused' ? {} : { why }
    if (peer.polite) {
      this.signal(peer.id, { reset: 'request', ...extra })
      return
    }
    const epoch = (this.pairEpochs.get(peer.id) ?? 0) + 1
    this.pairEpochs.set(peer.id, epoch)
    this.signal(peer.id, { reset: epoch, ...extra })
    this.replacePeer(peer.id)
  }

  private onReset(peerId: number, reset: number | 'request', data: unknown): void {
    const polite = this.deps.myId > peerId
    if (reset === 'request') {
      const peer = this.peers.get(peerId)
      if (polite || !peer) return
      // A request made on a connection we have already replaced: the reset
      // that replaced it answers it.
      if (signalEpoch(data) < (this.pairEpochs.get(peerId) ?? 0)) return
      const why = resetReason(data)
      if (why === 'refused') this.recoverPeer(peer)
      else this.restartPair(peer, why)
      return
    }
    // Only the impolite side starts a new epoch, and epochs only grow.
    if (!polite || this.status === 'idle' || reset <= (this.pairEpochs.get(peerId) ?? 0)) return
    this.pairEpochs.set(peerId, reset)
    this.replacePeer(peerId)
  }

  private replacePeer(peerId: number): void {
    const old = this.peers.get(peerId)
    if (old) {
      this.peers.delete(peerId)
      this.disposePeer(old)
    }
    this.ensurePeer(peerId)
    this.emit()
  }

  // --- connection health (10a) -----------------------------------------------
  //
  // `failed` used to be the only trigger for an ICE restart, and nothing was
  // shown: without TURN a pair that could not connect just stayed silent. Now
  // a connection that does not connect within CONNECT_TIMEOUT_MS, stays
  // `disconnected` for DISCONNECTED_GRACE_MS, or fails, gets an ICE restart;
  // an ICE restart is a renegotiation, so `restartIce()` fires
  // `onnegotiationneeded` and goes through the turn-taking like every other
  // one. After MAX_ICE_RESTARTS attempts of ICE_ATTEMPT_TIMEOUT_MS each the
  // peer is `failed` (shown), and it is retried every FAILED_RETRY_MS, so a
  // network that recovers heals the pair by itself.

  private setHealthTimer(peer: Peer, ms: number | null, action?: () => void): void {
    if (peer.healthTimer !== null) clearTimeout(peer.healthTimer)
    peer.healthTimer = null
    if (ms === null || !action) return
    peer.healthTimer = setTimeout(() => {
      peer.healthTimer = null
      if (this.peers.get(peer.id) === peer) action()
    }, ms)
  }

  private setHealth(peer: Peer, health: PeerHealth): void {
    if (peer.health === health) return
    peer.health = health
    this.emit()
  }

  private updateHealth(peer: Peer): void {
    const state = peer.pc.connectionState
    if (state === 'connected') {
      peer.iceAttempts = 0
      this.setHealthTimer(peer, null)
      this.setHealth(peer, 'connected')
    } else if (!this.canSignal(peer)) {
      // An ICE restart is a negotiation: it waits until the peer can hear it.
      this.setHealthTimer(peer, null)
    } else if (state === 'failed') {
      this.recoverIce(peer)
    } else if (state === 'disconnected') {
      // Often a blip that heals by itself within a second or two.
      if (peer.healthTimer === null) this.setHealthTimer(peer, DISCONNECTED_GRACE_MS, () => this.recoverIce(peer))
    } else if (state === 'new' || state === 'connecting') {
      // An attempt is in progress; its deadline is running (or starts now).
      if (peer.healthTimer === null) this.setHealthTimer(peer, CONNECT_TIMEOUT_MS, () => this.recoverIce(peer))
    }
  }

  private recoverIce(peer: Peer): void {
    this.setHealthTimer(peer, null)
    if (!this.canSignal(peer)) return
    if (peer.pc.connectionState === 'connected' || peer.pc.connectionState === 'closed') {
      this.updateHealth(peer)
      return
    }
    if (peer.iceAttempts < MAX_ICE_RESTARTS) {
      peer.iceAttempts += 1
      this.setHealth(peer, 'reconnecting')
      this.setHealthTimer(peer, ICE_ATTEMPT_TIMEOUT_MS, () => this.recoverIce(peer))
    } else {
      this.setHealth(peer, 'failed')
      this.setHealthTimer(peer, FAILED_RETRY_MS, () => this.recoverIce(peer))
    }
    try {
      peer.pc.restartIce()
    } catch (error) {
      console.warn('trio: could not restart ICE', error)
    }
  }

  // --- V4 A1: a member in the server's reconnect grace ------------------------

  /**
   * `reconnecting` from the server: their socket dropped, their place is held
   * for 10 s. While it lasts nothing can be signalled to them, so health
   * checks, ICE restarts, resets and negotiations wait (and count nothing);
   * the media between us is left alone. When it ends (their voice.joined with
   * `resumed`), the pair is brought back in step: `resumePeer`.
   */
  private markReconnecting(peerId: number, on: boolean): void {
    if (on) this.reconnectingIds.add(peerId)
    else this.reconnectingIds.delete(peerId)
    const peer = this.peers.get(peerId)
    if (!peer || peer.reconnecting === on) return
    peer.reconnecting = on
    if (on) {
      this.setHealthTimer(peer, null)
      this.emit()
    } else {
      this.resumePeer(peer)
    }
  }

  /**
   * The peer can be signalled again after a drop (theirs or, CONTRACT-V4 A1,
   * ours). No offer was in flight across it as far as either side knows:
   * turn-taking starts over. A connection that is not live, or that sits in
   * the middle of a negotiation (an offer or answer that was lost), is
   * started again on fresh connections — never rolled back (CLAUDE.md).
   * Otherwise it is kept as it is: what changed meanwhile is negotiated now.
   */
  private resumePeer(peer: Peer): void {
    if (this.peers.get(peer.id) !== peer) return
    const wanted = peer.negotiationWanted || peer.awaitingGrant || peer.offerWhenStable || peer.deferredOffer
    this.setTurnTimer(peer, null)
    peer.awaitingGrant = false
    peer.offerWhenStable = false
    peer.requestPending = false
    peer.holding = false
    peer.deferredOffer = false
    peer.ignoreOffer = false
    peer.negotiationWanted = false
    const state = peer.pc.connectionState
    const live = state === 'connected' || state === 'connecting'
    if (peer.recoverWanted || !live || peer.pc.signalingState !== 'stable' || peer.makingOffer) {
      peer.recoverWanted = false
      this.restartPair(peer, 'resume')
      this.emit()
      return
    }
    this.sendMeta(peer)
    if (wanted) this.negotiationNeeded(peer)
    this.updateHealth(peer)
    this.emit()
  }

  private closePeer(peerId: number): void {
    const peer = this.peers.get(peerId)
    this.pairEpochs.delete(peerId)
    this.resets.delete(peerId)
    if (this.lastDescription?.peerId === peerId) this.lastDescription = null
    if (!peer) return
    this.peers.delete(peerId)
    this.disposePeer(peer)
    this.emit()
  }

  private closeAllPeers(): void {
    const peers = [...this.peers.values()]
    this.peers.clear()
    this.reconnectingIds.clear()
    this.pairEpochs.clear()
    this.resets.clear()
    this.lastDescription = null
    for (const peer of peers) this.disposePeer(peer)
  }

  private disposePeer(peer: Peer): void {
    const { pc } = peer
    this.setTurnTimer(peer, null)
    this.setHealthTimer(peer, null)
    pc.onnegotiationneeded = null
    pc.onicecandidate = null
    pc.onconnectionstatechange = null
    pc.onsignalingstatechange = null
    pc.ontrack = null
    for (const stream of peer.streams.values()) {
      stream.onremovetrack = null
      stream.onaddtrack = null
    }
    peer.streams.clear()
    peer.audio = null
    peer.video = null
    peer.camera = null
    peer.screenSenders = []
    peer.cameraSenders = []
    peer.micSenders = []
    this.unwatch(peer.id)
    try {
      pc.close()
    } catch {
      // Already closed.
    }
  }

  // --- speaking detection --------------------------------------------------

  private startSpeakingDetection(): void {
    if (!this.audioContext) {
      const Context =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Context) return
      try {
        this.audioContext = new Context()
      } catch {
        return
      }
    }
    void this.audioContext.resume().catch(() => undefined)
    this.speakingKeeper ??= ContextKeeper.watch(this.audioContext)
    if (!this.speakingTimer) {
      this.speakingTimer = setInterval(() => this.pollSpeaking(), SPEAKING_POLL_MS)
    }
  }

  private stopSpeakingDetection(): void {
    if (this.speakingTimer) clearInterval(this.speakingTimer)
    this.speakingTimer = null
    for (const userId of [...this.monitors.keys()]) this.unwatch(userId)
    this.speakingKeeper?.stop()
    this.speakingKeeper = null
    const context = this.audioContext
    this.audioContext = null
    if (context) void context.close().catch(() => undefined)
    this.speaking = new Set()
  }

  private watch(userId: number, stream: MediaStream): void {
    this.unwatch(userId)
    const context = this.audioContext
    if (!context || stream.getAudioTracks().length === 0) return
    try {
      const source = context.createMediaStreamSource(stream)
      const analyser = context.createAnalyser()
      analyser.fftSize = 512
      // Not connected to the destination: this only listens.
      source.connect(analyser)
      this.monitors.set(userId, {
        source,
        analyser,
        data: new Uint8Array(new ArrayBuffer(analyser.fftSize)),
        lastLoudAt: 0,
      })
    } catch (error) {
      console.warn('trio: speaking detection unavailable', error)
    }
  }

  private unwatch(userId: number): void {
    const monitor = this.monitors.get(userId)
    if (!monitor) return
    this.monitors.delete(userId)
    try {
      monitor.source.disconnect()
    } catch {
      // Already disconnected.
    }
    if (this.speaking.delete(userId)) this.speaking = new Set(this.speaking)
  }

  private pollSpeaking(): void {
    const now = Date.now()
    const next = new Set<number>()
    for (const [userId, monitor] of this.monitors) {
      monitor.analyser.getByteTimeDomainData(monitor.data)
      let sum = 0
      for (const sample of monitor.data) {
        const centered = (sample - 128) / 128
        sum += centered * centered
      }
      if (Math.sqrt(sum / monitor.data.length) > SPEAKING_THRESHOLD) monitor.lastLoudAt = now
      const silenced = userId === this.deps.myId && this.muted
      if (!silenced && now - monitor.lastLoudAt < SPEAKING_HOLD_MS) next.add(userId)
    }
    if (next.size === this.speaking.size && [...next].every((id) => this.speaking.has(id))) return
    this.speaking = next
    this.emit()
  }
}
