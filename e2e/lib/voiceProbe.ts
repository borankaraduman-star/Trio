/**
 * Probes for the V4 voice specs (26–29): per-pair inbound audio bytes with
 * the identity of the RTCPeerConnection carrying them, a switch in front of
 * one browser's websocket, and a WebAudio probe for the cue sounds.
 */
import type { BrowserContext, Page, WebSocketRoute } from '@playwright/test'
import { expect, type Person } from './trio'

export interface AudioSample {
  bytes: number
  /** A number given to the RTCPeerConnection the first time it is seen: same number, same object. */
  pc: number
}

/** `listener`'s inbound audio from `speaker`, and which connection it came on. */
export async function audioSample(listener: Person, speaker: Person): Promise<AudioSample> {
  return listener.page.evaluate(async (id) => {
    const w = window as unknown as {
      __trioPcs: RTCPeerConnection[]
      __trioPcTags?: WeakMap<RTCPeerConnection, number>
      __trioPcNext?: number
    }
    const element = document.querySelector<HTMLAudioElement>(`[data-testid="remote-audio-${id}"]`)
    const track = (element?.srcObject as MediaStream | null)?.getAudioTracks()[0]
    if (!track) return { bytes: -1, pc: -1 }
    w.__trioPcTags ??= new WeakMap()
    for (const pc of w.__trioPcs) {
      if (pc.connectionState === 'closed') continue
      if (!pc.getReceivers().some((r) => r.track === track)) continue
      let tag = w.__trioPcTags.get(pc)
      if (tag === undefined) {
        w.__trioPcNext = (w.__trioPcNext ?? 0) + 1
        tag = w.__trioPcNext
        w.__trioPcTags.set(pc, tag)
      }
      let bytes = -1
      ;(await pc.getStats(track)).forEach((s) => {
        if (s.type === 'inbound-rtp' && s.kind === 'audio') bytes = s.bytesReceived
      })
      return { bytes, pc: tag }
    }
    return { bytes: -1, pc: -1 }
  }, speaker.user.id)
}

/** How many RTCPeerConnections the page has ever made. */
export async function pcCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __trioPcs: unknown[] }).__trioPcs.length)
}

export type Pair = [listener: Person, speaker: Person]

export function pairs(people: Person[]): Pair[] {
  const result: Pair[] = []
  for (const listener of people) for (const speaker of people) if (listener !== speaker) result.push([listener, speaker])
  return result
}

export const pairName = ([listener, speaker]: Pair) => `${speaker.name}→${listener.name}`

export async function sampleAll(list: Pair[]): Promise<AudioSample[]> {
  return Promise.all(list.map(([listener, speaker]) => audioSample(listener, speaker)))
}

/**
 * Wait until every pair has received at least `minBytes` more audio than in
 * `since`, on the SAME connection object; the new samples.
 */
export async function expectAudioGrew(list: Pair[], since: AudioSample[], minBytes: number, what: string): Promise<AudioSample[]> {
  let last: AudioSample[] = since
  await expect
    .poll(
      async () => {
        last = await sampleAll(list)
        return last.map((s, i) => (s.pc === since[i].pc && s.bytes - since[i].bytes >= minBytes ? 'ok' : `${pairName(list[i])}:${s.pc}/${since[i].pc}:+${s.bytes - since[i].bytes}`))
      },
      { timeout: 30_000, message: what },
    )
    .toEqual(list.map(() => 'ok'))
  return last
}

/** A switch in front of one browser's websocket (installed before the page opens). */
export interface SocketSwitch {
  online: boolean
  /** Cut the current socket both ways: the page sees a drop, the server sees the client leave. */
  cut: () => Promise<void>
  prepare: (context: BrowserContext) => Promise<void>
}

export function socketSwitch(): SocketSwitch {
  let current: { page: WebSocketRoute; server: WebSocketRoute } | null = null
  const sw: SocketSwitch = {
    online: true,
    cut: async () => {
      sw.online = false
      const socket = current
      current = null
      if (!socket) return
      await socket.server.close({ code: 1000, reason: 'cut' }).catch(() => undefined)
      await socket.page.close({ code: 1011, reason: 'cut' }).catch(() => undefined)
    },
    prepare: (context) =>
      context.routeWebSocket(/\/ws/, (ws) => {
        if (!sw.online) {
          void ws.close({ code: 1011, reason: 'offline' })
          return
        }
        current = { page: ws, server: ws.connectToServer() }
      }),
  }
  return sw
}

/**
 * Records every cue the page plays (the `trio-cue` event of audio/cues.ts) and
 * every OscillatorNode started, so a test can see that a sound was SCHEDULED
 * on the WebAudio graph without listening for it.
 */
export const CUE_PROBE = `
(() => {
  if (window.__trioCues) return
  window.__trioCues = []
  window.__trioOscillators = 0
  window.addEventListener('trio-cue', (event) => window.__trioCues.push(event.detail.kind))
  const start = OscillatorNode.prototype.start
  OscillatorNode.prototype.start = function (...args) {
    window.__trioOscillators += 1
    return start.apply(this, args)
  }
})()
`

export async function cuesPlayed(page: Page): Promise<string[]> {
  return page.evaluate(() => [...((window as unknown as { __trioCues?: string[] }).__trioCues ?? [])])
}

export async function oscillatorsStarted(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __trioOscillators?: number }).__trioOscillators ?? 0)
}
