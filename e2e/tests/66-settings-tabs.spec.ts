/**
 * CONTRACT-V7-PHONE §4–§5: Ayarlar in sections (a list on the left on a wide
 * screen, a list then one section on a phone; Yönetim only for the owner),
 * signing out only from Ayarlar › Hesap, and one "+" that asks which kind of
 * channel to add.
 */
import path from 'node:path'
import { freshServer } from '../lib/server'
import { expect, personViaApi, test } from '../lib/trio'
import { DESKTOP, openDrawer, PHONE, SCREENSHOTS, settingsTab } from '../lib/v7phone'

test.beforeEach(async () => {
  await freshServer()
})

const ALL = ['ses', 'goruntu', 'bildirimler', 'hesap', 'depolama', 'yonetim', 'hakkinda'] as const
/** One control that lives in each section. */
const IN_SECTION: Record<(typeof ALL)[number], string> = {
  ses: 'settings-mic',
  goruntu: 'settings-camera',
  bildirimler: 'settings-notify',
  hesap: 'settings-account',
  depolama: 'storage-section',
  yonetim: 'owner-section',
  hakkinda: 'settings-versions',
}

test('desktop: a list on the left, one section at a time, Yönetim only for the owner, keyboard too', async ({ browser, trio }) => {
  const ayse = trio.add(await personViaApi(browser, 'Ayşe', DESKTOP))
  const mehmet = trio.add(await personViaApi(browser, 'Mehmet', DESKTOP))
  const page = ayse.page

  await page.getByTestId('btn-settings').click()
  await expect(page.getByTestId('settings-panel-ses')).toBeVisible()
  await expect(page.getByTestId('settings-tab-ses')).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByTestId('settings-tab-yonetim')).toBeVisible()
  for (const tab of ALL) {
    await page.getByTestId(`settings-tab-${tab}`).click()
    await expect(page.getByTestId(`settings-panel-${tab}`)).toBeVisible()
    await expect(page.getByTestId(IN_SECTION[tab])).toBeVisible()
    // Only that section is there.
    for (const other of ALL) if (other !== tab) await expect(page.getByTestId(IN_SECTION[other])).toHaveCount(0)
  }
  // Hakkında: the versions and the download link.
  await expect(page.getByTestId('download-link')).toBeVisible()

  // Arrow keys move along the list.
  await page.getByTestId('settings-tab-ses').click()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByTestId('settings-panel-goruntu')).toBeVisible()
  await expect(page.getByTestId('settings-tab-goruntu')).toBeFocused()
  await page.getByTestId('settings-tab-ses').click()
  await page.screenshot({ path: path.join(SCREENSHOTS, 'v7-phone-settings-desktop.png') })
  await page.getByTestId('settings-close').click()
  await expect(page.getByTestId('settings-dialog')).toHaveCount(0)

  // Not the owner: no Yönetim.
  await mehmet.page.getByTestId('btn-settings').click()
  await expect(mehmet.page.getByTestId('settings-tab-depolama')).toBeVisible()
  await expect(mehmet.page.getByTestId('settings-tab-yonetim')).toHaveCount(0)
})

test('phone: the list first, then one section with a way back; every row a big target', async ({ browser, trio }) => {
  const ayse = trio.add(await personViaApi(browser, 'Ayşe', PHONE))
  const page = ayse.page
  await openDrawer(page)
  await page.getByTestId('btn-settings').tap()
  const dialog = page.getByTestId('settings-dialog')
  await expect(dialog).toBeVisible()
  const frame = (await dialog.boundingBox())!
  expect(frame.width).toBeLessThanOrEqual(390)
  // The list, no section yet.
  for (const tab of ALL) {
    const row = page.getByTestId(`settings-tab-${tab}`)
    await row.scrollIntoViewIfNeeded()
    await expect(row).toBeInViewport({ ratio: 1 })
    expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  }
  await expect(page.locator('[data-testid^="settings-panel-"]')).toHaveCount(0)
  await page.screenshot({ path: path.join(SCREENSHOTS, 'v7-phone-settings-390.png') })

  await page.getByTestId('settings-tab-ses').tap()
  await expect(page.getByTestId('settings-panel-ses')).toBeVisible()
  await expect(page.locator('#settings-title')).toHaveText('Ses')
  await expect(page.getByTestId('settings-tab-ses')).toHaveCount(0)
  await expect(page.getByTestId('settings-back')).toBeInViewport({ ratio: 1 })
  await page.screenshot({ path: path.join(SCREENSHOTS, 'v7-phone-settings-ses-390.png') })
  await page.getByTestId('settings-back').tap()
  await expect(page.getByTestId('settings-tab-hesap')).toBeVisible()
  await expect(page.locator('#settings-title')).toHaveText('Ayarlar')

  for (const tab of ALL) {
    await settingsTab(page, tab)
    await expect(page.getByTestId(IN_SECTION[tab])).toBeAttached()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  }
})

test('signing out is in Ayarlar › Hesap (not the bottom bar); one "+" asks which kind of channel', async ({ browser, trio }) => {
  const ayse = trio.add(await personViaApi(browser, 'Ayşe', PHONE))
  const mehmet = trio.add(await personViaApi(browser, 'Mehmet', DESKTOP))
  const page = ayse.page

  await openDrawer(page)
  await expect(page.getByTestId('btn-logout')).toHaveCount(0)
  await expect(mehmet.page.getByTestId('btn-logout')).toHaveCount(0)

  // One "+": the kinds only after it is opened.
  await expect(page.getByTestId('add-channel-text')).toHaveCount(0)
  const plus = page.getByTestId('add-channel')
  expect((await plus.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  await plus.tap()
  await expect(page.getByTestId('add-channel-text')).toBeVisible()
  await expect(page.getByTestId('add-channel-voice')).toBeVisible()
  await page.screenshot({ path: path.join(SCREENSHOTS, 'v7-phone-add-channel.png') })
  await page.getByTestId('add-channel-voice').tap()
  await expect(page.getByTestId('add-channel-voice')).toHaveCount(0)
  await expect(page.getByTestId('add-channel-name')).toHaveAttribute('placeholder', 'yeni ses kanalı')
  await page.getByTestId('add-channel-name').fill('Oyun gecesi')
  await page.getByTestId('add-channel-submit').tap()
  // A voice channel, for everybody (joining it shows it is one).
  const created = mehmet.page.locator('nav.sidebar button.channel', { hasText: 'Oyun gecesi' })
  await expect(created).toBeVisible()
  await created.click()
  await expect(mehmet.page.locator('.voice-status')).toContainText('Oyun gecesi')

  // Escape closes the menu without choosing.
  await mehmet.page.getByTestId('add-channel').click()
  await expect(mehmet.page.getByTestId('add-channel-text')).toBeVisible()
  await mehmet.page.keyboard.press('Escape')
  await expect(mehmet.page.getByTestId('add-channel-text')).toHaveCount(0)
  await expect(mehmet.page.getByTestId('add-channel-name')).toHaveCount(0)

  // Sign out from Ayarlar › Hesap: the safe-logout dialog, as before.
  await page.getByTestId('btn-settings').tap()
  await settingsTab(page, 'hesap')
  await page.getByTestId('settings-sign-out').tap()
  const logout = page.getByTestId('logout-dialog')
  await expect(logout).toContainText('Bu cihazdan çıkış yapılsın mı?')
  await logout.getByTestId('logout-confirm').tap()
  await expect(page.getByTestId('join-form')).toBeVisible()
})
