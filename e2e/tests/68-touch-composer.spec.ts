/**
 * CONTRACT-V7-READING §4–5: on a touch-first device Enter is the newline key
 * and "Gönder" sends; a desktop keeps Enter = send. A channel switch focuses
 * the composer on a desktop and never on a phone (it would raise the keyboard).
 */
import path from 'node:path'
import { E2E_DIR, freshServer } from '../lib/server'
import { api, expect, GENEL, personViaApi, test, type ContextOptions } from '../lib/trio'
import { rows } from '../lib/messages'

const OUT = path.join(E2E_DIR, 'screenshots')
const PHONE: ContextOptions = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }

test.beforeEach(async () => {
  await freshServer()
})

test('touch: Enter is a newline, Gönder sends; no focus on a channel switch', async ({ browser, trio }) => {
  const ayse = trio.add(await personViaApi(browser, 'Ayşe', PHONE))
  const { channel } = await api<{ channel: { id: number } }>(ayse.token, '/api/channels', {
    method: 'POST',
    body: { name: 'liste', kind: 'text' },
  })
  const page = ayse.page
  const composer = page.getByTestId('composer')
  await expect(composer).toHaveAttribute('data-enter', 'newline')
  await expect(composer).toHaveAttribute('enterkeyhint', 'enter')

  await composer.tap()
  await page.keyboard.type('ekmek')
  await page.keyboard.press('Enter')
  await page.keyboard.type('peynir')
  await expect(composer).toHaveValue('ekmek\npeynir')
  await expect(rows(page)).toHaveCount(0)
  await page.screenshot({ path: path.join(OUT, 'v7-reading-composer-390.png') })
  await page.getByTestId('composer-send').tap()
  await expect(rows(page)).toHaveCount(1)
  await expect(rows(page).first()).toHaveAttribute('data-status', 'sent')
  await expect(rows(page).first()).toContainText('ekmek')
  await expect(rows(page).first()).toContainText('peynir')
  await expect(composer).toHaveValue('')

  // Switching channels does not put the focus (and the keyboard) on the box.
  await page.getByTestId('btn-drawer').tap()
  await page.getByTestId(`channel-${channel.id}`).tap()
  await expect(page.locator('.main-header h1')).toHaveText('liste')
  await expect(composer).not.toBeFocused()
})

test('desktop: Enter sends, Shift+Enter is a newline; a switch focuses the composer', async ({ browser, trio }) => {
  const ayse = trio.add(await personViaApi(browser, 'Ayşe'))
  const { channel } = await api<{ channel: { id: number } }>(ayse.token, '/api/channels', {
    method: 'POST',
    body: { name: 'liste', kind: 'text' },
  })
  const page = ayse.page
  const composer = page.getByTestId('composer')
  await expect(composer).toHaveAttribute('data-enter', 'send')
  await expect(composer).toHaveAttribute('enterkeyhint', 'send')

  await page.getByTestId(`channel-${channel.id}`).click()
  await expect(page.locator('.main-header h1')).toHaveText('liste')
  await expect(composer).toBeFocused()
  await page.keyboard.type('bir')
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.type('iki')
  await expect(composer).toHaveValue('bir\niki')
  await page.keyboard.press('Enter')
  await expect(rows(page)).toHaveCount(1)
  await expect(rows(page).first()).toHaveAttribute('data-status', 'sent')

  // Back to #genel: focused again; with the channel menu open it is not taken.
  await page.getByTestId(`channel-${GENEL}`).click()
  await expect(composer).toBeFocused()
  await page.getByTestId(`channel-${channel.id}`).click({ button: 'right' })
  await expect(page.getByTestId('channel-notify-menu')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('channel-notify-menu')).toHaveCount(0)
})
