/**
 * CONTRACT-V6-DOWNLOAD: the page when GitHub cannot be reached, when a build
 * is signed, and the screenshots (desktop, 390 px, phone).
 */
import { test, expect } from '@playwright/test'
import { FakeGitHub, UA, serverWithFake, visit } from '../lib/downloads'

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
})

test('GitHub down with nothing cached: downloads are temporarily unavailable, the browser path stays', async ({ browser, request }) => {
  fake.mode = 503
  const state = await serverWithFake(fake)
  const body = await (await request.get(`http://127.0.0.1:${state.port}/api/downloads`)).json()
  expect(body).toEqual({ version: null, published_at: null, signed: { windows: false, mac: false }, files: [] })
  const v = await visit(browser, { userAgent: UA.windows })
  await expect(v.page.getByTestId('indir-unavailable')).toContainText('İndirmeler şu an kullanılamıyor')
  await expect(v.page.getByTestId('indir-primary')).toHaveCount(0)
  await expect(v.page.getByTestId('indir-browser')).toBeVisible()
  await v.close()
})

test('a signed platform hides its warning help; an unsigned one keeps it', async ({ browser }) => {
  fake.signing = { windows: true, mac: false }
  await serverWithFake(fake)
  const v = await visit(browser, { userAgent: UA.windows })
  await expect(v.page.getByTestId('indir-signed-windows')).toBeVisible()
  await expect(v.page.getByTestId('indir-smartscreen')).toHaveCount(0)
  await v.page.getByTestId('indir-help-mac').locator('summary').click()
  await expect(v.page.getByTestId('indir-mac-drawing')).toBeVisible()
  await expect(v.page.getByTestId('indir-why')).toBeVisible()
  await v.close()

  fake.signing = { windows: true, mac: true }
  await serverWithFake(fake)
  const both = await visit(browser, { userAgent: UA.mac })
  await expect(both.page.getByTestId('indir-signed-mac')).toBeVisible()
  await expect(both.page.getByTestId('indir-mac-drawing')).toHaveCount(0)
  await expect(both.page.getByTestId('indir-why')).toHaveCount(0)
  await both.close()
})

test('screenshots: desktop, 390 px and a phone', async ({ browser }) => {
  await serverWithFake(fake)
  const desktop = await visit(browser, { userAgent: UA.windows, width: 1280, height: 900 })
  await expect(desktop.page.getByTestId('indir-primary')).toBeVisible()
  await desktop.page.screenshot({ path: 'screenshots/v6-download-desktop.png', fullPage: true })
  await desktop.close()

  const narrow = await visit(browser, { userAgent: UA.windows, width: 390, height: 844 })
  await expect(narrow.page.getByTestId('indir-primary')).toBeVisible()
  // Nothing wider than the screen.
  const overflow = await narrow.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(0)
  await narrow.page.screenshot({ path: 'screenshots/v6-download-390.png', fullPage: true })
  await narrow.close()

  const phone = await visit(browser, { userAgent: UA.iphone, width: 390, height: 844, isMobile: true })
  await expect(phone.page.getByTestId('indir-phone')).toBeVisible()
  await phone.page.screenshot({ path: 'screenshots/v6-download-phone-390.png' })
  await phone.close()
})
