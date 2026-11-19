/**
 * Recording a voice message (CONTRACT-V6-MEDIA §4). The microphone is opened
 * with its OWN `getUserMedia`, never the call's: the call sends one stable
 * track through an audio graph (CLAUDE.md, "the sent microphone track never
 * changes"), and nothing here touches it, so a call keeps flowing while a
 * voice message is recorded. Chromium hands both captures the same device.
 *
 * The level is read every 50 ms from an analyser window of 4096 samples
 * (85 ms at 48 kHz), so no stretch of the recording falls between reads.
 */
import { LEVEL_INTERVAL_MS, MAX_RECORDING_MS, pickRecorderType, voiceFileName, waveformBars } from './voiceNote'

export interface Recording {
  file: File
  durationMs: number
  waveform: number[]
}

export class VoiceRecorder {
  private stream: MediaStream | null = null
  private recorder: MediaRecorder | null = null
  private context: AudioContext | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private chunks: Blob[] = []
  private levels: number[] = []
  private startedAt = 0
  private finished: Promise<Blob> | null = null
  private cancelled = false
  /** Latest peak level 0..1, for the live meter. */
  level = 0

  constructor(
    private readonly onTick: (elapsedMs: number, level: number) => void,
    /** The two minutes are up: the caller stops and sends. */
    private readonly onLimit: () => void,
  ) {}

  get elapsedMs(): number {
    return this.startedAt === 0 ? 0 : performance.now() - this.startedAt
  }

  async start(): Promise<void> {
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      throw Object.assign(new Error('no recorder'), { name: 'NotSupportedError' })
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
    if (this.cancelled) {
      this.release()
      return
    }
    const type = pickRecorderType((t) => MediaRecorder.isTypeSupported(t))
    this.recorder = new MediaRecorder(this.stream, type ? { mimeType: type } : undefined)
    const recorder = this.recorder
    this.finished = new Promise<Blob>((resolve) => {
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) this.chunks.push(event.data)
      }
      recorder.onstop = () => resolve(new Blob(this.chunks, { type: recorder.mimeType || type || 'audio/webm' }))
    })
    try {
      this.context = new AudioContext()
      const source = this.context.createMediaStreamSource(this.stream)
      const analyser = this.context.createAnalyser()
      analyser.fftSize = 4096
      source.connect(analyser)
      const data = new Float32Array(analyser.fftSize)
      this.timer = setInterval(() => {
        analyser.getFloatTimeDomainData(data)
        let peak = 0
        for (const sample of data) peak = Math.max(peak, Math.abs(sample))
        this.level = peak
        this.levels.push(peak)
        const elapsed = this.elapsedMs
        this.onTick(elapsed, peak)
        if (elapsed >= MAX_RECORDING_MS) this.onLimit()
      }, LEVEL_INTERVAL_MS)
    } catch {
      // No meter (no AudioContext): the recording itself still works.
    }
    recorder.start(1000)
    this.startedAt = performance.now()
  }

  /** Stop and hand over the recording. */
  async stop(): Promise<Recording | null> {
    const recorder = this.recorder
    if (!recorder || !this.finished) {
      this.release()
      return null
    }
    const durationMs = Math.min(MAX_RECORDING_MS, Math.round(this.elapsedMs))
    if (recorder.state !== 'inactive') recorder.stop()
    const blob = await this.finished
    const waveform = waveformBars(this.levels)
    this.release()
    const type = blob.type || 'audio/webm'
    return { file: new File([blob], voiceFileName(type, new Date()), { type }), durationMs, waveform }
  }

  cancel(): void {
    this.cancelled = true
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop()
    this.release()
  }

  private release(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    this.stream?.getTracks().forEach((track) => track.stop())
    this.stream = null
    void this.context?.close().catch(() => undefined)
    this.context = null
  }
}
