/**
 * Probes for the V6 voice specs (50–54): the screen sender towards ONE peer
 * (its parameters and outbound-rtp stats), renegotiation counters, and the
 * per-person volume tap.
 */
import type { Page } from '@playwright/test'
import type { Person } from './trio'

export interface ScreenOut {
  /** -1 when there is no screen sender towards that peer. */
  bytesSent: number
  framesEncoded: number
  framesPerSecond: number | null
  frameWidth: number | null
  frameHeight: number | null
  qualityLimitationReason: string | null
  active: boolean[]
  maxBitrate: (number | undefined)[]
  maxFramerate: (number | undefined)[]
  degradationPreference: string | null
  contentHint: string | null
  trackSettings: { width?: number; height?: number; frameRate?: number } | null
}

/**
 * `sharer`'s screen video sender on the connection to `viewer` (the
 * connection that carries `viewer`'s microphone into `sharer`'s page).
 */
export async function screenOut(sharer: Person, viewer: Person): Promise<ScreenOut> {
  const result: unknown = await sharer.page.evaluate(async (viewerId) => {
    const element = document.querySelector<HTMLAudioElement>(`[data-testid="remote-audio-${viewerId}"]`)
    const mic = (element?.srcObject as MediaStream | null)?.getAudioTracks()[0]
    const local = document.querySelector<HTMLVideoElement>('[data-testid="local-video"]')
    const screenTrack = (local?.srcObject as MediaStream | null)?.getVideoTracks()[0] ?? null
    const empty = {
      bytesSent: -1,
      framesEncoded: -1,
      framesPerSecond: null,
      frameWidth: null,
      frameHeight: null,
      qualityLimitationReason: null,
      active: [],
      maxBitrate: [],
      maxFramerate: [],
      degradationPreference: null,
      contentHint: screenTrack?.contentHint ?? null,
      trackSettings: screenTrack ? screenTrack.getSettings() : null,
    }
    if (!mic || !screenTrack) return empty
    for (const pc of (window as unknown as { __trioPcs: RTCPeerConnection[] }).__trioPcs) {
      if (pc.connectionState === 'closed') continue
      if (!pc.getReceivers().some((r) => r.track === mic)) continue
      const sender = pc.getSenders().find((s) => s.track === screenTrack)
      if (!sender) return empty
      const params = sender.getParameters() as RTCRtpSendParameters & { degradationPreference?: string }
      const out: Record<string, unknown> = { ...empty }
      out.active = params.encodings.map((e) => e.active !== false)
      out.maxBitrate = params.encodings.map((e) => e.maxBitrate)
      out.maxFramerate = params.encodings.map((e) => e.maxFramerate)
      out.degradationPreference = params.degradationPreference ?? null
      ;(await sender.getStats()).forEach((s) => {
        if (s.type !== 'outbound-rtp' || s.kind !== 'video') return
        out.bytesSent = s.bytesSent
        out.framesEncoded = s.framesEncoded ?? -1
        out.framesPerSecond = s.framesPerSecond ?? null
        out.frameWidth = s.frameWidth ?? null
        out.frameHeight = s.frameHeight ?? null
        out.qualityLimitationReason = s.qualityLimitationReason ?? null
      })
      return out
    }
    return empty
  }, viewer.user.id)
  return result as ScreenOut
}

/**
 * Start counting, on every open connection of the page, signaling-state
 * transitions, `negotiationneeded` events and offers created; read with
 * `negotiationCounts`.
 */
