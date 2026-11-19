/**
 * CONTRACT-V6-DOWNLOAD in the e2e suite: a fake GitHub (REST API, release
 * download host and the signed storage host, all on one local port) and a way
 * to open /indir as a given operating system.
 *
 * The Trio server is pointed at it with TRIO_GITHUB_API_URL and
 * TRIO_GITHUB_DOWNLOAD_URL; nothing here reaches the real GitHub.
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Browser, BrowserContext, Page } from '@playwright/test'
import { expect } from '@playwright/test'
import { baseUrl, freshServer } from './server'

export const REPO = 'friends/Trio'
export const TOKEN = 'ghp_E2E-SECRET-never-on-the-wire'
export const VERSION = '0.5.0'
export const SHA = {
  windows: '3b0a'.repeat(16),
  'mac-arm64': '9c1e'.repeat(16),
  linux: '07fd'.repeat(16),
}

export const NAMES = {
  windows: `Trio-${VERSION}-win-x64.exe`,
  'mac-arm64': `Trio-${VERSION}-mac-arm64.dmg`,
  'mac-x64': `Trio-${VERSION}-mac-x64.dmg`,
  linux: `Trio-${VERSION}-linux-x86_64.AppImage`,
} as const

export const UA = {
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
}

export interface SeenRequest {
  path: string
  authorization: string | undefined
  accept: string | undefined
}

export class FakeGitHub {
  readonly server: http.Server
  url = ''
  /** What /releases/latest answers: 'ok', or an HTTP status to fail with. */
  mode: 'ok' | number = 'ok'
  signing: { windows: boolean; mac: boolean } | null = null
  seen: SeenRequest[] = []

  constructor() {
    this.server = http.createServer((req, res) => this.handle(req, res))
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  /** Env for `freshServer`: this fake as GitHub, optionally with a token (a private repo). */
  env(token: string | null = null): Record<string, string> {
    return {
      TRIO_RELEASES_REPO: REPO,
      TRIO_GITHUB_API_URL: this.url,
      TRIO_GITHUB_DOWNLOAD_URL: this.url,
      ...(token ? { TRIO_GITHUB_TOKEN: token } : {}),
    }
  }

  private assets() {
    const list: { id: number; name: string; size: number; digest?: string }[] = [
      { id: 11, name: NAMES.windows, size: 96_468_992, digest: `sha256:${SHA.windows}` },
      { id: 12, name: NAMES['mac-arm64'], size: 118_489_088 },
      { id: 13, name: NAMES['mac-x64'], size: 123_731_968 },
      { id: 14, name: NAMES.linux, size: 127_926_272 },
      { id: 15, name: 'SHA256SUMS.txt', size: 300 },
    ]
    if (this.signing) list.push({ id: 16, name: 'signing.json', size: 40 })
    return list.map((a) => ({
      ...a,
      state: 'uploaded',
      url: `${this.url}/repos/${REPO}/releases/assets/${a.id}`,
      browser_download_url: `${this.url}/${REPO}/releases/download/v${VERSION}/${a.name}`,
    }))
  }

  private content(name: string): string | null {
    if (name === 'SHA256SUMS.txt') {
      return `${SHA.windows}  ${NAMES.windows}\n${SHA['mac-arm64']}  ${NAMES['mac-arm64']}\n${SHA.linux}  ${NAMES.linux}\n`
    }
    if (name === 'signing.json') return this.signing ? JSON.stringify(this.signing) : null
    if ((Object.values(NAMES) as string[]).includes(name)) return `fake installer ${name}\n`
    return null
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const path = (req.url ?? '/').split('?')[0]
    this.seen.push({ path, authorization: req.headers.authorization, accept: req.headers.accept })
    const send = (status: number, body: string, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/octet-stream', ...headers })
      res.end(body)
    }
    if (path === `/repos/${REPO}/releases/latest`) {
      if (this.mode !== 'ok') return send(this.mode, '{}')
      return send(
        200,
        JSON.stringify({
          tag_name: `v${VERSION}`,
          name: `Trio v${VERSION}`,
          draft: false,
          prerelease: false,
          published_at: '2026-11-18T09:30:00Z',
          assets: this.assets(),
        }),
        { 'Content-Type': 'application/json' },
      )
    }
    const asset = /^\/repos\/friends\/Trio\/releases\/assets\/(\d+)$/.exec(path)
    if (asset) {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(404, '{}')
      return send(302, '', { Location: `${this.url}/storage/${asset[1]}?X-Amz-Signature=e2e` })
    }
    const stored = /^\/storage\/(\d+)$/.exec(path)
    if (stored) {
      const name = this.assets().find((a) => a.id === Number(stored[1]))?.name ?? ''
      const body = this.content(name)
      return body === null ? send(404, '') : send(200, body, { 'Content-Disposition': `attachment; filename=${name}` })
    }
    const released = new RegExp(`^/${REPO}/releases/download/v${VERSION}/(.+)$`).exec(path)
    if (released) {
      const body = this.content(decodeURIComponent(released[1]))
      return body === null
        ? send(404, '')
        : send(200, body, { 'Content-Disposition': `attachment; filename=${released[1]}` })
    }
    send(404, '')
  }
}

/** A fresh Trio server that takes `fake` for GitHub. */
export async function serverWithFake(fake: FakeGitHub, token: string | null = null, extra: Record<string, string> = {}) {
  return freshServer({ ...fake.env(token), ...extra })
}

export interface Visit {
  context: BrowserContext
  page: Page
  /** CSP violations this page hit; asserted empty by `close`. */
  csp: string[]
  close(): Promise<void>
}

/** Open a page of the running server as a browser with this user agent. */
export async function visit(
  browser: Browser,
  options: { userAgent: string; width?: number; height?: number; isMobile?: boolean; path?: string; desktop?: boolean },
): Promise<Visit> {
  const context = await browser.newContext({
    baseURL: baseUrl(),
    userAgent: options.userAgent,
    viewport: { width: options.width ?? 1280, height: options.height ?? 900 },
    isMobile: options.isMobile,
    hasTouch: options.isMobile,
    locale: 'tr-TR',
    timezoneId: 'Europe/Istanbul',
    acceptDownloads: true,
  })
  const csp: string[] = []
  await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      console.error(`CSP-VIOLATION ${event.effectiveDirective} ${event.blockedURI}`)
    })
  })
  if (options.desktop) {
    await context.addInitScript(() => {
      ;(window as unknown as { trioDesktop: unknown }).trioDesktop = {
        isDesktop: true,
        setPttKey: () => undefined,
        onPtt: () => () => undefined,
      }
    })
  }
  context.on('console', (message) => {
    if (message.type() === 'error' && /CSP-VIOLATION|Content Security Policy/.test(message.text())) csp.push(message.text())
  })
  const page = await context.newPage()
  await page.goto(options.path ?? '/indir')
  return {
    context,
    page,
    csp,
    async close() {
      await context.close()
      expect(csp, 'no CSP violation on the download page').toEqual([])
    },
  }
}
