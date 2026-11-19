/**
 * CONTRACT-V7-READING §7: the device code is shown with a QR of
 * `<origin>/#cihaz=<code>`; opening that link fills the code in on the join
 * screen, takes it out of the address bar, and the tap signs in as the same
 * person. The code never reaches the server in a URL.
 */
import path from 'node:path'
import { baseUrl, E2E_DIR, freshServer } from '../lib/server'
import { expect, expectConnected, newContext, personViaApi, test, type ContextOptions } from '../lib/trio'

const OUT = path.join(E2E_DIR, 'screenshots')
const PHONE: ContextOptions = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }

test.beforeEach(async () => {
  await freshServer()
})

test('the device code QR opens Trio with the code filled in', async ({ browser, trio }) => {
  const ayse = trio.add(await personViaApi(browser, 'Ayşe'))
  await ayse.page.getByTestId('btn-settings').click()
  const account = ayse.page.getByTestId('settings-account')
  await account.getByTestId('settings-add-device').click()
  const shown = (await account.getByTestId('link-code').textContent()) ?? ''
  const qr = account.getByTestId('link-code-qr')
  await expect(qr.getByTestId('qr-code')).toBeVisible()
  const url = (await qr.getAttribute('data-url')) ?? ''
  expect(url).toBe(`${baseUrl()}/#cihaz=${shown.replace('-', '')}`)
  expect(Number(await qr.getByTestId('qr-code').getAttribute('data-modules'))).toBeGreaterThanOrEqual(25)
  await qr.scrollIntoViewIfNeeded()
  await ayse.page.screenshot({ path: path.join(OUT, 'v7-reading-qr.png') })

  // The phone's camera opens the link.
  const context = await newContext(browser, PHONE)
  const page = await context.newPage()
  const requested: string[] = []
  page.on('request', (request) => requested.push(request.url()))
  await page.goto(url)
  await expect(page.getByTestId('join-form')).toHaveAttribute('data-mode', 'link')
  await expect(page.getByTestId('join-link-code')).toHaveValue(shown)
  // Out of the address bar (and so of the history) at once.
  await expect.poll(() => page.url()).toBe(`${baseUrl()}/`)
  const answer = page.waitForResponse((r) => r.url().endsWith('/api/join') && r.request().method() === 'POST')
  await page.getByTestId('join-submit').tap()
  expect((await answer).status()).toBe(200)
  await expectConnected(page)
  await expect(page.locator('.user-panel-name')).toContainText('Ayşe')
  const code = shown.replace('-', '')
  expect(requested.filter((u) => u.includes(code))).toEqual([])
  await context.close()
})
