/**
 * CONTRACT-V10-GROUPS: helpers for N people instead of three. Accounts are
 * seeded through the API (each join from its own address, so the per-address
 * join limit of 10 per 10 minutes is not met), and a crowd is N browser
 * contexts in the ONE browser the suite runs, audio-only unless a test turns
 * cameras on: a 4-CPU machine runs eight such people, not eight with cameras.
 */
import type { Browser, Page } from '@playwright/test'
import { baseUrl, INVITE_CODE } from './server'
import { expect, personWithSession, SOHBET, type ContextOptions, type Person, type User } from './trio'

export const GROUP_NAMES = [
  'Ayşe',
  'Mehmet',
  'Zeynep',
  'Ali',
  'Berk',
  'Cem',
  'Deniz',
  'Ece',
  'Fatih',
  'Gül',
  'Hakan',
  'Işıl',
  'Kerem',
  'Lale',
  'Mert',
] as const

let address = 0

/** `POST /api/join` from a fresh client address (TEST-NET-2), as N friends' phones would. */
export async function joinFrom(name: string): Promise<{ token: string; user: User }> {
  address += 1
  const response = await fetch(`${baseUrl()}/api/join`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Forwarded-For': `198.51.100.${(address % 250) + 1}`,
    },
    body: JSON.stringify({ invite_code: INVITE_CODE, name }),
  })
  if (response.status !== 201) throw new Error(`join ${name}: ${response.status} ${await response.text()}`)
  return (await response.json()) as { token: string; user: User }
}

/** Accounts for `names`, with no browser (the rest of the group, offline). */
export async function seedAccounts(names: readonly string[]): Promise<{ token: string; user: User }[]> {
  const out = []
  for (const name of names) out.push(await joinFrom(name))
  return out
}

/** `count` people, each in their own browser context, signed in. */
export async function crowd(
  browser: Browser,
  trio: { add: (p: Person) => Person },
  count: number,
  options: ContextOptions | ((index: number) => ContextOptions) = {},
  names: readonly string[] = GROUP_NAMES,
): Promise<Person[]> {
  const people: Person[] = []
  for (let i = 0; i < count; i += 1) {
    const session = await joinFrom(names[i])
    const opts = typeof options === 'function' ? options(i) : options
    people.push(trio.add(await personWithSession(browser, names[i], session, opts)))
  }
  return people
}

/** Click the room on every page as close together as the pages allow (a join storm). */
export async function joinAllAtOnce(people: Person[], channelId = SOHBET): Promise<number> {
  const started = Date.now()
  await Promise.all(people.map((person) => person.page.getByTestId(`channel-${channelId}`).click()))
  return Date.now() - started
}

/** How many peers this page's engine reports connected (the participant rows' ICE health). */
export async function connectedPeers(page: Page): Promise<number> {
  return page.locator('[data-testid^="voice-user-"][data-peer-health="connected"]').count()
}

/** Wait until every page is connected to every other one; the time it took (ms). */
export async function expectFullMesh(people: Person[], timeout = 90_000): Promise<number> {
  const started = Date.now()
  const want = people.length - 1
  await expect
    .poll(async () => (await Promise.all(people.map((p) => connectedPeers(p.page)))).join(','), {
      timeout,
      intervals: [250, 500, 1000],
      message: `every page connected to ${want} peers`,
    })
    .toBe(people.map(() => String(want)).join(','))
  return Date.now() - started
}

export interface MeshStats {
  /** RTCPeerConnections that are `connected` now. */
  connected: number
  /** Outbound bits per second over the sample, by kind. */
  outAudioBps: number
  outVideoBps: number
  inAudioBps: number
  inVideoBps: number
  /** Inbound audio streams whose bytes grew during the sample and whose level was above silence. */
  hearing: number
  /** Frames encoded per second (all video senders) and the largest outgoing frame height. */
  framesEncodedPerSecond: number
  maxSentHeight: number
  /** Sum of `totalEncodeTime` growth per second (seconds of encoder time per second: a CPU signal). */
  encodeLoad: number
  /** Audio concealment of all inbound audio during the sample (0..1: share of samples concealed). */
  concealedShare: number
}

/**
 * One page's media over `ms`: two getStats readings of every live connection.
 * This reads media, not elements (CLAUDE.md).
 */
export async function meshStats(page: Page, ms = 2000): Promise<MeshStats> {
  return page.evaluate(async (window_) => {
    const pcs = (window as unknown as { __trioPcs: RTCPeerConnection[] }).__trioPcs.filter((pc) => pc.connectionState === 'connected')
    type Reading = Map<string, Record<string, number>>
    const read = async (): Promise<Reading> => {
      const out: Reading = new Map()
      let i = 0
      for (const pc of pcs) {
        const report = await pc.getStats()
        report.forEach((s) => {
          if (s.type === 'outbound-rtp' || s.type === 'inbound-rtp') out.set(`${i}:${s.id}`, s as unknown as Record<string, number>)
        })
        i += 1
      }
      return out
    }
    const a = await read()
    const t0 = performance.now()
    await new Promise((resolve) => setTimeout(resolve, window_))
    const b = await read()
    const seconds = (performance.now() - t0) / 1000
    const result = {
      connected: pcs.length,
      outAudioBps: 0,
      outVideoBps: 0,
      inAudioBps: 0,
      inVideoBps: 0,
      hearing: 0,
      framesEncodedPerSecond: 0,
      maxSentHeight: 0,
      encodeLoad: 0,
      concealedShare: 0,
    }
    let concealed = 0
    let received = 0
    for (const [key, now] of b) {
      const before = a.get(key)
      if (!before) continue
      const bytes = ((now.bytesSent ?? now.bytesReceived ?? 0) - (before.bytesSent ?? before.bytesReceived ?? 0)) * 8 / seconds
      const kind = (now as unknown as { kind: string }).kind
      const type = (now as unknown as { type: string }).type
      if (type === 'outbound-rtp') {
        if (kind === 'audio') result.outAudioBps += bytes
        else {
          result.outVideoBps += bytes
          result.framesEncodedPerSecond += ((now.framesEncoded ?? 0) - (before.framesEncoded ?? 0)) / seconds
          result.maxSentHeight = Math.max(result.maxSentHeight, now.frameHeight ?? 0)
          result.encodeLoad += ((now.totalEncodeTime ?? 0) - (before.totalEncodeTime ?? 0)) / seconds
        }
      } else if (kind === 'audio') {
        result.inAudioBps += bytes
        if (bytes > 0 && (now.audioLevel ?? 0) > 0.0001) result.hearing += 1
        concealed += (now.concealedSamples ?? 0) - (before.concealedSamples ?? 0)
        received += (now.totalSamplesReceived ?? 0) - (before.totalSamplesReceived ?? 0)
      } else {
        result.inVideoBps += bytes
      }
    }
    result.concealedShare = received > 0 ? concealed / received : 0
    return result
  }, ms)
}

/**
 * Every page receives audio from every other person: per page, the inbound
 * audio streams whose bytes grow and whose level is above silence. The fake
 * microphone beeps every 500 ms, so a 2 s sample always holds beeps.
 */
export async function expectEverybodyHearing(people: Person[], timeout = 45_000): Promise<void> {
  const want = people.length - 1
  await expect
    .poll(
      async () => {
        const stats = await Promise.all(people.map((p) => meshStats(p.page, 1500)))
        return stats.map((s) => s.hearing >= want).every(Boolean)
      },
      { timeout, intervals: [500, 1000, 2000], message: `every page hears the other ${want}` },
    )
    .toBe(true)
}

export function round(value: number, digits = 0): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}
