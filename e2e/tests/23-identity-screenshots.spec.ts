/**
 * Release screenshots for CONTRACT-V4 C (deviceScaleFactor 2): three people
 * with pictures in a conversation and a voice room, and Ayarlar › Hesap with
 * the picture, the rename and the cropper. Each also asserts what it shows.
 */
import path from 'node:path'
import type { Page } from '@playwright/test'
import { apiAvatar, avatarsOf, drawPicture, expectDecoded, openSettings } from '../lib/identity'
import { E2E_DIR, freshServer } from '../lib/server'
import { expect, expectConnected, joinVoice, sendThroughUi, test, threePeople } from '../lib/trio'

const OUT = path.join(E2E_DIR, 'screenshots')
const DESKTOP = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 }

test.beforeEach(async () => {
  await freshServer()
})

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(OUT, name), animations: 'disabled', caret: 'hide' })
}

/** Three distinct pictures, in the palette's tones. */
const LOOKS = [
  { background: '#ee997f', disc: '#f2f1ed', band: '#5e3d37' },
  { background: '#3e6e85', disc: '#85d9c5', band: '#111318' },
  { background: '#86652f', disc: '#ddb174', band: '#2b303a' },
]

test('screenshot 13: a conversation and a voice room with three avatars', async ({ browser, trio }) => {
  test.setTimeout(150_000)
  const people = await threePeople(browser, trio, DESKTOP)
  const [ayse, mehmet, zeynep] = people
  for (const [index, person] of people.entries()) {
    const buffer = await drawPicture(person.page, { width: 256, height: 256, ...LOOKS[index] })
    await apiAvatar(person.token, { name: 'avatar.png', mimeType: 'image/png', buffer })
  }
  await sendThroughUi(ayse, 'Fotoğrafları yükledik, artık herkes yüzüyle görünüyor 🙂')
  await sendThroughUi(mehmet, 'Benimki biraz mavi oldu ama olsun')
  await sendThroughUi(zeynep, 'Akşam 9’da sesli kanalda mıyız?')
  await sendThroughUi(ayse, 'Evet, ben şimdiden girdim')
  for (const person of people) await joinVoice(person)

  const page = ayse.page
  await expect(page.locator('[data-testid^="voice-user-"]')).toHaveCount(3)
  for (const person of people) {
    const where = avatarsOf(page, person.user.id)
    await expectDecoded(where.member.locator('img'))
    await expectDecoded(where.voice.locator('img'))
    for (const message of await where.messages.all()) await expectDecoded(message.locator('img'))
  }
  await expect(page.locator('[data-testid^="voice-user-"][data-speaking="true"]').first()).toBeVisible({ timeout: 15_000 })
  await shot(page, '13-avatars.png')
})

test('screenshot 14: Ayarlar › Hesap with a picture and the rename, and the cropper', async ({ browser, trio }) => {
  const [ayse] = await threePeople(browser, trio, DESKTOP)
  await apiAvatar(ayse.token, {
    name: 'avatar.png',
    mimeType: 'image/png',
    buffer: await drawPicture(ayse.page, { width: 256, height: 256, ...LOOKS[0] }),
  })
  await ayse.page.reload()
  await expectConnected(ayse.page)
  await openSettings(ayse)
  const account = ayse.page.getByTestId('settings-account')
  await account.evaluate((element) => element.scrollIntoView({ block: 'start' }))
  await expectDecoded(ayse.page.getByTestId('avatar').locator('.avatar-img'))
  await expect(ayse.page.getByTestId('rename-input')).toHaveValue('Ayşe')
  await shot(ayse.page, '14-profile-settings.png')

  const photo = await drawPicture(ayse.page, { width: 1400, height: 1000, background: '#69b9aa', disc: '#ee997f', band: '#232730' })
  await ayse.page.getByTestId('avatar-input').setInputFiles({ name: 'tatil.png', mimeType: 'image/png', buffer: photo })
  await expect(ayse.page.getByTestId('cropper')).toBeVisible()
  await ayse.page.getByTestId('cropper-zoom').fill('1.4')
  await expect(ayse.page.getByTestId('cropper-canvas')).toHaveAttribute('data-zoom', '1.400')
  await shot(ayse.page, '14b-avatar-cropper.png')
})
