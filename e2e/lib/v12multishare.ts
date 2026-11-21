/**
 * Helpers of the V12 specs (91–95, CONTRACT-V12-WATCHING): several people
 * sharing their screens at once. Everything here reads MEDIA (receiver and
 * sender statistics, decoded frames), never elements alone (CLAUDE.md).
 */
import type { Page } from '@playwright/test'
import { expect, type Person } from './trio'

/** The stage figure of `sharerId`'s screen on the viewer's page. */
export function screenTileSelector(sharerId: number): string {
  return `figure.call-tile.screen[data-user-id="${sharerId}"] video`
}

/**
 * Wait until `viewer` decodes frames of `sharerId`'s screen; the wall-clock
 * time (Date.now) at which the first decoded frame was seen. Polls in the
 * page every 40 ms so the time is close to the frame's own.
 */
export async function firstFrameAt(viewer: Person, sharerId: number, timeout = 30_000): Promise<number> {
  try {
    const handle = await viewer.page.waitForFunction(
      (selector) => {
        const video = document.querySelector<HTMLVideoElement>(selector)
        if (!video || video.videoWidth === 0) return false
        return video.getVideoPlaybackQuality().totalVideoFrames > 0 ? Date.now() : false
      },
      screenTileSelector(sharerId),
      { polling: 40, timeout },
    )
    return (await handle.jsonValue()) as number
  } catch (error) {
    throw new Error(`${viewer.name}: no frame of ${sharerId}'s screen: ${JSON.stringify(await screenTileState(viewer.page, sharerId))}\n${String(error)}`)
  }
}

/** For a failure message: the viewer's screen tiles and what arrives of `sharerId`'s video. */
export async function screenTileState(page: Page, sharerId: number): Promise<unknown> {
  return page
    .evaluate(async (id) => {
      const tiles = [...document.querySelectorAll<HTMLElement>('figure.call-tile')].map((f) => `${f.dataset.kind}:${f.dataset.userId}${f.classList.contains('folded') ? ':folded' : ''}`)
      const video = document.querySelector<HTMLVideoElement>(`figure.call-tile.screen[data-user-id="${id}"] video`)
      const track = (video?.srcObject as MediaStream | null)?.getVideoTracks()[0] ?? null
      const pcs = (window as unknown as { __trioPcs: RTCPeerConnection[] }).__trioPcs.filter((pc) => pc.connectionState !== 'closed')
      let inbound: Record<string, unknown> | null = null
      let transceiver: string | null = null
      for (const pc of pcs) {
        const t = pc.getTransceivers().find((x) => x.receiver.track === track)
        if (!t) continue
        transceiver = `${t.mid} ${t.direction}/${t.currentDirection} ${pc.connectionState}/${pc.signalingState}`
        ;(await t.receiver.getStats()).forEach((s) => {
          if (s.type === 'inbound-rtp') inbound = { bytes: s.bytesReceived, frames: s.framesDecoded, w: s.frameWidth, keyFrames: s.keyFramesDecoded, pli: s.pliCount }
        })
      }
      return {
        tiles,
        video: video ? { w: video.videoWidth, frames: video.getVideoPlaybackQuality().totalVideoFrames, ready: video.readyState, paused: video.paused } : null,
        track: track ? `${track.readyState}${track.muted ? ':muted' : ''}` : null,
        transceiver,
        inbound,
      }
    }, sharerId)
    .catch((error: unknown) => String(error))
}

/** Every screen of `sharerIds` is decoding on the viewer's page (frames grow over 700 ms). */
export async function expectDecodingFrom(viewer: Person, sharerIds: readonly number[], timeout = 30_000): Promise<void> {
  await expect
    .poll(
      () =>
        viewer.page.evaluate(async (selectors) => {
          const videos = selectors.map((s) => document.querySelector<HTMLVideoElement>(s))
          if (videos.some((v) => !v)) return false
          const sample = () => videos.map((v) => ({ w: v!.videoWidth, f: v!.getVideoPlaybackQuality().totalVideoFrames }))
          const a = sample()
          await new Promise((resolve) => setTimeout(resolve, 700))
          const b = sample()
          return a.every((x, i) => x.w > 0 && b[i].f > x.f)
        }, sharerIds.map(screenTileSelector)),
      { timeout, message: `${viewer.name} decodes the screens of ${sharerIds.join(', ')}` },
    )
    .toBe(true)
}

