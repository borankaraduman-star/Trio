/**
 * CONTRACT-V8-MUSIC with CONTRACT-V4 A and V7-PHONE: a signalling drop and
 * resume KEEPS the music share (the call is kept, so is its music sender; the
 * resume announces it again), the listener's output device applies to music,
 * hanging up stops it, and on a phone the call bar carries the music button —
 * which no surface offers where getDisplayMedia does not exist.
 */
import path from 'node:path'
import { freshServer } from '../lib/server'
import { expect, joinVoice, personViaApi, SOHBET, test } from '../lib/trio'
import { socketSwitch } from '../lib/voiceProbe'
import { DESKTOP, joinVoiceOnPhone, NO_SCREEN_SHARE, openDrawer, PHONE, SCREENSHOTS } from '../lib/v7phone'
import { expectMusicFlowing, expectStereoMusic, FAKE_MUSIC_CAPTURE, musicIn } from '../lib/v8music'

test.beforeEach(async () => {
  await freshServer()
})

test('a signalling drop keeps the music; the output device applies to it; hanging up stops it', async ({ browser, trio }) => {
  test.setTimeout(180_000)
  const sw = socketSwitch()
  const ayse = trio.add(
    await personViaApi(browser, 'Ayşe', {
      prepare: async (context) => {
        await context.addInitScript(FAKE_MUSIC_CAPTURE)
        await sw.prepare(context)
      },
    }),
  )
  const mehmet = trio.add(await personViaApi(browser, 'Mehmet'))
  await joinVoice(ayse)
  await joinVoice(mehmet)
  await ayse.page.getByTestId('btn-music').click()
  await ayse.page.getByTestId('music-title-input').fill('Kalbim')
  await expect(mehmet.page.getByTestId(`music-now-playing-${ayse.user.id}`)).toContainText('Kalbim')
  const before = await expectStereoMusic(mehmet, ayse, 'before the drop')

  // The drop: the call (and its music) goes on without a socket ...
  await sw.cut()
  await expect(ayse.page.getByTestId('connection-banner')).toHaveAttribute('data-voice-kept', 'true')
  const during = await expectMusicFlowing(mehmet, ayse, 'during the drop')
  expect(during.pc).toBe(before.pc)
  // ... and after the resume it is still shared, on the same connection, title included.
  sw.online = true
  await expect(ayse.page.getByTestId('connection-banner')).toHaveCount(0, { timeout: 30_000 })
  await expect(ayse.page.locator('.voice-status strong')).toHaveText('Ses bağlı')
  await expect(ayse.page.getByTestId('btn-music')).toHaveAttribute('aria-pressed', 'true')
  const row = mehmet.page.getByTestId(`voice-user-${ayse.user.id}`)
  await expect(row).toHaveAttribute('data-music', 'true')
  await expect(mehmet.page.getByTestId(`music-now-playing-${ayse.user.id}`)).toContainText('Kalbim')
  const after = await expectStereoMusic(mehmet, ayse, 'after the resume')
  expect(after.pc).toBe(before.pc)

  // Mehmet's output device: the music element plays on it too.
  await mehmet.page.getByTestId('btn-settings').click()
  await mehmet.page.getByTestId('settings-output').selectOption({ label: 'Fake Audio Output 1' })
  const chosen = await mehmet.page.getByTestId('settings-output').inputValue()
  await mehmet.page.getByTestId('settings-close').click()
  await expect
    .poll(() => mehmet.page.getByTestId(`remote-music-${ayse.user.id}`).evaluate((e) => (e as HTMLAudioElement & { sinkId: string }).sinkId))
    .toBe(chosen)

  // Hanging up stops the share; joining again starts without one.
  await ayse.page.getByTestId('btn-hangup').click()
  await expect(row).toHaveCount(0)
  await expect(mehmet.page.getByTestId(`remote-music-${ayse.user.id}`)).toHaveCount(0)
  await joinVoice(ayse)
  await expect(row).toHaveAttribute('data-music', 'false')
  await expect(ayse.page.getByTestId('btn-music')).toHaveAttribute('aria-pressed', 'false')
  expect(await musicIn(mehmet, ayse)).toBeNull()
})

test('phone: the call bar has the music button; no music control where getDisplayMedia is missing', async ({ browser, trio }) => {
  test.setTimeout(120_000)
  const ayse = trio.add(await personViaApi(browser, 'Ayşe', DESKTOP))
  const mehmet = trio.add(
    await personViaApi(browser, 'Mehmet', { ...PHONE, prepare: (context) => context.addInitScript(FAKE_MUSIC_CAPTURE) }),
  )
  await joinVoice(ayse)
  await joinVoiceOnPhone(mehmet, SOHBET)
  const button = mehmet.page.getByTestId('call-bar-music')
  await expect(button).toBeInViewport({ ratio: 1 })
  const box = (await button.boundingBox())!
  expect(box.width).toBeGreaterThanOrEqual(44)
  expect(box.height).toBeGreaterThanOrEqual(44)
  expect(await mehmet.page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await button.tap()
  await expect(button).toHaveAttribute('aria-pressed', 'true')
  await expectMusicFlowing(ayse, mehmet, 'Ayşe hears the music shared from the phone bar')
  await mehmet.page.screenshot({ path: path.join(SCREENSHOTS, 'v8-music-phone.png') })
  // The drawer's panel shows the same share.
  await openDrawer(mehmet.page)
  await expect(mehmet.page.getByTestId('btn-music')).toHaveAttribute('aria-pressed', 'true')
  await expect(mehmet.page.getByTestId('music-panel')).toBeVisible()

  // A phone browser without getDisplayMedia: no music control anywhere.
  const zeynep = trio.add(
    await personViaApi(browser, 'Zeynep', { ...PHONE, prepare: (context) => context.addInitScript(NO_SCREEN_SHARE) }),
  )
  await joinVoiceOnPhone(zeynep, SOHBET)
  await expect(zeynep.page.getByTestId('call-bar')).toBeVisible()
  await expect(zeynep.page.getByTestId('call-bar-music')).toHaveCount(0)
  await expect(zeynep.page.getByTestId('btn-music')).toHaveCount(0)
})
