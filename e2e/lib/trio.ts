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
  /** Runs on the new context before the first page is opened. */
  prepare?: (context: BrowserContext) => Promise<void>
}

/**
 * Wraps RTCPeerConnection so a test can reach every connection the app made
 * (for getStats), and remembers every camera and microphone track the page
 * opened (to check that one is really released). It changes nothing about
 * how the app uses them: the same objects are handed back.
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
  window.__trioCameraTracks = []
  window.__trioMicTracks = []
  const media = navigator.mediaDevices
  if (media && media.getUserMedia) {
    const getUserMedia = media.getUserMedia.bind(media)
    media.getUserMedia = async (constraints) => {
      const stream = await getUserMedia(constraints)
      window.__trioCameraTracks.push(...stream.getVideoTracks())
      window.__trioMicTracks.push(...stream.getAudioTracks())
      return stream
    }
  }
})()
`

/**
 * Every Content-Security-Policy violation any page of the current test hit
 * (CONTRACT-V3 §8). The app shell carries a CSP; the worklet, the wasm, blob:
 * and object URLs and the websocket must all still work under it, so ANY
 * violation fails the test (the `cspGuard` fixture below).
 */
const cspViolations: string[] = []

const CSP_PROBE = `
document.addEventListener('securitypolicyviolation', (event) => {
  console.error('CSP-VIOLATION ' + event.effectiveDirective + ' blocked ' + (event.blockedURI || '(inline)') +
    ' at ' + (event.sourceFile || location.href) + ':' + event.lineNumber)
})
`

function isCspMessage(text: string): boolean {
  return text.startsWith('CSP-VIOLATION') || /Content Security Policy/i.test(text)
}

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
  await context.addInitScript(CSP_PROBE)
  const throttle = Number(process.env.TRIO_E2E_CPU_THROTTLE ?? 0)
  if (throttle > 1) {
    // "A slow runner": every page of the suite's contexts runs its main thread this many times slower.
    context.on('page', (page) => {
      void context
        .newCDPSession(page)
        .then((cdp) => cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle }))
        .catch(() => undefined)
    })
  }
  context.on('console', (message) => {
    if (message.type() === 'error' && isCspMessage(message.text())) {
      cspViolations.push(`${message.page()?.url() ?? '?'}: ${message.text()}`)
    }
  })
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
  await options.prepare?.(context)
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

export const test = base.extend<{ trio: { people: Person[]; add: (p: Person) => Person }; cspGuard: void }>({
  trio: async ({}, use) => {
    const people: Person[] = []
    await use({ people, add: (p) => (people.push(p), p) })
    for (const person of people) await person.context.close().catch(() => undefined)
  },
  cspGuard: [
    async ({}, use) => {
      cspViolations.length = 0
      await use()
      const seen = [...cspViolations]
      cspViolations.length = 0
      expect(seen, 'no Content-Security-Policy violation on any page').toEqual([])
    },
    { auto: true },
  ],
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
        transceivers: pc.getTransceivers().map((t) => `${t.mid}:${t.direction}:${t.currentDirection}:${t.receiver.track.kind}:${t.receiver.track.id.slice(0, 6)}`),
      })),
    )
    const elements = await listener.page.evaluate(() =>
      [...document.querySelectorAll('audio, video')].map((e) => {
        const stream = (e as HTMLMediaElement).srcObject as MediaStream | null
        return `${e.getAttribute('data-testid')}=${stream?.id.slice(0, 6)}[${stream?.getTracks().map((t) => t.kind + ':' + t.id.slice(0, 6)).join(',')}]`
      }),
    )
    throw new Error(
      `${listener.name} should hear ${speaker.name}; last probe ${JSON.stringify(last)}; ` +
        `peer connections ${JSON.stringify(pcs)}; elements ${JSON.stringify(elements)}\n${String(error)}`,
    )
  }
}

