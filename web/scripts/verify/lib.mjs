// Shared helpers for the v2 verification scripts (run against a real server
// serving the BUILT client: TRIO_STATIC_DIR=web/dist). Plain Node ESM +
// Playwright; no test runner, so they can later be folded into the e2e suite.
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
export const { chromium } = require('playwright')

export const BASE = process.env.TRIO_URL ?? 'http://localhost:8000'
export const INVITE = process.env.TRIO_INVITE_CODE ?? 'test'
export const HERE = dirname(fileURLToPath(import.meta.url))
export const SHOTS = join(HERE, 'shots')
mkdirSync(SHOTS, { recursive: true })

/** Every RTCPeerConnection the app makes, reachable for getStats (changes nothing else). */
const PC_PROBE = `
(() => {
  const Native = window.RTCPeerConnection
  if (!Native || window.__trioPcs) return
  window.__trioPcs = []
  window.RTCPeerConnection = class extends Native {
    constructor(...args) { super(...args); window.__trioPcs.push(this) }
  }
  // Every camera track the page opens, to check that stopping really releases it.
  window.__trioCameraTracks = []
  const media = navigator.mediaDevices
  if (media && media.getUserMedia) {
    const gum = media.getUserMedia.bind(media)
    media.getUserMedia = async (constraints) => {
      const stream = await gum(constraints)
      if (constraints && constraints.video) window.__trioCameraTracks.push(...stream.getVideoTracks())
      if (constraints && constraints.audio) (window.__trioMicTracks ??= []).push(...stream.getAudioTracks())
      return stream
    }
  }
})()
`

export async function launch(extraArgs = []) {
  return chromium.launch({
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      ...extraArgs,
    ],
  })
}

/**
 * An account per name, reused across runs (the server allows 10 joins per 10
 * minutes per address and TRIO_MAX_USERS accounts): tokens are kept in a file
 * in the temp dir, keyed by server URL, and checked with /api/me.
 */
