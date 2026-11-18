/**
 * Media probes for the v2 features: camera and screen tiles that really
 * decode, the audio energy one peer really receives from another (getStats on
 * the receiving side), and synthetic microphone input files.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { CHROMIUM_ARGS } from '../playwright.config'
import { E2E_DIR } from './server'
import { expect, type Person } from './trio'

// --- video -----------------------------------------------------------------------

export interface VideoFacts {
  kind: string | null
  width: number
  height: number
  /** Frames advanced over the sampling window. */
  advancing: boolean
  /** The tile's caption. */
  label: string | null
}

/** Size, kind and whether frames advance, for the first `<video>` matching `selector`. */
export async function videoFacts(page: Page, selector: string): Promise<VideoFacts | null> {
  return page.evaluate(async (sel) => {
    const video = document.querySelector<HTMLVideoElement>(sel)
    if (!video) return null
    const frames = () => video.getVideoPlaybackQuality().totalVideoFrames
    const f0 = frames()
    const t0 = video.currentTime
    await new Promise((resolve) => setTimeout(resolve, 600))
    return {
      kind: video.dataset.kind ?? null,
      width: video.videoWidth,
      height: video.videoHeight,
      advancing: frames() > f0 && video.currentTime > t0,
      label: video.closest('figure')?.querySelector('figcaption')?.textContent ?? null,
    }
  }, selector)
}

/** Assert the tile `testId` exists exactly once, is of `kind`, carries `label` and decodes frames. */
export async function expectTileDecoding(page: Page, testId: string, kind: 'camera' | 'screen', label: string): Promise<void> {
  await expect(page.getByTestId(testId)).toHaveCount(1, { timeout: 20_000 })
  await expect
    .poll(
      async () => {
        const facts = await videoFacts(page, `[data-testid="${testId}"]`)
        return facts && facts.width > 0 && facts.advancing ? `${facts.kind} ${facts.label}` : JSON.stringify(facts)
      },
      { timeout: 20_000, message: `${testId} should decode as a ${kind} tile` },
    )
    .toBe(`${kind} ${label}`)
}

/** Every tile on the stage as `kind:user` (user = id, or `me`), in order. */
export async function stageTiles(page: Page): Promise<string[]> {
  return page
    .locator('[data-testid="stage"] figure')
    .evaluateAll((figures) => figures.map((f) => `${f.getAttribute('data-kind')}:${f.getAttribute('data-user-id')}`))
}

// --- audio -----------------------------------------------------------------------

/**
 * What `listener` receives from `speaker`: the growth of the inbound-rtp
 * `totalAudioEnergy` per second of audio, over `ms`, on the receiver whose
 * track `remote-audio-<speaker>` plays. 0 means silence.
 */
export async function inboundEnergy(listener: Person, speaker: Person, ms = 1000): Promise<number> {
  return listener.page.evaluate(
    async ([id, windowMs]) => {
      const element = document.querySelector<HTMLAudioElement>(`[data-testid="remote-audio-${id}"]`)
      const track = (element?.srcObject as MediaStream | null)?.getAudioTracks()[0]
      if (!track) throw new Error(`no remote-audio-${id}`)
      const pcs = (window as unknown as { __trioPcs: RTCPeerConnection[] }).__trioPcs
      const pc = pcs.find((p) => p.connectionState !== 'closed' && p.getReceivers().some((r) => r.track === track))
      if (!pc) throw new Error(`no connection receives remote-audio-${id}`)
      const read = async () => {
        let energy = 0
        let duration = 0
        ;(await pc.getStats(track)).forEach((s) => {
          if (s.type === 'inbound-rtp' && s.kind === 'audio') {
            energy = s.totalAudioEnergy ?? 0
            duration = s.totalSamplesDuration ?? 0
          }
        })
        return { energy, duration }
      }
      const a = await read()
      await new Promise((resolve) => setTimeout(resolve, windowMs))
      const b = await read()
      const dt = b.duration - a.duration
      return dt > 0 ? (b.energy - a.energy) / dt : 0
    },
    [speaker.user.id, ms] as const,
  )
}

/** Below this a received track is silent (a closed gate encodes digital silence). */
export const SILENT = 1e-6
/** Above this something is being said (the synthetic voice gives ~1e-2). */
export const AUDIBLE = 1e-4

export async function expectEnergy(listener: Person, speaker: Person, audible: boolean, what: string): Promise<void> {
  await expect
    .poll(async () => {
      const energy = await inboundEnergy(listener, speaker)
      return audible ? energy > AUDIBLE : energy < SILENT
    }, { timeout: 15_000, message: `${listener.name} ← ${speaker.name}: ${what}` })
    .toBe(true)
}

/** Ids of the audio tracks this page sends, over all its open connections. */
export async function sentAudioTrackIds(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (window as unknown as { __trioPcs: RTCPeerConnection[] }).__trioPcs
      .filter((pc) => pc.connectionState !== 'closed')
      .flatMap((pc) => pc.getSenders().filter((s) => s.track?.kind === 'audio').map((s) => s.track!.id)),
  )
}

/** The negotiated SDP of every open connection: unchanged means nothing renegotiated. */
export async function localDescriptions(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (window as unknown as { __trioPcs: RTCPeerConnection[] }).__trioPcs
      .filter((pc) => pc.connectionState !== 'closed')
      .map((pc) => `${pc.connectionState} ${pc.currentLocalDescription?.sdp ?? ''}`),
  )
}

// --- synthetic microphone input ------------------------------------------------------

/** Writes a 48 kHz mono 16-bit WAV of `seconds` from `sample(t)` (in -1..1), once, under `.state/`. */
export function wavFile(name: string, seconds: number, sample: (t: number) => number): string {
  const file = path.join(E2E_DIR, '.state', name)
  if (fs.existsSync(file)) return file
  const rate = 48000
  const n = Math.round(seconds * rate)
  const buffer = Buffer.alloc(44 + n * 2)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + n * 2, 4)
  buffer.write('WAVEfmt ', 8)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(rate, 24)
  buffer.writeUInt32LE(rate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, sample(i / rate)))
    buffer.writeInt16LE(Math.round(v * 32767), 44 + i * 2)
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const partial = `${file}.${process.pid}.tmp`
  fs.writeFileSync(partial, buffer)
  fs.renameSync(partial, file)
  return file
}

/** A voiced, syllable-modulated harmonic signal: close enough to speech for a noise suppressor. */
export const voiceish = (t: number): number =>
  0.22 *
  (Math.sin(2 * Math.PI * 150 * t) +
    0.6 * Math.sin(2 * Math.PI * 300 * t) +
    0.4 * Math.sin(2 * Math.PI * 450 * t) +
    0.3 * Math.sin(2 * Math.PI * 600 * t) +
    0.2 * Math.sin(2 * Math.PI * 900 * t)) *
  (0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t))

/** Steady white noise (deterministic). */
export function whiteNoise(): (t: number) => number {
  let seed = 12345
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return 0.3 * ((seed / 0x7fffffff) * 2 - 1)
  }
}

/** Launch arguments that make the fake microphone play `file` (looped) instead of the beep. */
export function fakeAudioArgs(file: string): string[] {
  return [...CHROMIUM_ARGS, `--use-file-for-fake-audio-capture=${file}`]
}