export interface ScreenSend {
  /** The viewer's user id (from the microphone its connection carries). */
  viewer: number
  kbps: number
  fps: number
  width: number
  height: number
  qualityLimitationReason: string
  /** Milliseconds of encoder time per frame over the window. */
  encodeMsPerFrame: number
  /** The sender's bandwidth estimate for that path (kbit/s), or -1. */
  availableKbps: number
  active: boolean
  maxBitrate: number | null
  scale: number | null
}

/**
 * The sharer's screen video, per connection, over `ms`: what each viewer is
 * sent. The connection is told apart by the microphone it receives.
 */
export async function screenSend(sharer: Person, ms = 3000): Promise<ScreenSend[]> {
  return sharer.page.evaluate(async (window_) => {
    const local = document.querySelector<HTMLVideoElement>('[data-testid="local-video"]')
    const track = (local?.srcObject as MediaStream | null)?.getVideoTracks()[0]
    if (!track) return []
    const pcs = (window as unknown as { __trioPcs: RTCPeerConnection[] }).__trioPcs.filter((pc) => pc.connectionState === 'connected')
    const viewerOf = (pc: RTCPeerConnection): number => {
      for (const element of document.querySelectorAll<HTMLAudioElement>('[data-testid^="remote-audio-"]')) {
        const mic = (element.srcObject as MediaStream | null)?.getAudioTracks()[0]
        if (mic && pc.getReceivers().some((r) => r.track === mic)) return Number(element.dataset.testid?.slice('remote-audio-'.length))
      }
      return -1
    }
    const read = async () =>
      Promise.all(
        pcs.map(async (pc) => {
          const sender = pc.getSenders().find((s) => s.track === track)
          let out: Record<string, number | string> = {}
          let available = -1
          const report = await pc.getStats()
          const byId = new Map<string, Record<string, unknown>>()
          report.forEach((s: Record<string, unknown>) => byId.set(String(s.id), s))
          for (const s of byId.values()) {
            if (s.type === 'transport' && typeof s.selectedCandidatePairId === 'string') {
              const pair = byId.get(s.selectedCandidatePairId)
              if (typeof pair?.availableOutgoingBitrate === 'number') available = pair.availableOutgoingBitrate
            }
          }
          if (sender) {
            ;(await sender.getStats()).forEach((s) => {
              if (s.type === 'outbound-rtp' && s.kind === 'video') out = s as Record<string, number | string>
            })
          }
          const params = sender?.getParameters()
          return { out, available, params: params?.encodings?.[0] ?? null }
        }),
      )
    const a = await read()
    const t0 = performance.now()
    await new Promise((resolve) => setTimeout(resolve, window_))
    const b = await read()
    const seconds = (performance.now() - t0) / 1000
    return pcs.map((pc, i) => {
      const x = a[i].out
      const y = b[i].out
      const frames = Number(y.framesEncoded ?? 0) - Number(x.framesEncoded ?? 0)
      const encode = Number(y.totalEncodeTime ?? 0) - Number(x.totalEncodeTime ?? 0)
      return {
        viewer: viewerOf(pc),
        kbps: ((Number(y.bytesSent ?? 0) - Number(x.bytesSent ?? 0)) * 8) / seconds / 1000,
        fps: frames / seconds,
        width: Number(y.frameWidth ?? 0),
        height: Number(y.frameHeight ?? 0),
        qualityLimitationReason: String(y.qualityLimitationReason ?? 'none'),
        encodeMsPerFrame: frames > 0 ? (encode / frames) * 1000 : 0,
        availableKbps: b[i].available > 0 ? b[i].available / 1000 : -1,
        active: b[i].params ? b[i].params.active !== false : false,
        maxBitrate: b[i].params?.maxBitrate ?? null,
        scale: b[i].params?.scaleResolutionDownBy ?? null,
      }
    })
  }, ms)
}

