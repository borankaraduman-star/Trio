/**
 * Voice messages (CONTRACT-V6-MEDIA §4), the pure part: which recording type
 * this browser has, the 64-bar waveform from the levels heard while
 * recording, and how a length is written.
 */

export const MAX_RECORDING_MS = 120_000
export const WAVEFORM_BARS = 64
/** How often the level is read while recording; the analyser window covers it (see CLAUDE.md). */
export const LEVEL_INTERVAL_MS = 50
/** Shorter than this is a slip of the finger, not a message. */
export const MIN_RECORDING_MS = 500

/** Best first: Opus in WebM (Chromium, Firefox), then MP4 (Safari), then whatever the browser picks. */
export const RECORDER_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'] as const

export function pickRecorderType(isTypeSupported: (type: string) => boolean): string {
  for (const type of RECORDER_TYPES) {
    try {
      if (isTypeSupported(type)) return type
    } catch {
      // An engine that throws for a type does not have it.
    }
  }
  return ''
}

/** The file extension for what MediaRecorder actually produced. */
export function extensionFor(mimeType: string): string {
  const base = mimeType.split(';')[0].trim().toLowerCase()
  if (base === 'audio/mp4' || base === 'video/mp4') return 'm4a'
  if (base === 'audio/ogg') return 'ogg'
  return 'webm'
}

export function voiceFileName(mimeType: string, now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `sesli-mesaj-${stamp}.${extensionFor(mimeType)}`
}

/**
 * `levels` (peaks 0..1, one per LEVEL_INTERVAL_MS) as `bars` values 0..255:
 * each bar is the loudest level of its stretch, scaled so the loudest bar is
 * 255 (a quiet speaker still draws a shape). A recording shorter than the bar
 * count repeats its levels; silence is all zeros.
 */
export function waveformBars(levels: readonly number[], bars = WAVEFORM_BARS): number[] {
  if (levels.length === 0) return new Array<number>(bars).fill(0)
  const out: number[] = []
  for (let i = 0; i < bars; i += 1) {
    const start = Math.floor((i * levels.length) / bars)
    const end = Math.max(start + 1, Math.floor(((i + 1) * levels.length) / bars))
    let peak = 0
    for (let j = start; j < end && j < levels.length; j += 1) peak = Math.max(peak, Math.abs(levels[j]) || 0)
    out.push(peak)
  }
  const loudest = Math.max(...out)
  if (!(loudest > 0)) return out.map(() => 0)
  return out.map((value) => Math.max(0, Math.min(255, Math.round((value / loudest) * 255))))
}

/** "0:07", "1:59", "2:00". */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export const PLAYBACK_RATES = [1, 1.5, 2] as const

export function nextRate(rate: number): number {
  const index = PLAYBACK_RATES.indexOf(rate as (typeof PLAYBACK_RATES)[number])
  return PLAYBACK_RATES[(index + 1) % PLAYBACK_RATES.length]
}

/** "1×", "1,5×", "2×". */
export function rateLabel(rate: number): string {
  return `${String(rate).replace('.', ',')}×`
}

/** A press shorter than this starts click-to-stop recording instead of hold-to-record. */
export const HOLD_MS = 350
/** A finger or pointer slid this far from the button cancels a held recording. */
export const CANCEL_SLIDE_PX = 80

export function slidAway(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) > CANCEL_SLIDE_PX
}

/** Why recording could not start, in Turkish. */
export function micErrorMessage(error: unknown): string {
  const name = typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : undefined
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Mikrofon izni verilmedi. Sesli mesaj için tarayıcının adres çubuğundaki izinlerden mikrofona izin ver.'
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'Mikrofon bulunamadı. Bir mikrofon bağlayıp yeniden dene.'
  if (name === 'NotReadableError') return 'Mikrofon başka bir uygulamada kullanılıyor ya da açılamadı.'
  if (name === 'NotSupportedError') return 'Bu tarayıcı ses kaydedemiyor.'
  return 'Ses kaydı başlatılamadı.'
}
