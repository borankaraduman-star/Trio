/**
 * Helpers of the V8 music specs (71–74, CONTRACT-V8-MUSIC).
 *
 * What is faked, exactly:
 *
 * - `FAKE_MUSIC_CAPTURE` (71, 72, 74, and the error cases of 73) replaces
 *   `navigator.mediaDevices.getDisplayMedia` IN THE TEST PAGE ONLY — the
 *   app's code is untouched and calls it as in a browser. The replacement
 *   answers what Chrome's tab capture answers (verified against the real one
 *   in 73): a picture track whose settings say `displaySurface: "browser"`
 *   and a stereo audio track — here a Web Audio source with a 440 Hz tone at
 *   0.5 on the LEFT and nothing on the right, so a stereo path is told from a
 *   downmix (which would give ~0.25 on both). Every call's options are kept
 *   in `window.__trioMusicCalls`; `window.__trioMusicEnd()` ends the capture
 *   "by itself" (as closing the tab does: the track ends, `ended` fires).
 * - 73's real spec uses NO fake at the boundary: a headed Chromium (on its
 *   own Xvfb display, started here) with `--auto-select-tab-capture-source-by-title`
 *   picks a real tab that plays a stereo oscillator; its sound comes through
 *   Chromium's real tab-audio capture. Headless Chromium captures a tab's
 *   audio as silence (measured), which is why it needs a display.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { expect, type Person } from './trio'

export const FAKE_MUSIC_CAPTURE = `
(() => {
  if (!navigator.mediaDevices || window.__trioMusicCalls) return
  window.__trioMusicCalls = []
  window.__trioMusicMode = 'stereo'
  navigator.mediaDevices.getDisplayMedia = async (options) => {
    window.__trioMusicCalls.push(JSON.parse(JSON.stringify(options ?? {})))
    const canvas = document.createElement('canvas')
    canvas.width = 64
    canvas.height = 36
    canvas.getContext('2d').fillRect(0, 0, 64, 36)
    const video = canvas.captureStream(5).getVideoTracks()[0]
    const settings = video.getSettings.bind(video)
    video.getSettings = () => ({ ...settings(), displaySurface: 'browser' })
    const tracks = [video]
    if (window.__trioMusicMode !== 'no-audio') {
      const context = new AudioContext({ sampleRate: 48000 })
      await context.resume()
      const merger = context.createChannelMerger(2)
      const tone = context.createOscillator()
      tone.frequency.value = 440
      const gain = context.createGain()
      gain.gain.value = 0.5
      tone.connect(gain).connect(merger, 0, 0)
      const destination = context.createMediaStreamDestination()
      destination.channelCount = 2
      destination.channelCountMode = 'explicit'
      merger.connect(destination)
      tone.start()
      const audio = destination.stream.getAudioTracks()[0]
      const audioSettings = audio.getSettings.bind(audio)
      audio.getSettings = () => ({ ...audioSettings(), restrictOwnAudio: false })
      tracks.push(audio)
      window.__trioMusicEnd = () => {
        audio.stop()
        audio.dispatchEvent(new Event('ended'))
        void context.close()
      }
    }
    return new MediaStream(tracks)
  }
})()
`

/** Make the fake capture answer without a sound track (the "share tab audio" box not ticked). */
export async function fakeCaptureWithoutAudio(page: Page): Promise<void> {
  await page.evaluate(() => {
    ;(window as unknown as { __trioMusicMode: string }).__trioMusicMode = 'no-audio'
  })
}

export async function endCaptureByItself(page: Page): Promise<void> {
  await page.evaluate(() => (window as unknown as { __trioMusicEnd: () => void }).__trioMusicEnd())
}

/**
 * Records, on every RTCPeerConnection the page makes: each signaling state it
 * enters, every rollback (an explicit one, or the implicit one a remote offer
 * makes in `have-local-offer`), and the size of every local description.
 */
