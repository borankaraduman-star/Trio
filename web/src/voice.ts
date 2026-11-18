import { MicPipeline, type NoiseState } from './audio/pipeline'
import { classifyStreams, EMPTY_META, parseMeta, sameMeta } from './lib/streamMeta'
import type { ClientEvent, ServerEvent, SignalData, StreamMeta } from './types'

export interface RemoteMedia {
  userId: number
  stream: MediaStream
}

export type VoiceStatus = 'idle' | 'joining' | 'connected'

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
}

/** v2: what the engine needs to know about the user's settings, read when needed. */
export interface VoiceMediaPrefs {
  micDeviceId: string
  cameraDeviceId: string
  noiseSuppression: boolean
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
  // Turn-taking, so that the two sides never offer at once (see `negotiate`).
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
    for (const peer of peers) {
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
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
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
      for (const sender of peer.screenSenders) {
        try {
          peer.pc.removeTrack(sender)
        } catch {
          // The connection is already closed.
        }
      }
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
      for (const sender of peer.cameraSenders) {
        try {
          peer.pc.removeTrack(sender)
        } catch {
          // The connection is already closed.
        }
      }
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
    if (this.joinSent) this.deps.send({ type: 'signal', to: peer.id, data: { meta: this.currentMeta() } })
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
          this.ensurePeer(event.user_id)
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
        if (event.channel_id === this.channelId) this.closePeer(event.user_id)
        return

      case 'voice.state': {
        if (event.channel_id !== this.channelId) return
        const peer = this.peers.get(event.user_id)
        // v2: a camera turned off goes away now, as a stopped screen does.
        if (peer?.camera && event.camera === false) {
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
        const meta = parseMeta(event.data)
        if (meta) {
          const target = this.ensurePeer(event.from)
          if (target && !sameMeta(target.meta, meta)) {
            target.meta = meta
            this.classifyStreams(target)
          }
          return
        }
        const data = parseSignal(event.data)
        if (!data) return
        // Normally the peer exists already (voice.peers / voice.joined come
        // first); creating it here keeps a reordered frame from being lost.
        const peer = this.ensurePeer(event.from)
        if (peer) peer.signals = peer.signals.then(() => this.handleSignal(peer, data))
        return
      }

      case 'error':
        if (event.code === 'INVALID_CHANNEL' && this.joinSent && this.status === 'joining') {
          this.joinSent = false
          this.fail('Bu ses kanalına katılınamadı.')
        }
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
      if (alive() && pc.connectionState === 'failed') pc.restartIce()
      // v2: (re)connected — repeat which stream is which; cheap and idempotent.
      if (alive() && pc.connectionState === 'connected') this.sendMeta(peer)
    }

    pc.ontrack = ({ streams }) => {
      if (!alive()) return
      for (const stream of streams) {
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

    // Adding tracks is what triggers the first offer. Both sides do it; the
    // resulting glare is what perfect negotiation resolves.
    if (this.micStream) {
      for (const track of this.micStream.getAudioTracks()) {
        peer.micSenders.push(pc.addTrack(track, this.micStream))
      }
    }
    this.addScreenTracks(peer)
    this.addCameraTracks(peer)
    return peer
  }

  /**
   * v2: the peer's `meta` signal says which stream is the camera and which the
   * screen; a stream in neither is the screen when it has video (the v1 guess,
   * kept as the fallback) and the microphone when audio-only.
   */
  private classifyStreams(peer: Peer): void {
    for (const [id, stream] of peer.streams) {
      if (stream.getTracks().length === 0) {
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
  // polite side's offer has been answered. Signal data stays opaque to the
  // server; a peer that does not answer a request is waited for TURN_TIMEOUT_MS,
  // after which plain perfect negotiation (with its rollback) takes over.

  private negotiationNeeded(peer: Peer): void {
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
    if (!peer.requestPending || peer.holding) return
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

  private signal(to: number, data: SignalData): void {
    if (this.joinSent) this.deps.send({ type: 'signal', to, data })
  }

  private closePeer(peerId: number): void {
    const peer = this.peers.get(peerId)
    if (!peer) return
    this.peers.delete(peerId)
    this.disposePeer(peer)
    this.emit()
  }

  private closeAllPeers(): void {
    const peers = [...this.peers.values()]
    this.peers.clear()
    for (const peer of peers) this.disposePeer(peer)
  }

  private disposePeer(peer: Peer): void {
    const { pc } = peer
    this.setTurnTimer(peer, null)
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
    if (!this.speakingTimer) {
      this.speakingTimer = setInterval(() => this.pollSpeaking(), SPEAKING_POLL_MS)
    }
  }

  private stopSpeakingDetection(): void {
    if (this.speakingTimer) clearInterval(this.speakingTimer)
    this.speakingTimer = null
    for (const userId of [...this.monitors.keys()]) this.unwatch(userId)
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
