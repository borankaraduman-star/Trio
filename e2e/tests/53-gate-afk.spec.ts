/**
 * CONTRACT-V6-VOICE §4: the input gate and auto-AFK.
 *
 * Gate: every microphone in this file's browser is a steady speech-like
 * signal (~-18 dBFS peak: well under the -10 dB top of the threshold, well
 * over the speaking ring's threshold — at 0.12 it was at the ring's edge and
 * lit it in one run of three). The gate runs as an AudioWorklet built from a blob: URL
 * in the BUILT client under the app's CSP (the fixture fails the test on any
 * CSP violation). A threshold above the signal makes the receiver get
 * silence; one below lets it through; "Otomatik" removes the gate. The sent
 * track is the same object throughout and nothing renegotiates, and the
 * speaking ring follows what is actually sent.
 *
 * AFK: somebody with a SILENT microphone (a browser of their own) and a short
 * AFK time (a test hook) goes AFK, is auto-muted, everybody sees it, and any
 * input brings them back unmuted — unless they had muted themselves.
 */
import { chromium } from '@playwright/test'
import { expectEnergy, fakeAudioArgs, localDescriptions, sentAudioTrackIds, voiceish, wavFile } from '../lib/media'
import { freshServer } from '../lib/server'
import { expect, joinVoice, personViaApi, test, type Person } from '../lib/trio'

test.use({ launchOptions: { args: fakeAudioArgs(wavFile('steady-voice-020.wav', 10, (t) => 0.2 * voiceish(t))) } })

test.beforeEach(async () => {
  await freshServer()
})

async function levelDb(page: Person['page']): Promise<number> {
  let level = NaN
  await expect
    .poll(async () => {
      const text = await page.getByTestId('gate-meter').getAttribute('data-level-db')
      level = text ? Number(text) : NaN
      return Number.isFinite(level)
    })
    .toBe(true)
  return level
}

test('the input gate: silence below the threshold, through above it, Otomatik removes it; same track, no renegotiation', async ({ browser, trio }) => {
  test.setTimeout(180_000)
  const ayse = trio.add(await personViaApi(browser, 'Ayşe'))
  const mehmet = trio.add(await personViaApi(browser, 'Mehmet'))
  await joinVoice(ayse)
  await joinVoice(mehmet)
  await expect(mehmet.page.getByTestId(`remote-audio-${ayse.user.id}`)).toHaveCount(1, { timeout: 20_000 })
  await expectEnergy(mehmet, ayse, true, 'heard before any gate')
  const tracks = await sentAudioTrackIds(ayse.page)
  const sdp = await localDescriptions(ayse.page)

  await ayse.page.getByTestId('btn-settings').click()
  const meter = ayse.page.getByTestId('gate-meter')
  await expect(meter).toHaveAttribute('data-gate-state', 'off')
  // The level (after RNNoise, before the gate) is shown live.
  const level = await levelDb(ayse.page)
  console.log(`gate: input level ${level} dB`)
  expect(level).toBeGreaterThan(-60)
  expect(level).toBeLessThan(-10)

  // A threshold ABOVE the signal: the worklet loads and nothing is sent.
  await ayse.page.getByTestId('gate-auto').uncheck()
  await ayse.page.getByTestId('gate-threshold').fill('-10')
  await expect(meter).toHaveAttribute('data-gate-state', 'active')
  await expect(meter).toHaveAttribute('data-gate-open', 'false')
  await expectEnergy(mehmet, ayse, false, 'gated: the receiver gets silence')
  await expect(mehmet.page.getByTestId(`voice-user-${ayse.user.id}`)).toHaveAttribute('data-speaking', 'false')

  // Below the signal: through again (the threshold moves live, no reload of the worklet).
  await ayse.page.getByTestId('gate-threshold').fill(String(Math.round(level) - 15))
  await expect(meter).toHaveAttribute('data-gate-open', 'true')
  await expectEnergy(mehmet, ayse, true, 'open: heard')
  await expect(mehmet.page.getByTestId(`voice-user-${ayse.user.id}`)).toHaveAttribute('data-speaking', 'true', { timeout: 15_000 })

  // Above again, then Otomatik: the gate is taken out of the path.
  await ayse.page.getByTestId('gate-threshold').fill('-10')
  await expectEnergy(mehmet, ayse, false, 'gated again')
  await ayse.page.getByTestId('gate-auto').check()
  await expect(meter).toHaveAttribute('data-gate-state', 'off')
  await expectEnergy(mehmet, ayse, true, 'Otomatik: heard')

  // One sent track throughout, and nothing renegotiated.
  expect(await sentAudioTrackIds(ayse.page)).toEqual(tracks)
  expect(await localDescriptions(ayse.page)).toEqual(sdp)
  expect(await ayse.page.evaluate(() => JSON.parse(localStorage.getItem('trio.voice6') ?? '{}'))).toMatchObject({
    gateAuto: true,
    gateThresholdDb: -10,
  })
})

