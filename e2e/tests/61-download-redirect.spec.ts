/**
 * CONTRACT-V6-DOWNLOAD: GET /indir/dosya/<platform>. A public repository
 * redirects to the asset's browser_download_url; a private one asks the asset
 * API with the token and sends the visitor to the signed address. The token
 * is never in any response.
 */
import { test, expect } from '@playwright/test'
import { FakeGitHub, NAMES, REPO, TOKEN, UA, VERSION, serverWithFake, visit } from '../lib/downloads'
import { baseUrl } from '../lib/server'

const fake = new FakeGitHub()

test.beforeAll(async () => {
  await fake.start()
})
test.afterAll(async () => {
  await fake.stop()
})
test.beforeEach(() => {
  fake.mode = 'ok'
  fake.signing = null
  fake.seen = []
})

test('public repository: 302 to the release asset, the browser gets the file', async ({ browser, request }) => {
  await serverWithFake(fake)
  const response = await request.get(`${baseUrl()}/indir/dosya/linux`, { maxRedirects: 0 })
  expect(response.status()).toBe(302)
  expect(response.headers()['location']).toBe(`${fake.url}/${REPO}/releases/download/v${VERSION}/${NAMES.linux}`)
  expect(response.headers()['cache-control']).toBe('no-store')

  const v = await visit(browser, { userAgent: UA.windows })
  const [download] = await Promise.all([v.page.waitForEvent('download'), v.page.getByTestId('indir-primary').click()])
  expect(download.suggestedFilename()).toBe(NAMES.windows)
  await v.close()
  expect(fake.seen.every((r) => r.authorization === undefined)).toBe(true)
})

test('unknown platforms are 404 and never reach GitHub', async ({ request }) => {
  await serverWithFake(fake)
  for (const platform of ['android', 'WINDOWS', 'windows.exe', 'linux%00', 'mac']) {
    const response = await request.get(`${baseUrl()}/indir/dosya/${platform}`, { maxRedirects: 0 })
    expect(response.status(), platform).toBe(404)
    expect((await response.json()).error.code).toBe('NOT_FOUND')
  }
  expect(fake.seen.filter((r) => r.path.includes('/releases/'))).toEqual([])
})

test('private repository: the token goes only to the API, the visitor goes to the signed address', async ({ request, browser }) => {
  await serverWithFake(fake, TOKEN)
  const listing = await request.get(`${baseUrl()}/api/downloads`)
  const text = await listing.text()
  expect(text).not.toContain(TOKEN)
  expect(JSON.stringify(listing.headers())).not.toContain(TOKEN)
  expect((await listing.json()).files.map((f: { platform: string }) => f.platform)).toEqual(['windows', 'mac-arm64', 'mac-x64', 'linux'])

  const response = await request.get(`${baseUrl()}/indir/dosya/mac-arm64`, { maxRedirects: 0 })
  expect(response.status()).toBe(302)
  expect(response.headers()['location']).toBe(`${fake.url}/storage/12?X-Amz-Signature=e2e`)
  expect(JSON.stringify(response.headers())).not.toContain(TOKEN)
  expect(await response.text()).not.toContain(TOKEN)

  const api = fake.seen.filter((r) => r.path.startsWith('/repos/'))
  expect(api.length).toBeGreaterThan(0)
  expect(api.every((r) => r.authorization === `Bearer ${TOKEN}`)).toBe(true)
  expect(fake.seen.find((r) => r.path === '/repos/friends/Trio/releases/assets/12')?.accept).toBe('application/octet-stream')
  // The signed storage host never sees the token.
  expect(fake.seen.filter((r) => r.path.startsWith('/storage/')).every((r) => r.authorization === undefined)).toBe(true)

  const v = await visit(browser, { userAgent: UA.windows })
  await expect(v.page.getByTestId('indir-file').first().getByTestId('indir-sha')).toBeVisible()
  expect(await v.page.content()).not.toContain(TOKEN)
  const [download] = await Promise.all([v.page.waitForEvent('download'), v.page.getByTestId('indir-primary').click()])
  expect(download.suggestedFilename()).toBe(NAMES.windows)
  await v.close()
})

test('downloads are rate-limited per address', async ({ request }) => {
  await serverWithFake(fake)
  const as = (address: string) => ({ maxRedirects: 0, headers: { 'X-Forwarded-For': address } })
  for (let i = 0; i < 20; i++) {
    expect((await request.get(`${baseUrl()}/indir/dosya/windows`, as('203.0.113.5'))).status()).toBe(302)
  }
  const refused = await request.get(`${baseUrl()}/indir/dosya/windows`, as('203.0.113.5'))
  expect(refused.status()).toBe(429)
  expect(Number(refused.headers()['retry-after'])).toBeGreaterThan(0)
  expect((await request.get(`${baseUrl()}/indir/dosya/windows`, as('203.0.113.6'))).status()).toBe(302)
})
