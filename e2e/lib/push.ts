/**
 * CONTRACT-V6-PUSH in the browser, without a real push service.
 *
 * Chromium here cannot reach FCM, so `pushManager.subscribe()` cannot return a
 * real subscription (it fails with "Registration failed"). What CAN be proven:
 *
 * - a FAKE PUSH SERVICE (`FakePushService`, a local HTTP server) that the
 *   server is told about with the test-only `TRIO_TEST_PUSH_SERVICE`; it
 *   receives exactly what FCM would (an aes128gcm body and a VAPID header),
 *   and the test decrypts the body with the subscription keys it made itself;
 * - a stand-in `PushManager.subscribe` (`fakeSubscriptionScript`) that hands
 *   the page a subscription naming that service and those keys — the rest of
 *   the client (the PUT, the settings, the device list) is the real code;
 * - the service worker's own `push` handler, driven with CDP's
 *   `ServiceWorker.deliverPushMessage` (`deliverPush`).
 *
 * The notification specs run in Chromium's new headless mode (`channel:
 * 'chromium'`): the old headless shell reports `Notification.permission` as
 * "denied" whatever is granted, and refuses `showNotification`.
 */
import crypto from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { BrowserContext, Page } from '@playwright/test'

export const NEW_HEADLESS = { channel: 'chromium' as const }

const b64url = (data: Buffer | Uint8Array): string => Buffer.from(data).toString('base64url')

/** A browser's subscription keys, held by the test so it can read what is pushed. */
export class FakeDevice {
  readonly ecdh = crypto.createECDH('prime256v1')
  readonly auth = crypto.randomBytes(16)
  readonly publicKey: Buffer

  constructor(readonly endpoint: string) {
    this.publicKey = this.ecdh.generateKeys() as Buffer
  }

  get p256dh(): string {
    return b64url(this.publicKey)
  }

  get authB64(): string {
    return b64url(this.auth)
  }

  /** RFC 8291: what the browser does with a push body. */
  decrypt(body: Buffer): unknown {
    const salt = body.subarray(0, 16)
    const idlen = body[20]
    const asPublic = body.subarray(21, 21 + idlen)
    const ciphertext = body.subarray(21 + idlen)
    const shared = this.ecdh.computeSecret(asPublic)
    const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), this.publicKey, asPublic])
    const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, this.auth, keyInfo, 32))
    const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
    const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
    const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce)
    decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16))
    const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()])
    let end = padded.length
    while (end > 0 && padded[end - 1] === 0) end -= 1
    if (padded[end - 1] !== 2) throw new Error('no last-record delimiter')
    return JSON.parse(padded.subarray(0, end - 1).toString('utf8'))
  }
}

export interface PushRequest {
  path: string
  headers: http.IncomingHttpHeaders
  body: Buffer
}

/** Verify `Authorization: vapid t=<jwt>, k=<key>` (ES256 over the raw key); the claims. */
export function verifyVapid(header: string | undefined, publicKey: string): Record<string, unknown> {
  const match = /^vapid t=([^,]+), k=(\S+)$/.exec(header ?? '')
  if (!match) throw new Error(`not a vapid header: ${header}`)
  const [, token, k] = match
  if (k !== publicKey) throw new Error('k= is not the server key')
  const raw = Buffer.from(k, 'base64url')
  const key = crypto.createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: b64url(raw.subarray(1, 33)), y: b64url(raw.subarray(33, 65)) },
    format: 'jwk',
  })
  const [head, body, signature] = token.split('.')
  const ok = crypto.verify('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))
  if (!ok) throw new Error('VAPID signature does not verify')
  return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>
}

/** A push service on 127.0.0.1 that records every request and answers 201. */
export class FakePushService {
  readonly requests: PushRequest[] = []
  private server: http.Server | null = null
  origin = ''

  async start(): Promise<void> {
    this.server = http.createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        this.requests.push({ path: request.url ?? '', headers: request.headers, body: Buffer.concat(chunks) })
        response.writeHead(201).end()
      })
    })
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve))
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()))
  }

  device(name: string): FakeDevice {
    return new FakeDevice(`${this.origin}/push/${name}`)
  }

  to(device: FakeDevice): PushRequest[] {
    return this.requests.filter((r) => `${this.origin}${r.path}` === device.endpoint)
  }
}

/**
 * Replaces `PushManager.subscribe/getSubscription` with one that returns a
 * subscription to the fake service with `device`'s keys. Everything the app
 * does with it afterwards is the real code.
 */
export function fakeSubscriptionScript(device: FakeDevice): { content: string } {
  const config = JSON.stringify({ endpoint: device.endpoint, p256dh: device.p256dh, auth: device.authB64 })
  return {
    content: `(() => {
  const cfg = Object.assign(${config}, { subscribed: false, key: null })
  window.__trioFakePush = cfg
  const bytes = (s) => {
    const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4))
    return Uint8Array.from(b, (c) => c.charCodeAt(0)).buffer
  }
  const make = () => ({
    endpoint: cfg.endpoint,
    expirationTime: null,
    options: { userVisibleOnly: true, applicationServerKey: cfg.key },
    getKey: (name) => bytes(name === 'p256dh' ? cfg.p256dh : cfg.auth),
    unsubscribe: async () => { cfg.subscribed = false; return true },
    toJSON: () => ({ endpoint: cfg.endpoint, keys: { p256dh: cfg.p256dh, auth: cfg.auth } }),
  })
  if (typeof PushManager === 'undefined') return
  PushManager.prototype.subscribe = async function (options) {
    if (Notification.permission !== 'granted') throw new DOMException('permission denied', 'NotAllowedError')
    cfg.subscribed = true
    cfg.key = options.applicationServerKey
    return make()
  }
  PushManager.prototype.getSubscription = async function () {
    return cfg.subscribed ? make() : null
  }
})()`,
  }
}

/** "Not looking at the page" on demand: lib/viewing.ts reads hasFocus(). */
export const AWAY_SCRIPT = {
  content: `(() => {
  const hasFocus = document.hasFocus.bind(document)
  document.hasFocus = () => (window.__trioAway ? false : hasFocus())
})()`,
}

export async function setAway(page: Page, away: boolean): Promise<void> {
  await page.evaluate((value) => {
    ;(window as unknown as { __trioAway: boolean }).__trioAway = value
    window.dispatchEvent(new Event(value ? 'blur' : 'focus'))
  }, away)
}

/** What the push service would hand the worker, delivered through CDP to the page's registration. */
export async function deliverPush(context: BrowserContext, page: Page, origin: string, payload: unknown): Promise<void> {
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined))
  const cdp = await context.newCDPSession(page)
  const registrationId = new Promise<string>((resolve) => {
    cdp.on('ServiceWorker.workerRegistrationUpdated', (event: { registrations: { registrationId: string; isDeleted: boolean }[] }) => {
      const live = event.registrations.find((r) => !r.isDeleted)
      if (live) resolve(live.registrationId)
    })
  })
  await cdp.send('ServiceWorker.enable')
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload)
  await cdp.send('ServiceWorker.deliverPushMessage', { origin, registrationId: await registrationId, data })
  await cdp.detach()
}

export interface ShownNotification {
  title: string
  body: string
  tag: string
  data: { kind?: string; channel_id?: number | null; count?: number } | null
}

export async function shownNotifications(page: Page): Promise<ShownNotification[]> {
  return page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready
    return (await registration.getNotifications()).map((n) => ({ title: n.title, body: n.body, tag: n.tag, data: n.data }))
  })
}