async function tokenCache() {
  const { readFileSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const path = join(tmpdir(), 'trio-verify-accounts.json')
  let data = {}
  try {
    data = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    data = {}
  }
  return { data, save: () => writeFileSync(path, JSON.stringify(data)) }
}

export async function apiJoin(name) {
  const cache = await tokenCache()
  const key = `${BASE} ${name}`
  const known = cache.data[key]
  if (known) {
    const me = await fetch(`${BASE}/api/me`, { headers: { Authorization: `Bearer ${known.token}` } })
    if (me.ok) return known
  }
  const response = await fetch(`${BASE}/api/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ invite_code: INVITE, name }),
  })
  if (response.status !== 201) throw new Error(`join failed: ${response.status} ${await response.text()}`)
  const joined = await response.json()
  cache.data[key] = joined
  cache.save()
  return joined
}

/** A signed-in user in a fresh context. `settings` is written to `trio.settings` before load. */
export async function person(browser, name, { settings, viewport, scale = 1, logConsole = true } = {}) {
  const { token, user } = await apiJoin(name)
  const context = await browser.newContext({
    baseURL: BASE,
    viewport: viewport ?? { width: 1280, height: 800 },
    deviceScaleFactor: scale,
    locale: 'tr-TR',
    timezoneId: 'Europe/Istanbul',
    permissions: ['microphone', 'camera'],
  })
  await context.addInitScript(PC_PROBE)
  await context.addInitScript(
    ([t, u, s]) => {
      localStorage.setItem('trio.token', t)
      localStorage.setItem('trio.user', u)
      if (s && !sessionStorage.getItem('trio.verify.settings-set')) {
        localStorage.setItem('trio.settings', s)
        sessionStorage.setItem('trio.verify.settings-set', '1')
      }
    },
    [token, JSON.stringify(user), settings ? JSON.stringify(settings) : null],
  )
  const page = await context.newPage()
  const logs = []
  page.on('console', (message) => {
    const line = `[${user.name} ${message.type()}] ${message.text()}`
    logs.push(line)
    if (logConsole && (message.type() === 'warning' || message.type() === 'error')) console.log(line)
  })
  page.on('pageerror', (error) => console.log(`[${user.name} pageerror] ${error.message}`))
  await page.goto('/')
  await page.getByTestId('composer').waitFor()
  return { context, page, user, token, logs }
}

export async function channels(token) {
  const response = await fetch(`${BASE}/api/channels`, { headers: { Authorization: `Bearer ${token}` } })
  return (await response.json()).channels
}

export async function joinVoice(p, channelId) {
  await p.page.getByTestId(`channel-${channelId}`).click()
  await p.page.getByTestId(`voice-user-${p.user.id}`).waitFor({ timeout: 15000 })
  await p.page.locator('.voice-status .ok').waitFor({ timeout: 15000 })
}

export function check(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`)
  console.log(`  ok  ${message}`)
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Waits until `fn` returns truthy (polling), or throws with `what`. */
export async function until(fn, what, timeout = 15000) {
  const end = Date.now() + timeout
  let last
  while (Date.now() < end) {
    last = await fn()
    if (last) return last
    await sleep(200)
  }
  throw new Error(`timed out: ${what} (last: ${JSON.stringify(last)})`)
}

/** Decoding facts about a <video>: size and whether frames advance. */
export async function videoFacts(page, selector) {
  return page.evaluate(async (sel) => {
    const v = document.querySelector(sel)
    if (!v) return null
    const frames = () => v.getVideoPlaybackQuality?.().totalVideoFrames ?? 0
    const f0 = frames()
    const t0 = v.currentTime
    await new Promise((r) => setTimeout(r, 700))
    return {
      width: v.videoWidth,
      height: v.videoHeight,
      advancing: frames() > f0 || v.currentTime > t0,
      frames: frames(),
      kind: v.dataset.kind ?? null,
      trackSettings: v.srcObject?.getVideoTracks?.()[0]?.getSettings?.() ?? null,
    }
  }, selector)
}

/**
 * Inbound audio energy from one remote peer, measured on the receiving side
 * with getStats over `ms`: the growth of totalAudioEnergy per second (0 = silence).
 */
export async function inboundAudioEnergy(page, ms = 1000) {
  return page.evaluate(async (window_) => {
    const read = async () => {
      let energy = 0
      let duration = 0
      for (const pc of window.__trioPcs ?? []) {
        if (pc.connectionState === 'closed') continue
        const stats = await pc.getStats()
        stats.forEach((s) => {
          if (s.type === 'inbound-rtp' && s.kind === 'audio') {
            energy += s.totalAudioEnergy ?? 0
            duration += s.totalSamplesDuration ?? 0
          }
        })
      }
      return { energy, duration }
    }
    const a = await read()
    await new Promise((r) => setTimeout(r, window_))
    const b = await read()
    const dt = b.duration - a.duration
    return dt > 0 ? (b.energy - a.energy) / dt : 0
  }, ms)
}

/** Writes a 48 kHz mono 16-bit WAV of `seconds` from `sample(t)` (in -1..1) into the temp dir. */
export async function wavFile(name, seconds, sample) {
  const { writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
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
  const path = join(tmpdir(), name)
  writeFileSync(path, buffer)
  return path
}

/** A voiced, syllable-modulated harmonic signal: close enough to speech for the suppressors. */
export const voiceish = (t) =>
  0.22 *
  (Math.sin(2 * Math.PI * 150 * t) +
    0.6 * Math.sin(2 * Math.PI * 300 * t) +
    0.4 * Math.sin(2 * Math.PI * 450 * t) +
    0.3 * Math.sin(2 * Math.PI * 600 * t) +
    0.2 * Math.sin(2 * Math.PI * 900 * t)) *
  (0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t))

/** Steady white noise (deterministic). */
export function noise() {
  let seed = 12345
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return 0.3 * ((seed / 0x7fffffff) * 2 - 1)
  }
}