export async function countNegotiations(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as {
      __trioPcs: RTCPeerConnection[]
      __trioNeg?: { transitions: number; needed: number; offers: number }
      __trioNegPatched?: boolean
    }
    w.__trioNeg = { transitions: 0, needed: 0, offers: 0 }
    for (const pc of w.__trioPcs) {
      if (pc.connectionState === 'closed') continue
      pc.addEventListener('signalingstatechange', () => w.__trioNeg!.transitions++)
      pc.addEventListener('negotiationneeded', () => w.__trioNeg!.needed++)
    }
    if (!w.__trioNegPatched) {
      w.__trioNegPatched = true
      const set = RTCPeerConnection.prototype.setLocalDescription
      RTCPeerConnection.prototype.setLocalDescription = function (this: RTCPeerConnection, ...args: unknown[]) {
        if (this.signalingState === 'stable' && w.__trioNeg) w.__trioNeg.offers++
        return (set as (...a: unknown[]) => Promise<void>).apply(this, args)
      } as typeof set
    }
  })
}

export async function negotiationCounts(page: Page): Promise<{ transitions: number; needed: number; offers: number }> {
  return page.evaluate(() => ({ ...(window as unknown as { __trioNeg: { transitions: number; needed: number; offers: number } }).__trioNeg }))
}

/** Video bytes `viewer` has received from `sharer`'s screen, and frames decoded. */
export async function screenIn(viewer: Person, sharer: Person): Promise<{ bytes: number; frames: number }> {
  return viewer.page.evaluate(async (sharerId) => {
    const video = document.querySelector<HTMLVideoElement>(`[data-testid="remote-video"]`)
    const element = document.querySelector<HTMLAudioElement>(`[data-testid="remote-audio-${sharerId}"]`)
    const mic = (element?.srcObject as MediaStream | null)?.getAudioTracks()[0]
    for (const pc of (window as unknown as { __trioPcs: RTCPeerConnection[] }).__trioPcs) {
      if (pc.connectionState === 'closed' || !mic) continue
      if (!pc.getReceivers().some((r) => r.track === mic)) continue
      let bytes = 0
      let frames = 0
      ;(await pc.getStats()).forEach((s) => {
        if (s.type === 'inbound-rtp' && s.kind === 'video') {
          bytes += s.bytesReceived ?? 0
          frames += s.framesDecoded ?? 0
        }
      })
      void video
      return { bytes, frames }
    }
    return { bytes: -1, frames: -1 }
  }, sharer.user.id)
}

/** Install before the page loads: the playback mixer exposes an analyser per boosted stream. */
export const VOLUME_PROBE = `window.__trioVolumeProbe = true`

/** Peak level over `ms` on the boosted route `key` ("voice:<id>"); null when the stream is not routed through Web Audio. */
export async function tapPeak(page: Page, key: string, ms = 1200): Promise<number | null> {
  return page.evaluate(
    async ([k, windowMs]) => {
      const taps = (window as unknown as { __trioVolumeTaps?: Record<string, AnalyserNode> }).__trioVolumeTaps
      const analyser = taps?.[k]
      if (!analyser) return null
      const data = new Float32Array(analyser.fftSize)
      let peak = 0
      const until = performance.now() + windowMs
      while (performance.now() < until) {
        analyser.getFloatTimeDomainData(data)
        for (const v of data) peak = Math.max(peak, Math.abs(v))
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      return peak
    },
    [key, ms] as const,
  )
}

/** Peak level over `ms` of the remote stream itself (before any volume), as played on `remote-audio-<id>`. */
export async function sourcePeak(page: Page, userId: number, ms = 1200): Promise<number> {
  return page.evaluate(
    async ([id, windowMs]) => {
      const element = document.querySelector<HTMLAudioElement>(`[data-testid="remote-audio-${id}"]`)
      const stream = element?.srcObject as MediaStream
      const context = new AudioContext()
      await context.resume()
      const analyser = context.createAnalyser()
      analyser.fftSize = 2048
      context.createMediaStreamSource(stream).connect(analyser)
      const data = new Float32Array(analyser.fftSize)
      let peak = 0
      const until = performance.now() + windowMs
      while (performance.now() < until) {
        analyser.getFloatTimeDomainData(data)
        for (const v of data) peak = Math.max(peak, Math.abs(v))
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      await context.close()
      return peak
    },
    [userId, ms] as const,
  )
}