/** Assert that what `listener` gets from `speaker` is silence (a muted microphone). */
export async function expectSilence(listener: Person, speaker: Person): Promise<void> {
  await expect
    .poll(async () => (await remoteAudioProbe(listener.page, speaker.user.id)).level, {
      timeout: 15_000,
      message: `${listener.name} should hear nothing from ${speaker.name}`,
    })
    .toBeLessThan(0.001)
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

// --- text ------------------------------------------------------------------------

/**
 * `count` messages `${prefix} 1..count` from `person` into `channelId`, through
 * a socket of their own (as the UI would send them, but without typing each).
 */
export async function bulkSend(person: Person, channelId: number, count: number, prefix: string): Promise<void> {
  await person.page.evaluate(
    async ([channel, total, text]) => {
      const token = localStorage.getItem('trio.token')!
      const ws = new WebSocket(`ws://${location.host}/ws?token=${encodeURIComponent(token)}`)
      await new Promise((resolve) => ws.addEventListener('message', resolve, { once: true }))
      let confirmed = 0
      const done = new Promise<void>((resolve) =>
        ws.addEventListener('message', (event) => {
          const frame = JSON.parse(String(event.data))
          if (frame.type === 'message.new' && frame.nonce?.startsWith('bulk-') && ++confirmed === total) resolve()
        }),
      )
      for (let i = 1; i <= total; i++) {
        // The prefix in the nonce too: a second batch by the same person must not be a replay of the first.
        ws.send(JSON.stringify({ type: 'message.send', channel_id: channel, content: `${text} ${i}`, nonce: `bulk-${text}-${i}` }))
      }
      await done
      ws.close()
    },
    [channelId, count, prefix] as const,
  )
}

// --- sessions and devices (CONTRACT-V3 §2) -----------------------------------------

/** `POST /api/link-codes` for a signed-in token: the code as the server sent it. */
export async function apiLinkCode(token: string): Promise<string> {
  const response = await fetch(`${baseUrl()}/api/link-codes`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (response.status !== 201) throw new Error(`link code: ${response.status} ${await response.text()}`)
  return ((await response.json()) as { code: string }).code
}

/** The HTTP status `GET /api/me` answers for a token (200 while it works, 401 once it does not). */
export async function meStatus(token: string): Promise<number> {
  const response = await fetch(`${baseUrl()}/api/me`, { headers: { Authorization: `Bearer ${token}` } })
  return response.status
}

/** On a join screen: "Zaten hesabım var", type `typed`, submit. Resolves with the join response. */
export async function joinWithCodeThroughUi(page: Page, typed: string) {
  await page.getByTestId('join-mode-link').click()
  await page.getByTestId('join-link-code').fill(typed)
  const answer = page.waitForResponse((r) => r.url().endsWith('/api/join') && r.request().method() === 'POST')
  await page.getByTestId('join-submit').click()
  return answer
}

/** A new browser context signed in through the join screen's device-code mode as an existing user. */
export async function linkedDevice(
  browser: Browser,
  owner: Person,
  code: string,
  options: ContextOptions = {},
): Promise<Person> {
  const context = await newContext(browser, options)
  const page = await context.newPage()
  await page.goto('/')
  const response = await joinWithCodeThroughUi(page, code)
  expect(response.status()).toBe(200)
  const body = (await response.json()) as { token: string; user: User }
  expect(body.user).toEqual(owner.user)
  await expectConnected(page)
  return { name: owner.name, context, page, user: body.user, token: body.token }
}

/** Type a message through the composer and wait for the server to confirm it. */
export async function sendThroughUi(person: Person, text: string): Promise<void> {
  await person.page.getByTestId('composer').fill(text)
  const composer = person.page.getByTestId('composer')
  // V7-READING §4: a touch-first device sends with the button, Enter is a newline.
  if ((await composer.getAttribute('data-enter')) === 'newline') await person.page.getByTestId('composer-send').click()
  else await composer.press('Enter')
  await expect(person.page.getByTestId('message').filter({ hasText: text }).last()).toHaveAttribute('data-status', 'sent')
}