export const NEGOTIATION_PROBE = `
(() => {
  if (window.__trioNegLog) return
  window.__trioNegLog = { states: [], rollbacks: 0, maxLocal: 0, offers: 0 }
  const log = window.__trioNegLog
  const proto = RTCPeerConnection.prototype
  const srd = proto.setRemoteDescription
  proto.setRemoteDescription = function (description, ...rest) {
    if (description && (description.type === 'rollback' || (description.type === 'offer' && this.signalingState === 'have-local-offer'))) log.rollbacks++
    if (!this.__trioStates) {
      this.__trioStates = true
      this.addEventListener('signalingstatechange', () => log.states.push(this.signalingState))
    }
    return srd.call(this, description, ...rest)
  }
  const sld = proto.setLocalDescription
  proto.setLocalDescription = function (description, ...rest) {
    if (description && description.type === 'rollback') log.rollbacks++
    if (!this.__trioStates) {
      this.__trioStates = true
      this.addEventListener('signalingstatechange', () => log.states.push(this.signalingState))
    }
    const wasStable = this.signalingState === 'stable'
    return sld.call(this, description, ...rest).then((value) => {
      if (wasStable) log.offers++
      const sdp = this.localDescription ? this.localDescription.sdp : ''
      log.maxLocal = Math.max(log.maxLocal, JSON.stringify({ description: { type: 'offer', sdp } }).length)
      return value
    })
  }
})()
`

export interface NegotiationLog {
  states: string[]
  rollbacks: number
  maxLocal: number
  offers: number
}

export async function negotiationLog(page: Page): Promise<NegotiationLog> {
  return page.evaluate(() => JSON.parse(JSON.stringify((window as unknown as { __trioNegLog: NegotiationLog }).__trioNegLog)))
}

export interface MusicIn {
  /** inbound-rtp of the music receiver. */
  bytes: number
  /** kbit/s over the measuring window. */
  kbps: number
  /** Peak of each channel heard on the music stream over the window. */
  left: number
  right: number
  playing: boolean
  volume: number
  muted: boolean
  /** The connection it came on (same number = same object). */
  pc: number
}

