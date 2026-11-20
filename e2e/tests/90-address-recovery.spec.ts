/**
 * CONTRACT-V11-ADDRESS §5–§6: the owner's recovery code on a phone with
 * nothing stored (wrong code, off by default, the band until the variable is
 * gone), an older desktop app without `moveServer` (the code by hand), and
 * Yönetim › Adres while both addresses are alive.
 */
import path from 'node:path'
import { E2E_DIR, freshServer } from '../lib/server'
import { localhost, loopback, meStatus, signInOn, storage } from '../lib/address'
import { apiJoin, expect, expectConnected, newContext, test, type ContextOptions } from '../lib/trio'
import { settingsTab } from '../lib/v7phone'

const OUT = path.join(E2E_DIR, 'screenshots')
const PHONE: ContextOptions = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
const DESKTOP: ContextOptions = { viewport: { width: 1440, height: 900 } }
const RECOVERY = 'k7m2-q9x4-p8w3-r6t5-h2j9-n4v7'

async function typeRecovery(page: import('@playwright/test').Page, value: string) {
  await page.goto('/')
  await page.getByTestId('join-mode-link').tap()
  await page.getByTestId('join-link-code').fill(value)
  await page.getByTestId('join-submit').tap()
}

test('the recovery code signs the owner in on a fresh phone', async ({ browser }) => {
  await freshServer({ TRIO_RECOVERY_CODE: RECOVERY })
  await apiJoin('Ayşe')
  await apiJoin('Mehmet')
  const context = await newContext(browser, PHONE)
  const page = await context.newPage()
  await typeRecovery(page, 'k7m2-q9x4-p8w3-r6t5-h2j9-n4v0')
  await expect(page.getByTestId('join-error')).toContainText('Kurtarma kodu yanlış')
  await expect(page.getByTestId('join-recovery-hint')).toBeVisible()
  await page.screenshot({ path: path.join(OUT, 'v11-address-recovery-join-390.png'), animations: 'disabled' })
  // The phone keyboard's capitals do not matter.
  await page.getByTestId('join-link-code').fill(RECOVERY.toUpperCase())
  await page.getByTestId('join-submit').tap()
  await expectConnected(page)
  await expect(page.locator('.user-panel-name')).toContainText('Ayşe')
  await expect(page.getByTestId('recovery-band')).toBeVisible()
  await page.screenshot({ path: path.join(OUT, 'v11-address-recovery-band-390.png'), animations: 'disabled' })
  await context.close()

  // The variable removed (a restart without it): no band, and the code is just wrong.
  await freshServer()
  const owner = await apiJoin('Ayşe')
  const later = await newContext(browser, PHONE)
  const again = await later.newPage()
  await typeRecovery(again, RECOVERY)
  await expect(again.getByTestId('join-error')).toContainText('Kurtarma kodu yanlış')
  expect(await meStatus(loopback(), owner.token)).toBe(200)
  await later.close()
})

test('an older desktop app shows the code to type by hand', async ({ browser }) => {
  await freshServer({ TRIO_PUBLIC_URL: loopback(), TRIO_TEST_HTTP_PUBLIC_URL: '1' })
  const ayse = await apiJoin('Ayşe')
  const zeynep = await apiJoin('Zeynep')
  const context = await newContext(browser, DESKTOP)
  // A shell from before V11: a bridge with no moveServer.
  await context.addInitScript(() => {
    ;(window as unknown as { trioDesktop: unknown }).trioDesktop = {
      isDesktop: true,
      setPttKey: () => undefined,
      onPtt: () => () => undefined,
    }
  })
  const old = await signInOn(context, localhost(), zeynep, { 'trio.v10.membersHidden': '1' })
  await expect(old.getByTestId('address-old-shell')).toContainText('Sunucuyu değiştir')
  await old.getByTestId('address-move').click()
  const code = ((await old.getByTestId('address-manual-code').textContent()) ?? '').trim()
  expect(code).toMatch(/^[A-Z0-9]{5}-[A-Z0-9]{5}$/)
  await old.screenshot({ path: path.join(OUT, 'v11-address-old-shell-1440.png'), animations: 'disabled' })
  // The person switches the app to the new address and types the code.
  const fresh = await context.newPage()
  await fresh.goto(`${loopback()}/`)
  await fresh.getByTestId('join-mode-link').click()
  await fresh.getByTestId('join-link-code').fill(code)
  await fresh.getByTestId('join-submit').click()
  await expectConnected(fresh)
  await expect(fresh.locator('.user-panel-name')).toContainText('Zeynep')
  expect(await storage(fresh, 'trio.v10.membersHidden')).toBe('1')
  await expect.poll(() => meStatus(loopback(), zeynep.token)).toBe(401)

  // Yönetim › Adres (the owner, already on the new address).
  const owner = await signInOn(await newContext(browser, DESKTOP), loopback(), ayse)
  await owner.getByTestId('btn-settings').click()
  await settingsTab(owner, 'yonetim')
  const card = owner.getByTestId('owner-address')
  await expect(card.getByTestId('owner-address-state')).toContainText('ulaşılıyor, bu sunucu')
  await expect(card.getByTestId('owner-address-sessions')).toContainText('1 cihaz taşındı')
  await card.scrollIntoViewIfNeeded()
  await owner.screenshot({ path: path.join(OUT, 'v11-address-owner-1440.png'), animations: 'disabled' })
  await owner.context().close()
  await context.close()
})
