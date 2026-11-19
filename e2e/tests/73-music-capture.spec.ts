/**
 * CONTRACT-V8-MUSIC §3, the capture itself.
 *
 * The first test uses NO fake at the getDisplayMedia boundary: Ayşe's browser
 * is a headed Chromium (on an Xvfb display of its own: headless Chromium
 * captures a tab's sound as silence, measured) whose picker is answered by
 * `--auto-select-tab-capture-source-by-title`, choosing a real tab that plays
 * a stereo oscillator. Its sound reaches Mehmet through Chromium's real tab
 * audio capture, in stereo; closing that tab ends the share by itself.
 *
 * The others use the boundary fake (lib/v8music.ts): a picker answer without
 * sound is a Turkish sentence saying what to tick, never a silent share; and
 * an older desktop app (no `prepareMusicCapture`) captures nothing at all.
 */
import { chromium } from '@playwright/test'
import { freshServer } from '../lib/server'
import { expect, joinVoice, personViaApi, test } from '../lib/trio'
import { expectStereoMusic, FAKE_MUSIC_CAPTURE, fakeCaptureWithoutAudio, ownDisplay } from '../lib/v8music'

test.beforeEach(async () => {
  await freshServer()
})

const MUSIC_TAB = 'Trio Muzik Testi'

test('the real picker path: a real tab with stereo sound is shared, the picture never sent, closing the tab ends it', async ({ browser, trio }) => {
  test.setTimeout(180_000)
  const display = await ownDisplay()
  test.skip(display === null, 'no X display and no Xvfb: headless Chromium captures tab audio as silence')
  const headed = await chromium.launch({
    headless: false,
    env: { ...process.env, DISPLAY: display!.name },
    args: [
      '--use-fake-device-for-media-stream',
      `--auto-select-tab-capture-source-by-title=${MUSIC_TAB}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  })
  try {
    const ayse = trio.add(await personViaApi(headed, 'Ayşe'))
    const mehmet = trio.add(await personViaApi(browser, 'Mehmet'))
    // The "music player": another tab of Ayşe's browser, playing 440 Hz on the left only.
    const player = await ayse.context.newPage()
    await player.setContent(`<!doctype html><title>${MUSIC_TAB}</title><p>müzik</p>`)
    await player.evaluate(async () => {
      const context = new AudioContext()
      await context.resume()
      const merger = context.createChannelMerger(2)
      const tone = context.createOscillator()
      tone.frequency.value = 440
      const gain = context.createGain()
      gain.gain.value = 0.5
      tone.connect(gain).connect(merger, 0, 0)
      merger.connect(context.destination)
      tone.start()
      ;(window as unknown as { keep: unknown }).keep = context
    })
    await ayse.page.bringToFront()
    await joinVoice(ayse)
    await joinVoice(mehmet)

    await ayse.page.getByTestId('btn-music').click()
    await expect(ayse.page.getByTestId('btn-music')).toHaveAttribute('aria-pressed', 'true', { timeout: 20_000 })
    // Only audio is sent; the captured track is Chromium's real tab audio.
    const sent = await ayse.page.evaluate(() =>
      (window as unknown as { __trioPcs: RTCPeerConnection[] }).__trioPcs
        .filter((pc) => pc.connectionState !== 'closed')
        .flatMap((pc) => pc.getSenders().map((s) => (s.track ? `${s.track.kind}:${s.track.label}:${s.track.contentHint}` : 'none'))),
    )
    console.log(`real capture, senders: ${JSON.stringify(sent)}`)
    expect(sent.some((s) => s.startsWith('video'))).toBe(false)
    expect(sent).toContain('audio:Tab audio:music')
    const heard = await expectStereoMusic(mehmet, ayse, 'Mehmet hears the real tab in stereo')
    console.log(`real capture, music in: ${JSON.stringify(heard)}`)
    await expect(mehmet.page.getByTestId(`voice-user-${ayse.user.id}`)).toHaveAttribute('data-music', 'true')

    // The tab goes away: the capture ends by itself, and so does the share.
    await player.close()
    await expect(ayse.page.getByTestId('btn-music')).toHaveAttribute('aria-pressed', 'false', { timeout: 20_000 })
    await expect(mehmet.page.getByTestId(`remote-music-${ayse.user.id}`)).toHaveCount(0)
    await expect(mehmet.page.getByTestId(`voice-user-${ayse.user.id}`)).toHaveAttribute('data-music', 'false')
  } finally {
    for (const person of trio.people) await person.context.close().catch(() => undefined)
    await headed.close()
    display!.stop()
  }
})

test('a picker answer without sound is a clear error, not a silent share', async ({ browser, trio }) => {
  const ayse = trio.add(await personViaApi(browser, 'Ayşe', { prepare: async (context) => void (await context.addInitScript(FAKE_MUSIC_CAPTURE)) }))
  const mehmet = trio.add(await personViaApi(browser, 'Mehmet'))
  await joinVoice(ayse)
  await joinVoice(mehmet)
  await fakeCaptureWithoutAudio(ayse.page)
  await ayse.page.getByTestId('btn-music').click()
  await expect(ayse.page.locator('.voice-error')).toContainText('Sekme sesini de paylaş')
  await expect(ayse.page.getByTestId('btn-music')).toHaveAttribute('aria-pressed', 'false')
  await expect(mehmet.page.getByTestId(`voice-user-${ayse.user.id}`)).toHaveAttribute('data-music', 'false')
  await expect(mehmet.page.getByTestId(`remote-music-${ayse.user.id}`)).toHaveCount(0)
})

test('an older desktop app (no prepareMusicCapture) captures nothing and says to update or use Chrome', async ({ browser, trio }) => {
  const ayse = trio.add(
    await personViaApi(browser, 'Ayşe', {
      prepare: async (context) => {
        await context.addInitScript(FAKE_MUSIC_CAPTURE)
        await context.addInitScript(`window.trioDesktop = { isDesktop: true, setPttKey() {}, onPtt() { return () => {} } }`)
      },
    }),
  )
  await joinVoice(ayse)
  await ayse.page.getByTestId('btn-music').click()
  await expect(ayse.page.locator('.voice-error')).toContainText('masaüstü uygulamasını güncelle')
  expect(await ayse.page.evaluate(() => (window as unknown as { __trioMusicCalls: unknown[] }).__trioMusicCalls.length)).toBe(0)
  await expect(ayse.page.getByTestId('btn-music')).toHaveAttribute('aria-pressed', 'false')
})
