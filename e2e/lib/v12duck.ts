/**
 * Helpers of spec 96 (CONTRACT-V12-DUCKING).
 *
 * `FAKE_TONE_CAPTURE` replaces `getDisplayMedia` in the test page only, as
 * lib/v8music.ts does: a small picture track (`displaySurface: "browser"`,
 * which the music share requires) and a STEADY 440 Hz tone at 0.2 — the
 * screen's (or the music's) own sound. Steady, so a level read anywhere is
 * the same as anywhere else and a drop is the duck, not the source.
 */
import type { Page } from '@playwright/test'

export const TONE_LEVEL = 0.2

export const FAKE_TONE_CAPTURE = `
(() => {
  if (!navigator.mediaDevices || window.__trioToneCalls !== undefined) return
  window.__trioToneCalls = 0
  navigator.mediaDevices.getDisplayMedia = async () => {
    window.__trioToneCalls += 1
    const canvas = document.createElement('canvas')
    canvas.width = 320
    canvas.height = 180
    const ctx = canvas.getContext('2d')
    let frame = 0
    setInterval(() => { ctx.fillStyle = frame++ % 2 ? '#334' : '#443'; ctx.fillRect(0, 0, 320, 180) }, 100)
    const video = canvas.captureStream(10).getVideoTracks()[0]
    const settings = video.getSettings.bind(video)
    video.getSettings = () => ({ ...settings(), displaySurface: 'browser' })
    const context = new AudioContext({ sampleRate: 48000 })
    await context.resume()
    const tone = context.createOscillator()
    tone.frequency.value = 440
    const gain = context.createGain()
    gain.gain.value = ${TONE_LEVEL}
    const destination = context.createMediaStreamDestination()
    tone.connect(gain).connect(destination)
    tone.start()
    const audio = destination.stream.getAudioTracks()[0]
    const audioSettings = audio.getSettings.bind(audio)
    audio.getSettings = () => ({ ...audioSettings(), restrictOwnAudio: false })
    return new MediaStream([video, audio])
  }
})()
`

/** Before the page loads: the ducker and the playback mixer expose their state (probes). */
export const DUCK_PROBE = `window.__trioDuckProbe = true; window.__trioVolumeProbe = true`

export interface DuckRecord {
  /** Date.now(): the same clock in every browser of this machine. */
  t: number
  share: number | null
  music: number | null
  /** The data-speaking of each watched person's row. */
  speaking: boolean
  /** The volume of each watched voice element (never ducked). */
  voices: number[]
  hidden: boolean
}

/**
 * Start sampling, every 10 ms in the page: the screen element's volume, the
 * music element's volume, whether `speakerId`'s row says speaking, and the
 * volumes of the voice elements of `voiceIds`. Read with `stopRecorder`.
 */
export async function startRecorder(page: Page, speakerId: number, voiceIds: number[]): Promise<void> {
  await page.evaluate(
    ([speaker, voices]) => {
      const w = window as unknown as { __trioRec?: { timer: number; records: unknown[] } }
      if (w.__trioRec) clearInterval(w.__trioRec.timer)
      const records: unknown[] = []
      const sample = () => {
        const video = document.querySelector<HTMLVideoElement>('[data-testid="remote-video"]')
        const music = document.querySelector<HTMLAudioElement>('[data-testid^="remote-music-"]')
        const row = document.querySelector(`[data-testid="voice-user-${speaker}"]`)
        records.push({
          t: Date.now(),
          share: video ? (video.muted ? 0 : video.volume) : null,
          music: music ? (music.muted ? 0 : music.volume) : null,
          speaking: row?.getAttribute('data-speaking') === 'true',
          voices: voices.map((id) => {
            const el = document.querySelector<HTMLAudioElement>(`[data-testid="remote-audio-${id}"]`)
            return el ? (el.muted ? 0 : el.volume) : -1
          }),
          hidden: document.visibilityState === 'hidden',
        })
      }
      sample()
      w.__trioRec = { timer: window.setInterval(sample, 10), records }
    },
    [speakerId, voiceIds] as const,
  )
}

export async function stopRecorder(page: Page): Promise<DuckRecord[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __trioRec?: { timer: number; records: unknown[] } }
    if (!w.__trioRec) return []
    clearInterval(w.__trioRec.timer)
    const records = w.__trioRec.records
    delete w.__trioRec
    return records as DuckRecord[]
  })
}

export interface DuckState {
  share: number
  music: number
  ticks: number
  maxGapMs: number
  hiddenTicks: number
  hiddenMaxGapMs: number
  speech: boolean
}

export async function duckState(page: Page): Promise<DuckState | null> {
  return page.evaluate(() => (window as unknown as { __trioDuck?: DuckState }).__trioDuck ?? null)
}

/** Peak level over `ms` on a boosted route's tap (`stream:<id>`, `voice:<id>`): after the gain, the limiter and deafen. */
export async function tapPeaks(page: Page, keys: string[], ms = 1000): Promise<(number | null)[]> {
  return page.evaluate(
    async ([wanted, windowMs]) => {
      const taps = (window as unknown as { __trioVolumeTaps?: Record<string, AnalyserNode> }).__trioVolumeTaps ?? {}
      const peaks = wanted.map((k) => (taps[k] ? 0 : null))
      const data = new Float32Array(2048)
      const until = performance.now() + windowMs
      while (performance.now() < until) {
        wanted.forEach((k, i) => {
          const analyser = taps[k]
          if (!analyser) return
          analyser.getFloatTimeDomainData(data)
          for (const v of data) peaks[i] = Math.max(peaks[i] ?? 0, Math.abs(v))
        })
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      return peaks
    },
    [keys, ms] as const,
  )
}

/** Peak of the remote screen stream ITSELF (before any volume) over `ms`: the share really carries its tone. */
export async function shareSourcePeak(page: Page, ms = 800): Promise<number> {
  return page.evaluate(async (windowMs) => {
    const video = document.querySelector<HTMLVideoElement>('[data-testid="remote-video"]')
    const stream = video?.srcObject as MediaStream | null
    if (!stream || stream.getAudioTracks().length === 0) return -1
    const context = new AudioContext()
    await context.resume()
    const analyser = context.createAnalyser()
    analyser.fftSize = 2048
    context.createMediaStreamSource(stream).connect(analyser)
    const data = new Float32Array(2048)
    let peak = 0
    const until = performance.now() + windowMs
    while (performance.now() < until) {
      analyser.getFloatTimeDomainData(data)
      for (const v of data) peak = Math.max(peak, Math.abs(v))
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    await context.close()
    return peak
  }, ms)
}