/** What `listener` receives as `sharer`'s music: RTP bitrate, and each channel's peak. */
export async function musicIn(listener: Person, sharer: Person, ms = 1500): Promise<MusicIn | null> {
  return listener.page.evaluate(
    async ([id, windowMs]) => {
      const element = document.querySelector<HTMLAudioElement>(`[data-testid="remote-music-${id}"]`)
      const stream = element?.srcObject as MediaStream | null
      const track = stream?.getAudioTracks()[0]
      if (!element || !stream || !track) return null
      const w = window as unknown as { __trioPcs: RTCPeerConnection[]; __trioPcTags?: WeakMap<RTCPeerConnection, number>; __trioPcNext?: number }
      const pc = w.__trioPcs.find((p) => p.connectionState !== 'closed' && p.getReceivers().some((r) => r.track === track))
      if (!pc) return null
      w.__trioPcTags ??= new WeakMap()
      let tag = w.__trioPcTags.get(pc)
      if (tag === undefined) {
        w.__trioPcNext = (w.__trioPcNext ?? 0) + 1
        tag = w.__trioPcNext
        w.__trioPcTags.set(pc, tag)
      }
      const read = async () => {
        let bytes = 0
        let at = 0
        ;(await pc.getStats(track)).forEach((s) => {
          if (s.type === 'inbound-rtp' && s.kind === 'audio') {
            bytes = s.bytesReceived
            at = s.timestamp
          }
        })
        return { bytes, at }
      }
      const context = new AudioContext()
      await context.resume()
      const source = context.createMediaStreamSource(stream)
      const splitter = context.createChannelSplitter(2)
      source.connect(splitter)
      const analysers = [0, 1].map((channel) => {
        const analyser = context.createAnalyser()
        analyser.fftSize = 2048
        splitter.connect(analyser, channel)
        return analyser
      })
      const a = await read()
      const data = new Float32Array(2048)
      const peaks = [0, 0]
      const until = performance.now() + windowMs
      while (performance.now() < until) {
        analysers.forEach((analyser, channel) => {
          analyser.getFloatTimeDomainData(data)
          for (const sample of data) peaks[channel] = Math.max(peaks[channel], Math.abs(sample))
        })
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      const b = await read()
      source.disconnect()
      await context.close()
      return {
        bytes: b.bytes,
        kbps: b.at > a.at ? ((b.bytes - a.bytes) * 8) / (b.at - a.at) : 0,
        left: peaks[0],
        right: peaks[1],
        playing: !element.paused && element.readyState >= 2,
        volume: element.volume,
        muted: element.muted,
        pc: tag,
      }
    },
    [sharer.user.id, ms] as const,
  )
}

export interface MusicOut {
  kbps: number
  maxBitrate: number | null
  fmtp: string
  channels: number | null
}

/** The sharer's outbound music to one peer (the sender whose track is the music). */
export async function musicOut(sharer: Person, ms = 1500): Promise<MusicOut[]> {
  return sharer.page.evaluate(async (windowMs) => {
    const out: MusicOut[] = []
    for (const pc of (window as unknown as { __trioPcs: RTCPeerConnection[] }).__trioPcs) {
      if (pc.connectionState === 'closed') continue
      const sender = pc.getSenders().find((s) => s.track?.kind === 'audio' && s.track.contentHint === 'music')
      if (!sender) continue
      const read = async () => {
        let bytes = 0
        let at = 0
        let codecId = ''
        const report = await sender.getStats()
        report.forEach((s) => {
          if (s.type === 'outbound-rtp') {
            bytes = s.bytesSent
            at = s.timestamp
            codecId = s.codecId
          }
        })
        let fmtp = ''
        let channels: number | null = null
        report.forEach((s) => {
          if (s.type === 'codec' && s.id === codecId) {
            fmtp = s.sdpFmtpLine ?? ''
            channels = s.channels ?? null
          }
        })
        return { bytes, at, fmtp, channels }
      }
      const a = await read()
      await new Promise((resolve) => setTimeout(resolve, windowMs))
      const b = await read()
      out.push({
        kbps: b.at > a.at ? ((b.bytes - a.bytes) * 8) / (b.at - a.at) : 0,
        maxBitrate: sender.getParameters().encodings?.[0]?.maxBitrate ?? null,
        fmtp: b.fmtp,
        channels: b.channels,
      })
    }
    return out
  }, ms)
}

/** Stereo music arrives: the left channel carries the tone, the right is (near) silent. */
export async function expectStereoMusic(listener: Person, sharer: Person, what: string): Promise<MusicIn> {
  let last: MusicIn | null = null
  try {
    await expect
      .poll(
        async () => {
          last = await musicIn(listener, sharer)
          return last !== null && last.playing && last.left > 0.3 && last.right < 0.05 && last.kbps > 60
        },
        { timeout: 30_000, message: what },
      )
      .toBe(true)
  } catch (error) {
    throw new Error(`${what}: last ${JSON.stringify(last)}\n${String(error)}`)
  }
  return last as unknown as MusicIn
}

/** Music still arrives (any level on either channel, bytes growing). */
export async function expectMusicFlowing(listener: Person, sharer: Person, what: string): Promise<MusicIn> {
  let last: MusicIn | null = null
  await expect
    .poll(
      async () => {
        last = await musicIn(listener, sharer, 1000)
        return last !== null && last.kbps > 20 && Math.max(last.left, last.right) > 0.05
      },
      { timeout: 30_000, message: `${what}: last ${JSON.stringify(last)}` },
    )
    .toBe(true)
  return last as unknown as MusicIn
}

// --- a display for the headed browser of spec 73 ------------------------------------

export interface Display {
  name: string
  stop: () => void
}

/** An Xvfb display of our own (none needed when one is already set). */
export async function ownDisplay(): Promise<Display | null> {
  if (process.env.DISPLAY) return { name: process.env.DISPLAY, stop: () => undefined }
  const binary = ['/usr/bin/Xvfb', '/usr/local/bin/Xvfb'].find((path) => existsSync(path))
  if (!binary) return null
  const child: ChildProcess = spawn(binary, ['-displayfd', '1', '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], {
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const number = await new Promise<string | null>((resolve) => {
    let text = ''
    const timer = setTimeout(() => resolve(null), 10_000)
    child.stdout?.on('data', (chunk: Buffer) => {
      text += chunk.toString()
      const match = /(\d+)\s*$/.exec(text)
      if (text.includes('\n') && match) {
        clearTimeout(timer)
        resolve(match[1])
      }
    })
    child.on('exit', () => resolve(null))
  })
  if (number === null) {
    child.kill()
    return null
  }
  return { name: `:${number}`, stop: () => child.kill() }
}
