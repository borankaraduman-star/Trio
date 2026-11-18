/**
 * Fixtures and helpers shared by every spec: users as independent browser
 * contexts, joining through the UI or the API, and media probes.
 */
import { test as base, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { baseUrl, INVITE_CODE } from './server'

export { expect }

/** Seeded by the server on first start of an empty database. */
export const GENEL = 1
export const SOHBET = 2

export interface User {
  id: number
  name: string
}

export interface Person {
  name: string
  context: BrowserContext
  page: Page
  user: User
  token: string
}

export interface ContextOptions {
  viewport?: { width: number; height: number }
  deviceScaleFactor?: number
  isMobile?: boolean
  hasTouch?: boolean
}

/**
 * Wraps RTCPeerConnection so a test can reach every connection the app made
 * (for getStats). It changes nothing about how the app uses them.
 */
const PEER_CONNECTION_PROBE = `
(() => {
  const Native = window.RTCPeerConnection
  if (!Native || window.__trioPcs) return
  window.__trioPcs = []
  class Probed extends Native {
    constructor(...args) {
      super(...args)
      window.__trioPcs.push(this)
    }
  }
  window.RTCPeerConnection = Probed
})()
`

export async function newContext(browser: Browser, options: ContextOptions = {}): Promise<BrowserContext> {
  const context = await browser.newContext({
    baseURL: baseUrl(),
    viewport: options.viewport ?? { width: 1280, height: 800 },
    deviceScaleFactor: options.deviceScaleFactor ?? 1,
    isMobile: options.isMobile,
    hasTouch: options.hasTouch,
    locale: 'tr-TR',
    timezoneId: 'Europe/Istanbul',
    permissions: ['microphone', 'camera'],
  })
  await context.addInitScript(PEER_CONNECTION_PROBE)
  if (process.env.TRIO_E2E_CONSOLE) {
    context.on('console', (message) => {
      if (message.type() === 'warning' || message.type() === 'error') {
        console.log(`[browser ${message.type()}] ${message.text()}`)
      }
    })
  }
  return context
}

export async function apiJoin(name: string): Promise<{ token: string; user: User }> {
  const response = await fetch(`${baseUrl()}/api/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ invite_code: INVITE_CODE, name }),
  })
  if (response.status !== 201) throw new Error(`join ${name}: ${response.status} ${await response.text()}`)
  return (await response.json()) as { token: string; user: User }
}

export async function api<T>(token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(`${baseUrl()}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`)
  return (await response.json()) as T
}

/** Fill the join form and submit it. */
export async function joinThroughUi(page: Page, name: string, code = INVITE_CODE): Promise<void> {
  await page.getByTestId('join-name').fill(name)
  await page.getByTestId('join-code').fill(code)
  await page.getByTestId('join-submit').click()
}

/** The session is up: socket open, `ready` seen, the channel's messages loaded. */
export async function expectConnected(page: Page): Promise<void> {
  await expect(page.getByTestId('composer')).toBeVisible()
  await expect(page.locator('.banner')).toHaveCount(0)
  await expect(page.locator('.user-panel-name span')).toHaveText('Çevrimiçi')
  await expect(page.locator('.list-note', { hasText: 'Yükleniyor' })).toHaveCount(0)
}

/** A user who joined through the UI. */
export async function personViaUi(browser: Browser, name: string, options: ContextOptions = {}): Promise<Person> {
  const context = await newContext(browser, options)
  const page = await context.newPage()
  await page.goto('/')
  const joined = page.waitForResponse((r) => r.url().endsWith('/api/join') && r.request().method() === 'POST')
  await joinThroughUi(page, name)
  const response = await joined
  expect(response.status()).toBe(201)
  const body = (await response.json()) as { token: string; user: User }
  await expectConnected(page)
  return { name, context, page, user: body.user, token: body.token }
}

/** A browser that starts with a stored session (token + user in localStorage). */
export async function personWithSession(
  browser: Browser,
  name: string,
  session: { token: string; user: User },
  options: ContextOptions = {},
): Promise<Person> {
  const { token, user } = session
  const context = await newContext(browser, options)
  // Only the first load is seeded: a later logout must be able to clear it.
  await context.addInitScript(
    ([t, u]) => {
      if (!sessionStorage.getItem('trio.e2e.seeded')) {
        sessionStorage.setItem('trio.e2e.seeded', '1')
        localStorage.setItem('trio.token', t)
        localStorage.setItem('trio.user', u)
      }
    },
    [token, JSON.stringify(user)] as const,
  )
  const page = await context.newPage()
  await page.goto('/')
  await expectConnected(page)
  return { name, context, page, user, token }
}

/** A user who joined through the API; the browser starts with the stored session. */
export async function personViaApi(browser: Browser, name: string, options: ContextOptions = {}): Promise<Person> {
  return personWithSession(browser, name, await apiJoin(name), options)
}

/** Join all three through the API, each in their own context. */
export async function threePeople(browser: Browser, trio: { add: (p: Person) => Person }, options: ContextOptions = {}) {
  const people: Person[] = []
  for (const name of NAMES) people.push(trio.add(await personViaApi(browser, name, options)))
  return people
}

export const NAMES = ['Ayşe', 'Mehmet', 'Zeynep'] as const

export const test = base.extend<{ trio: { people: Person[]; add: (p: Person) => Person } }>({
  trio: async ({}, use) => {
    const people: Person[] = []
    await use({ people, add: (p) => (people.push(p), p) })
    for (const person of people) await person.context.close().catch(() => undefined)
  },
})

// --- voice ---------------------------------------------------------------------

export async function joinVoice(person: Person, channelId = SOHBET): Promise<void> {
  await person.page.getByTestId(`channel-${channelId}`).click()
  await expect(person.page.locator('.voice-status strong')).toHaveText('Ses bağlı')
}

/**
 * For the `<audio data-testid="remote-audio-<id>">` element: the RTP counters
 * of the receiver whose track it plays, and the peak level heard on it.
 */
export async function remoteAudioProbe(
  page: Page,
  userId: number,
): Promise<{ packets: number; bytes: number; level: number; playing: boolean }> {
  return page.evaluate(async (id) => {
    const element = document.querySelector<HTMLAudioElement>(`[data-testid="remote-audio-${id}"]`)
    if (!element) throw new Error(`no remote-audio-${id}`)
    const stream = element.srcObject as MediaStream | null
    const track = stream?.getAudioTracks()[0]
    if (!stream || !track) throw new Error(`remote-audio-${id} has no audio track`)

    const pcs = (window as unknown as { __trioPcs: RTCPeerConnection[] }).__trioPcs
    let packets = -1
    let bytes = -1
    for (const pc of pcs) {
      if (pc.connectionState === 'closed') continue
      if (!pc.getReceivers().some((r) => r.track === track)) continue
      const report = await pc.getStats(track)
      report.forEach((s) => {
        if (s.type === 'inbound-rtp' && s.kind === 'audio') {
          packets = s.packetsReceived
          bytes = s.bytesReceived
        }
      })
    }

    // What is actually audible on that stream, measured for 1.5 s.
    const context = new AudioContext()
    await context.resume()
    const source = context.createMediaStreamSource(stream)
    const analyser = context.createAnalyser()
    analyser.fftSize = 2048
    source.connect(analyser)
    const data = new Float32Array(analyser.fftSize)
    let level = 0
    const until = performance.now() + 1500
    while (performance.now() < until) {
      analyser.getFloatTimeDomainData(data)
      for (const sample of data) level = Math.max(level, Math.abs(sample))
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    source.disconnect()
    await context.close()
    return { packets, bytes, level, playing: !element.paused && element.readyState >= 2 }
  }, userId)
}

/** Assert that `listener` really receives `speaker`'s microphone. */
export async function expectHearing(listener: Person, speaker: Person): Promise<void> {
  const audio = listener.page.getByTestId(`remote-audio-${speaker.user.id}`)
  await expect(audio).toHaveCount(1, { timeout: 20_000 })
  let first = await remoteAudioProbe(listener.page, speaker.user.id)
  let last = first
  try {
    await expect
      .poll(
        async () => {
          const next = await remoteAudioProbe(listener.page, speaker.user.id)
          last = next
          const growing = next.packets > first.packets && next.bytes > first.bytes && first.packets >= 0
          if (!growing) first = next
          return growing && next.level > 0.01 && next.playing
        },
        { timeout: 20_000 },
      )
      .toBe(true)
  } catch (error) {
    const pcs = await listener.page.evaluate(() =>
      (window as unknown as { __trioPcs: RTCPeerConnection[] }).__trioPcs.map((pc) => ({
        connection: pc.connectionState,
        ice: pc.iceConnectionState,
        signaling: pc.signalingState,
        receivers: pc.getReceivers().map((r) => `${r.track.kind}:${r.track.readyState}:${r.track.muted}`),
      })),
    )
    throw new Error(
      `${listener.name} should hear ${speaker.name}; last probe ${JSON.stringify(last)}; ` +
        `peer connections ${JSON.stringify(pcs)}\n${String(error)}`,
    )
  }
}

/** Assert that the page shows `count` remote screens and every one is decoding frames. */
export async function expectScreensDecoding(page: Page, count: number): Promise<void> {
  const videos = page.getByTestId('remote-video')
  await expect(videos).toHaveCount(count, { timeout: 20_000 })
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const elements = [...document.querySelectorAll<HTMLVideoElement>('[data-testid="remote-video"]')]
          const sample = () =>
            elements.map((v) => ({
              w: v.videoWidth,
              t: v.currentTime,
              f: v.getVideoPlaybackQuality().totalVideoFrames,
            }))
          const a = sample()
          await new Promise((resolve) => setTimeout(resolve, 700))
          const b = sample()
          return a.every((x, i) => x.w > 0 && b[i].w > 0 && b[i].t > x.t && b[i].f > x.f)
        }),
      { timeout: 20_000, message: 'every remote screen should be decoding' },
    )
    .toBe(true)
}
