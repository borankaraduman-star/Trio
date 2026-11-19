/**
 * CONTRACT-V7-READING §6: a channel row's menu renames (anybody) and deletes
 * (the owner, the name typed for a text channel); the others see it live. A
 * voice room somebody is in, and the last text channel, cannot be deleted.
 */
import path from 'node:path'
import { E2E_DIR, freshServer } from '../lib/server'
import { api, expect, GENEL, joinVoice, personViaApi, SOHBET, test, threePeople, type ContextOptions } from '../lib/trio'
import { longPress, rest, row, send } from '../lib/messages'

const OUT = path.join(E2E_DIR, 'screenshots')
const PHONE: ContextOptions = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }

test.beforeEach(async () => {
  await freshServer()
})

test('rename and delete a channel, seen live by the others', async ({ browser, trio }) => {
  // Ayşe joined first: the owner (CONTRACT-V6-OPS §1).
  const [ayse, mehmet, zeynep] = await threePeople(browser, trio)
  const { channel } = await api<{ channel: { id: number } }>(ayse.token, '/api/channels', {
    method: 'POST',
    body: { name: 'oyun', kind: 'text' },
  })
  const id = channel.id
  for (const person of [ayse, mehmet, zeynep]) await expect(person.page.getByTestId(`channel-${id}`)).toHaveText(/oyun/)
  await mehmet.page.getByTestId(`channel-${id}`).click()
  await send(mehmet.page, 'akşam kim var')

  // Mehmet renames it (anybody may), and has no "Kanalı sil".
  await mehmet.page.getByTestId(`channel-${id}`).click({ button: 'right' })
  const menu = mehmet.page.getByTestId('channel-notify-menu')
  await expect(menu.getByTestId('channel-rename')).toBeVisible()
  await expect(menu.getByTestId('channel-delete')).toHaveCount(0)
  await menu.getByTestId('channel-rename').click()
  const rename = mehmet.page.getByTestId('channel-rename-dialog')
  await rename.getByTestId('channel-rename-input').fill('oyun-gecesi')
  await rename.getByTestId('channel-rename-save').click()
  await expect(rename).toHaveCount(0)
  for (const person of [ayse, mehmet, zeynep]) {
    await expect(person.page.getByTestId(`channel-${id}`)).toHaveText(/oyun-gecesi/)
  }
  await expect(mehmet.page.locator('.main-header h1')).toHaveText('oyun-gecesi')

  // Ayşe, the owner, deletes it: the name must be typed.
  await ayse.page.getByTestId(`channel-${id}`).click({ button: 'right' })
  await ayse.page.getByTestId('channel-notify-menu').getByTestId('channel-delete').click()
  const dialog = ayse.page.getByTestId('channel-delete-dialog')
  const confirm = dialog.getByTestId('channel-delete-confirm')
  await expect(confirm).toBeDisabled()
  await dialog.getByTestId('channel-delete-input').fill('oyun')
  await expect(confirm).toBeDisabled()
  await dialog.getByTestId('channel-delete-input').fill('oyun-gecesi')
  await ayse.page.screenshot({ path: path.join(OUT, 'v7-reading-delete-dialog.png') })
  await confirm.click()
  await expect(dialog).toHaveCount(0)

  for (const person of [ayse, mehmet, zeynep]) await expect(person.page.getByTestId(`channel-${id}`)).toHaveCount(0)
  // Mehmet was in it: he is moved to #genel.
  await expect(mehmet.page.locator('.main-header h1')).toHaveText('genel')
  expect((await rest(ayse.token, `/api/channels/${id}/messages`, 'GET')).status).toBe(404)

  // The last text channel and a voice room in use: the menu says why not.
  await ayse.page.getByTestId(`channel-${GENEL}`).click({ button: 'right' })
  await expect(ayse.page.getByTestId('channel-delete')).toBeDisabled()
  await expect(ayse.page.getByTestId('channel-delete')).toHaveText('Son metin kanalı silinemez')
  await ayse.page.keyboard.press('Escape')
  await joinVoice(zeynep, SOHBET)
  await expect(ayse.page.getByTestId(`voice-user-${zeynep.user.id}`)).toBeVisible()
  await ayse.page.getByTestId(`channel-${SOHBET}`).click({ button: 'right' })
  await expect(ayse.page.getByTestId('channel-delete')).toBeDisabled()
  await expect(ayse.page.getByTestId('channel-delete')).toHaveText('Ses kanalında biri varken silinemez')
  await ayse.page.screenshot({ path: path.join(OUT, 'v7-reading-channel-menu.png') })
  await ayse.page.keyboard.press('Escape')
  // The server says the same to a direct request.
  const busy = await rest(ayse.token, `/api/channels/${SOHBET}`, 'DELETE', { confirm_name: 'Sohbet' })
  expect(busy.status).toBe(409)
})

test('a long press on a channel row opens its menu on a phone', async ({ browser, trio }) => {
  const ayse = trio.add(await personViaApi(browser, 'Ayşe', PHONE))
  const page = ayse.page
  await send(page, 'merhaba')
  await page.getByTestId('btn-drawer').tap()
  await expect(page.locator('nav.sidebar')).toBeInViewport({ ratio: 0.99 })
  const menu = page.getByTestId('channel-notify-menu')
  await longPress(page, page.getByTestId(`channel-${GENEL}`), menu)
  // The lifted finger's click did not land on a menu item.
  await expect(menu).toBeVisible()
  await expect(page.getByTestId('channel-rename-dialog')).toHaveCount(0)
  await menu.getByTestId('channel-rename').tap()
  const rename = page.getByTestId('channel-rename-dialog')
  await rename.getByTestId('channel-rename-input').fill('ev')
  await rename.getByTestId('channel-rename-save').tap()
  await expect(page.getByTestId(`channel-${GENEL}`)).toHaveText(/ev/)
  await expect(row(page, 'merhaba')).toBeVisible()
})