test('the gate is applied at join when it was left on, and survives a microphone switch', async ({ browser, trio }) => {
  test.setTimeout(120_000)
  const ayse = trio.add(await personViaApi(browser, 'Ayşe'))
  const mehmet = trio.add(await personViaApi(browser, 'Mehmet'))
  await ayse.page.evaluate(() => localStorage.setItem('trio.voice6', JSON.stringify({ gateAuto: false, gateThresholdDb: -10 })))
  await ayse.page.reload()
  await expect(ayse.page.getByTestId('composer')).toBeVisible()
  await joinVoice(ayse)
  await joinVoice(mehmet)
  await expect(mehmet.page.getByTestId(`remote-audio-${ayse.user.id}`)).toHaveCount(1)
  await expectEnergy(mehmet, ayse, false, 'gated from the start')
  await ayse.page.getByTestId('btn-settings').click()
  await expect(ayse.page.getByTestId('gate-meter')).toHaveAttribute('data-gate-state', 'active')
  const tracks = await sentAudioTrackIds(ayse.page)
  await ayse.page.getByTestId('settings-mic').selectOption({ label: 'Fake Audio Input 2' })
  await expect.poll(() => ayse.page.evaluate(() => (window as unknown as { __trioMicTracks: MediaStreamTrack[] }).__trioMicTracks.filter((t) => t.readyState === 'live').map((t) => t.label))).toEqual(['Fake Audio Input 2'])
  await expectEnergy(mehmet, ayse, false, 'still gated on the other microphone')
  await ayse.page.getByTestId('gate-threshold').fill('-70')
  await expectEnergy(mehmet, ayse, true, 'open on the other microphone')
  expect(await sentAudioTrackIds(ayse.page)).toEqual(tracks)
})

test('auto-AFK: silent and idle → AFK and auto-muted for everybody; any input brings them back; a chosen mute stays', async ({ browser, trio }) => {
  test.setTimeout(150_000)
  const silent = await chromium.launch({ args: fakeAudioArgs(wavFile('silence.wav', 5, () => 0)) })
  const ayse = trio.add(
    await personViaApi(silent, 'Ayşe', {
      prepare: async (context) => {
        await context.addInitScript('window.__trioAfkMs = 3000')
      },
    }),
  )
  const mehmet = trio.add(await personViaApi(browser, 'Mehmet'))
  await joinVoice(ayse)
  await joinVoice(mehmet)
  const ayseRow = (page: Person['page']) => page.getByTestId(`voice-user-${ayse.user.id}`)

  // Nobody touches Ayşe's page: AFK, muted, shown to Mehmet (the wire) and to her.
  await expect(ayseRow(mehmet.page)).toHaveAttribute('data-afk', 'true', { timeout: 15_000 })
  await expect(ayseRow(mehmet.page)).toHaveAttribute('data-muted', 'true')
  await expect(mehmet.page.getByTestId(`afk-${ayse.user.id}`)).toHaveText('AFK')
  await expect(ayse.page.getByTestId('btn-mute')).toHaveAttribute('aria-pressed', 'true')
  await expect(ayseRow(ayse.page)).toHaveAttribute('data-afk', 'true')

  // Back: a mouse move ends it and unmutes (the mute was automatic).
  await ayse.page.mouse.move(400, 300)
  await ayse.page.mouse.move(420, 320)
  await expect(ayseRow(mehmet.page)).toHaveAttribute('data-afk', 'false')
  await expect(ayseRow(mehmet.page)).toHaveAttribute('data-muted', 'false')
  await expect(ayse.page.getByTestId('btn-mute')).toHaveAttribute('aria-pressed', 'false')

  // A mute she chose stays after AFK.
  await ayse.page.getByTestId('btn-mute').click()
  await expect(ayseRow(mehmet.page)).toHaveAttribute('data-muted', 'true')
  await expect(ayseRow(mehmet.page)).toHaveAttribute('data-afk', 'true', { timeout: 15_000 })
  await ayse.page.keyboard.press('Shift')
  await expect(ayseRow(mehmet.page)).toHaveAttribute('data-afk', 'false')
  await expect(ayse.page.getByTestId('btn-mute')).toHaveAttribute('aria-pressed', 'true')
  await expect(ayseRow(mehmet.page)).toHaveAttribute('data-muted', 'true')

  // Turned off in the settings: an AFK in progress ends, and no new one starts.
  await ayse.page.getByTestId('btn-mute').click()
  await expect(ayseRow(mehmet.page)).toHaveAttribute('data-afk', 'true', { timeout: 15_000 })
  await ayse.page.getByTestId('btn-settings').click()
  await ayse.page.getByTestId('afk-enabled').uncheck()
  await expect(ayseRow(mehmet.page)).toHaveAttribute('data-afk', 'false')
  await ayse.page.getByTestId('settings-close').click()
  // A measurement window of twice the AFK time with no input: still not AFK.
  const since = Date.now()
  await expect.poll(() => Date.now() - since, { timeout: 10_000, intervals: [500] }).toBeGreaterThan(6500)
  await expect(ayseRow(mehmet.page)).toHaveAttribute('data-afk', 'false')

  await ayse.context.close()
  await silent.close()
})
