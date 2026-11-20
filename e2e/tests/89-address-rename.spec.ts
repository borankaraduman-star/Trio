/**
 * CONTRACT-V11-ADDRESS §8–§9, the rename path: the server announces its next
 * address (TRIO_NEXT_URL = http://localhost:<port>) while it is still reached
 * at http://127.0.0.1:<port>. A browser shows its 7-day code; the desktop app
 * (a stand-in bridge here; the shell's own checks are desktop unit tests)
 * keeps it silently. After the "rename" the code signs the device in on the
 * new address; whoever kept nothing gets the owner's 24-hour code.
 */
import path from 'node:path'
import { E2E_DIR, freshServer, INVITE_CODE } from '../lib/server'
import { localhost, loopback, meStatus, signInOn, storage } from '../lib/address'
import { apiJoin, expect, expectConnected, newContext, test, type ContextOptions } from '../lib/trio'
import { settingsTab } from '../lib/v7phone'

const OUT = path.join(E2E_DIR, 'screenshots')
const PHONE: ContextOptions = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
const DESKTOP: ContextOptions = { viewport: { width: 1440, height: 900 } }

test.beforeEach(async () => {
  await freshServer({ TRIO_NEXT_URL: localhost(), TRIO_TEST_HTTP_PUBLIC_URL: '1' })
})

test('a browser keeps its 7-day code and uses it after the rename', async ({ browser }) => {
  const ayse = await apiJoin('Ayşe')
  const context = await newContext(browser, PHONE)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const page = await signInOn(context, loopback(), ayse, { 'trio.lastName': 'Ayşe' })
  const band = page.getByTestId('address-next')
  await expect(band).toContainText('yakında değişecek')
  await page.getByTestId('address-next-show').tap()
  const code = ((await page.getByTestId('address-next-code-value').textContent()) ?? '').replace('-', '')
  expect(code).toMatch(/^[A-Z0-9]{10}$/)
  await page.screenshot({ path: path.join(OUT, 'v11-address-next-390.png'), animations: 'disabled' })

  // "Renamed": the next address opens with the kept link.
  const after = await context.newPage()
  await after.goto(`${localhost()}/#tasi=${code}`)
  await expect(after.getByTestId('move-arrival-who')).toContainText('Ayşe')
  await after.getByTestId('move-arrival-go').tap()
  await expectConnected(after)
  expect(await storage(after, 'trio.lastName')).toBe('Ayşe')
  await expect.poll(() => meStatus(localhost(), ayse.token)).toBe(401)
  await context.close()
})

test('the desktop app keeps the code itself (stand-in shell)', async ({ browser }) => {
  const mehmet = await apiJoin('Mehmet')
  const context = await newContext(browser, DESKTOP)
  await context.addInitScript(() => {
    const stored: unknown[] = []
    ;(window as unknown as { __stored: unknown[] }).__stored = stored
    ;(window as unknown as { trioDesktop: unknown }).trioDesktop = {
      isDesktop: true,
      setPttKey: () => undefined,
      onPtt: () => () => undefined,
      storeNextMove: async (request: unknown) => {
        stored.push(request)
        return { ok: true }
      },
    }
  })
  const page = await signInOn(context, loopback(), mehmet)
  await expect(page.getByTestId('address-next-shell')).toContainText('kendisi geçer')
  const stored = (await page.evaluate(() => (window as unknown as { __stored: { origin: string; code: string }[] }).__stored))[0]
  expect(stored.origin).toBe(localhost())
  await page.screenshot({ path: path.join(OUT, 'v11-address-next-desktop-1440.png'), animations: 'disabled' })
  // What the shell does after the rename: open <next>/#tasi=<code> (desktop/src/main/serverMove.ts).
  const after = await context.newPage()
  await after.goto(`${localhost()}/#tasi=${stored.code}`)
  await after.getByTestId('move-arrival-go').click()
  await expectConnected(after)
  await context.close()
})

test('the owner gets in with the recovery code and hands out codes for everybody', async ({ browser }) => {
  await freshServer({ TRIO_NEXT_URL: localhost(), TRIO_TEST_HTTP_PUBLIC_URL: '1', TRIO_RECOVERY_CODE: 'kurtarma-kodu-2026-uzun-rastgele' })
  await apiJoin('Ayşe') // the owner (the lowest id)
  await apiJoin('Mehmet')
  await apiJoin('Zeynep')
  // On the new address with nothing stored: "Zaten hesabım var" takes the recovery code.
  const owner = await newContext(browser, DESKTOP)
  const page = await owner.newPage()
  await page.goto(`${localhost()}/`)
  await page.getByTestId('join-mode-link').click()
  await page.getByTestId('join-link-code').fill('KURTARMA-KODU-2026-UZUN-RASTGELE')
  await expect(page.getByTestId('join-link-code')).toHaveAttribute('data-kind', 'recovery')
  await page.getByTestId('join-submit').click()
  await expectConnected(page)
  await expect(page.getByTestId('recovery-band')).toContainText('TRIO_RECOVERY_CODE')

  await page.getByTestId('btn-settings').click()
  await settingsTab(page, 'yonetim')
  const card = page.getByTestId('owner-address')
  await expect(card.getByTestId('owner-address-checklist')).toBeVisible()
  await card.getByTestId('owner-bulk-make').click()
  await page.getByTestId('ops-confirm-code').fill(INVITE_CODE)
  await page.getByTestId('ops-confirm-submit').click()
  const rows = card.getByTestId('owner-bulk-row')
  await expect(rows).toHaveCount(2)
  await card.getByTestId('owner-bulk-list').scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(OUT, 'v11-address-bulk-1440.png'), animations: 'disabled' })
  const line = (await rows.nth(0).textContent()) ?? ''
  expect(line).toContain('Mehmet')
  const code = (await rows.nth(0).locator('code').textContent()) ?? ''
  const zeynepCode = ((await rows.nth(1).locator('code').textContent()) ?? '').replace('-', '')

  // Mehmet, on his phone with nothing stored, opens his link.
  const phone = await newContext(browser, PHONE)
  const mpage = await phone.newPage()
  await mpage.goto(`${localhost()}/#cihaz=${code.replace('-', '')}`)
  await mpage.getByTestId('join-submit').tap()
  await expectConnected(mpage)
  await expect(mpage.locator('.user-panel-name')).toContainText('Mehmet')
  await expect(mpage.getByTestId('recovery-band')).toHaveCount(0)

  // Cancel the rest: Zeynep's code no longer works.
  await card.getByTestId('owner-bulk-cancel').click()
  await expect(card.getByTestId('owner-bulk-cancel')).toHaveCount(0)
  const refused = await fetch(`${localhost()}/api/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ link_code: zeynepCode }),
  })
  expect(refused.status).toBe(403)
  await owner.close()
  await phone.close()
})
