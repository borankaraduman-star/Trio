/**
 * CONTRACT-V7-PHONE §1: on a phone, in a call, a bar above the composer
 * carries mute, deafen, camera, (screen share where the browser has it) and
 * leave, with the room's name and who is talking. It acts on the call itself:
 * muting from it silences what the others receive. Where `getDisplayMedia`
 * does not exist, no share control is offered anywhere.
 */
import path from 'node:path'
import { freshServer } from '../lib/server'
import { expectTileDecoding } from '../lib/media'
import { expect, expectHearing, expectSilence, joinVoice, personViaApi, SOHBET, test } from '../lib/trio'
import { DESKTOP, joinVoiceOnPhone, NO_SCREEN_SHARE, PHONE, SCREENSHOTS, settingsTab } from '../lib/v7phone'

test.beforeEach(async () => {
  await freshServer()
})

test('phone: the call bar mutes, deafens, turns the camera on and leaves, on the real call', async ({ browser, trio }) => {
  test.setTimeout(150_000)
  const ayse = trio.add(await personViaApi(browser, 'Ayşe', DESKTOP))
  const mehmet = trio.add(await personViaApi(browser, 'Mehmet', PHONE))
  const page = mehmet.page

  // Not in a call: no bar.
  await expect(page.getByTestId('composer')).toBeVisible()
  await expect(page.getByTestId('call-bar')).toHaveCount(0)

  await joinVoice(ayse)
  await joinVoiceOnPhone(mehmet, SOHBET)
  const bar = page.getByTestId('call-bar')
  await expect(bar).toBeInViewport({ ratio: 1 })
  await expect(page.getByTestId('call-bar-room')).toContainText('Sohbet')

  // Above the composer, and every button at least 44 × 44 px, reachable with the drawer closed.
  const barBox = (await bar.boundingBox())!
  const composerBox = (await page.getByTestId('composer').boundingBox())!
  expect(barBox.y + barBox.height).toBeLessThanOrEqual(composerBox.y)
  for (const id of ['call-bar-mute', 'call-bar-deafen', 'call-bar-camera', 'call-bar-screen', 'call-bar-hangup']) {
    const box = (await page.getByTestId(id).boundingBox())!
    expect(box.width, id).toBeGreaterThanOrEqual(44)
    expect(box.height, id).toBeGreaterThanOrEqual(44)
    await expect(page.getByTestId(id)).toBeInViewport({ ratio: 1 })
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await expectHearing(ayse, mehmet)

  // Who is talking: Ayşe's (fake) microphone beeps.
  await expect(page.getByTestId('call-bar-talking')).toContainText('Konuşuyor: Ayşe', { timeout: 20_000 })

  // Mute from the bar: the server's voice state and the sent audio both follow.
  const row = ayse.page.getByTestId(`voice-user-${mehmet.user.id}`)
  await page.getByTestId('call-bar-mute').tap()
  await expect(page.getByTestId('call-bar-mute')).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('call-bar-mute')).toHaveAttribute('data-transmitting', 'false')
  await expect(row).toHaveAttribute('data-muted', 'true')
  await expectSilence(ayse, mehmet)
  // The drawer's button tells the same story (one engine).
  await expect(page.getByTestId('btn-mute')).toHaveAttribute('aria-pressed', 'true')
  await page.getByTestId('call-bar-mute').tap()
  await expect(row).toHaveAttribute('data-muted', 'false')
  await expectHearing(ayse, mehmet)

  // Deafen.
  await page.getByTestId('call-bar-deafen').tap()
  await expect(row).toHaveAttribute('data-deafened', 'true')
  await expect(page.getByTestId('call-bar-deafen')).toHaveAttribute('aria-label', 'Kulaklığı aç')
  await page.getByTestId('call-bar-deafen').tap()
  await expect(row).toHaveAttribute('data-deafened', 'false')

  // Camera: Ayşe decodes Mehmet's camera.
  await page.getByTestId('call-bar-camera').tap()
  await expect(page.getByTestId('call-bar-camera')).toHaveAttribute('aria-pressed', 'true')
  await expectTileDecoding(ayse.page, `remote-camera-${mehmet.user.id}`, 'camera', 'Mehmet')
  await page.getByTestId('call-bar-camera').tap()
  await expect(ayse.page.getByTestId(`remote-camera-${mehmet.user.id}`)).toHaveCount(0)

  await page.getByTestId('call-bar-mute').tap()
  await expect(row).toHaveAttribute('data-muted', 'true')
  await page.screenshot({ path: path.join(SCREENSHOTS, 'v7-phone-call-bar.png') })
  await page.getByTestId('call-bar-mute').tap()

  // Leave from the bar.
  await page.getByTestId('call-bar-hangup').tap()
  await expect(page.getByTestId('call-bar')).toHaveCount(0)
  await expect(ayse.page.locator('[data-testid^="voice-user-"]')).toHaveCount(1)

  // A desktop window never shows the bar.
  await expect(ayse.page.getByTestId('call-bar')).toHaveCount(0)
})

test('a browser without getDisplayMedia offers no screen share anywhere', async ({ browser, trio }) => {
  const ayse = trio.add(await personViaApi(browser, 'Ayşe', DESKTOP))
  const phone = trio.add(
    await personViaApi(browser, 'Mehmet', { ...PHONE, prepare: async (context) => void (await context.addInitScript(NO_SCREEN_SHARE)) }),
  )
  const desk = trio.add(
    await personViaApi(browser, 'Zeynep', { ...DESKTOP, prepare: async (context) => void (await context.addInitScript(NO_SCREEN_SHARE)) }),
  )
  expect(await phone.page.evaluate(() => typeof navigator.mediaDevices.getDisplayMedia)).toBe('undefined')

  await joinVoice(ayse)
  await joinVoiceOnPhone(phone, SOHBET)
  await joinVoice(desk)
  await expect(phone.page.getByTestId('call-bar-mute')).toBeVisible()
  await expect(phone.page.getByTestId('call-bar-screen')).toHaveCount(0)
  await expect(phone.page.getByTestId('btn-screen')).toHaveCount(0)
  await expect(phone.page.getByTestId('btn-share-menu')).toHaveCount(0)
  await expect(desk.page.getByTestId('btn-screen')).toHaveCount(0)
  await expect(desk.page.getByTestId('btn-share-menu')).toHaveCount(0)
  // Where it exists, it is still there.
  await expect(ayse.page.getByTestId('btn-screen')).toBeVisible()
  await phone.page.screenshot({ path: path.join(SCREENSHOTS, 'v7-phone-call-bar-no-share.png') })

  // The camera is still offered, and settings say why there is no screen share.
  await expect(phone.page.getByTestId('call-bar-camera')).toBeVisible()
  await desk.page.getByTestId('btn-settings').click()
  await settingsTab(desk.page, 'goruntu')
  await expect(desk.page.getByTestId('settings-screen-unsupported')).toBeVisible()
  await expect(desk.page.getByTestId('settings-screen-audio')).toHaveCount(0)
})