/** What a viewer receives of each remote screen, over `ms`: kbit/s and decoded frames per second, by sharer id. */
export async function screenReceive(viewer: Person, ms = 3000): Promise<Record<number, { kbps: number; fps: number; height: number }>> {
  return viewer.page.evaluate(async (window_) => {
    const tiles = [...document.querySelectorAll<HTMLElement>('figure.call-tile.screen[data-user-id]')].filter((f) => f.dataset.userId !== 'me')
    const read = () =>
      tiles.map((figure) => {
        const video = figure.querySelector('video')!
        return { id: Number(figure.dataset.userId), frames: video.getVideoPlaybackQuality().totalVideoFrames, height: video.videoHeight }
      })
    const pcs = (window as unknown as { __trioPcs: RTCPeerConnection[] }).__trioPcs.filter((pc) => pc.connectionState === 'connected')
    const bytes = async () => {
      const out = new Map<number, number>()
      for (const figure of tiles) {
        const id = Number(figure.dataset.userId)
        const track = (figure.querySelector('video')!.srcObject as MediaStream | null)?.getVideoTracks()[0]
        for (const pc of pcs) {
          const receiver = pc.getReceivers().find((r) => r.track === track)
          if (!receiver) continue
          ;(await receiver.getStats()).forEach((s) => {
            if (s.type === 'inbound-rtp' && s.kind === 'video') out.set(id, s.bytesReceived ?? 0)
          })
        }
      }
      return out
    }
    const a = read()
    const ba = await bytes()
    const t0 = performance.now()
    await new Promise((resolve) => setTimeout(resolve, window_))
    const b = read()
    const bb = await bytes()
    const seconds = (performance.now() - t0) / 1000
    const result: Record<number, { kbps: number; fps: number; height: number }> = {}
    b.forEach((entry, i) => {
      result[entry.id] = {
        kbps: (((bb.get(entry.id) ?? 0) - (ba.get(entry.id) ?? 0)) * 8) / seconds / 1000,
        fps: (entry.frames - a[i].frames) / seconds,
        height: entry.height,
      }
    })
    return result
  }, ms)
}

/** RTCPeerConnections the page ever made, and how many are live: more made than peers = a fresh connection. */
export async function connectionCounts(page: Page): Promise<{ made: number; live: number }> {
  return page.evaluate(() => {
    const pcs = (window as unknown as { __trioPcs: RTCPeerConnection[] }).__trioPcs
    return { made: pcs.length, live: pcs.filter((pc) => pc.connectionState !== 'closed').length }
  })
}

/** Video m-lines per live connection (largest), and the largest current local description (bytes as signalled). */
export async function descriptionFacts(page: Page): Promise<{ maxVideoMLines: number; maxBytes: number }> {
  return page.evaluate(() => {
    const pcs = (window as unknown as { __trioPcs: RTCPeerConnection[] }).__trioPcs.filter((pc) => pc.connectionState !== 'closed')
    let maxVideoMLines = 0
    let maxBytes = 0
    for (const pc of pcs) {
      const sdp = pc.localDescription?.sdp ?? ''
      maxVideoMLines = Math.max(maxVideoMLines, (sdp.match(/^m=video/gm) ?? []).length)
      maxBytes = Math.max(maxBytes, new TextEncoder().encode(JSON.stringify({ description: { type: 'offer', sdp } })).length)
    }
    return { maxVideoMLines, maxBytes }
  })
}

/**
 * A screen capture that ALSO carries sound: Chromium's own fake screen for the
 * picture, plus a Web Audio tone at `window.__trioScreenToneHz` (default
 * 440) for the sound. Installed before the page loads; the app calls
 * getDisplayMedia as in a browser and gets both tracks.
 */
export const SCREEN_WITH_TONE = `
(() => {
  const media = navigator.mediaDevices
  if (!media || window.__trioScreenTone) return
  window.__trioScreenTone = true
  const native = media.getDisplayMedia.bind(media)
  media.getDisplayMedia = async (options) => {
    const stream = await native({ video: true })
    const context = new AudioContext({ sampleRate: 48000 })
    await context.resume()
    const tone = context.createOscillator()
    tone.frequency.value = window.__trioScreenToneHz ?? 440
    const gain = context.createGain()
    gain.gain.value = 0.3
    const destination = context.createMediaStreamDestination()
    tone.connect(gain).connect(destination)
    tone.start()
    const audio = destination.stream.getAudioTracks()[0]
    stream.addTrack(audio)
    return stream
  }
})()
`

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}
