/** Helpers of the V7 phone specs (63–66, CONTRACT-V7-PHONE) and the settings tabs every spec uses. */
import path from 'node:path'
import type { Page } from '@playwright/test'
import { expect, type ContextOptions, type Person } from './trio'

export const PHONE: ContextOptions = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
export const DESKTOP: ContextOptions = { viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 }
export const SCREENSHOTS = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'screenshots')

/** Most phones: a browser with no `getDisplayMedia` at all (installed before the page loads). */
export const NO_SCREEN_SHARE = `
  if (navigator.mediaDevices) {
    delete MediaDevices.prototype.getDisplayMedia
    try { delete navigator.mediaDevices.getDisplayMedia } catch {}
  }
`

export type SettingsTab = 'ses' | 'goruntu' | 'bildirimler' | 'hesap' | 'depolama' | 'yonetim' | 'hakkinda'

/**
 * With the settings open, show one section (CONTRACT-V7-PHONE §5): click its
 * tab in the list on the left, or on a phone go back to the list first.
 */
export async function settingsTab(page: Page, tab: SettingsTab): Promise<void> {
  if (await page.getByTestId(`settings-panel-${tab}`).isVisible()) return
  const button = page.getByTestId(`settings-tab-${tab}`)
  if (!(await button.isVisible())) {
    const back = page.getByTestId('settings-back')
    if (await back.isVisible()) await back.click()
  }
  await button.click()
  await expect(page.getByTestId(`settings-panel-${tab}`)).toBeVisible()
}

/** Open the drawer (a phone only) and wait until it is on screen. */
export async function openDrawer(page: Page): Promise<void> {
  await page.getByTestId('btn-drawer').tap()
  await expect(page.locator('nav.sidebar')).toBeInViewport({ ratio: 0.99 })
}

/** Join a voice room from a phone: through the drawer, which then closes on the backdrop. */
export async function joinVoiceOnPhone(person: Person, channelId: number): Promise<void> {
  await openDrawer(person.page)
  await person.page.getByTestId(`channel-${channelId}`).tap()
  await expect(person.page.locator('.voice-status strong')).toHaveText('Ses bağlı')
  await person.page.locator('.backdrop').tap({ position: { x: 370, y: 400 } })
  await expect(person.page.locator('nav.sidebar')).not.toBeInViewport()
}

/** Sign out the way V7 offers it: Ayarlar › Hesap › Çıkış yap (the safe-logout dialog follows). */
export async function startSignOut(page: Page): Promise<void> {
  const phone = (page.viewportSize()?.width ?? 1280) <= 680
  if (phone && !(await page.getByTestId('btn-settings').isVisible())) await page.getByTestId('btn-drawer').click()
  await page.getByTestId('btn-settings').click()
  await settingsTab(page, 'hesap')
  await page.getByTestId('settings-sign-out').click()
}
