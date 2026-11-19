/**
 * CONTRACT-V6-VOICE §3: per-person volume. 0–100 % is the element's own
 * volume (the echo-cancelled path); above 100 % the stream goes through Web
 * Audio (gain, then a limiter), measured here on the post-gain node: the
 * level it carries is the slider times the stream's own. Deafen silences it,
 * the speaking ring keeps reading what they send, the choice is per user and
 * remembered, and it survives a signalling drop and an output-device switch.
 */
import { chromium } from '@playwright/test'
import { fakeAudioArgs, voiceish, wavFile } from '../lib/media'
import { freshServer } from '../lib/server'
import { expect, joinVoice, personViaApi, test, type Person } from '../lib/trio'
import { socketSwitch } from '../lib/voiceProbe'
import { audioElement, boostLevels, VOLUME_PROBE } from '../lib/v6voice'

test.beforeEach(async () => {
  await freshServer()
})

/**
 * The boosted level against the stream's own, read over the same window.
 * Below the limiter (-6 dBFS) the ratio is the slider; a stream the slider
 * would push past it is held under full scale and still well above itself.
 */
async function expectGain(listener: Person, speaker: Person, gain: number, what: string): Promise<void> {
  let last: { tap: number | null; source: number } | null = null
  try {
  await expect
    .poll(
      async () => {
        last = await boostLevels(listener.page, speaker.user.id)
        if (last.tap === null || last.source < 0.01) return false
        if (last.source * gain <= 0.45) return Math.abs(last.tap / last.source - gain) / gain < 0.15
        return last.tap <= 1 && last.tap >= Math.min(0.75, last.source * 1.2)
      },
      { timeout: 20_000, message: what },
    )
    .toBe(true)
  } catch (error) {
    throw new Error(`${what}: last ${JSON.stringify(last)}\n${String(error)}`)
  }
  console.log(`volume ${what}: ${JSON.stringify(last)}`)
}

async function openSheet(listener: Person, speaker: Person): Promise<void> {
  await listener.page.getByTestId(`voice-user-${speaker.user.id}`).click({ button: 'right' })
  await expect(listener.page.getByTestId('volume-sheet')).toBeVisible()
}

test('per-person volume: element up to 100 %, a measured boost above, deafen wins, remembered, kept across a drop and a device switch', async ({ browser, trio }) => {
  test.setTimeout(180_000)
  const sw = socketSwitch()
  const ayse = trio.add(
    await personViaApi(browser, 'Ayşe', {
      prepare: async (context) => {
        await context.addInitScript(VOLUME_PROBE)
        await sw.prepare(context)
      },
    }),
  )
  const mehmet = trio.add(await personViaApi(browser, 'Mehmet'))
  // Zeynep's microphone is a quiet speech-like signal (her own browser), so a
  // boost of it stays under the limiter and the ratio is the slider itself;
  // Mehmet's is the fake beep (~0.6 peak), which a 200 % boost pushes into it.
  const quietBrowser = await chromium.launch({
    args: fakeAudioArgs(wavFile('quiet-voice.wav', 10, (t) => 0.3 * voiceish(t))),
  })
  const zeynep = trio.add(await personViaApi(quietBrowser, 'Zeynep'))
  for (const person of [ayse, mehmet, zeynep]) await joinVoice(person)
  await expect(ayse.page.getByTestId(`remote-audio-${mehmet.user.id}`)).toHaveCount(1)
  await expect(ayse.page.getByTestId(`remote-audio-${zeynep.user.id}`)).toHaveCount(1)

  // Untouched: the element path at 100 %.
  expect(await audioElement(ayse.page, mehmet.user.id)).toEqual({ volume: 1, muted: false, route: 'element' })

  await openSheet(ayse, mehmet)
  const slider = ayse.page.getByTestId('volume-voice')
  await slider.fill('50')
  await expect(ayse.page.getByTestId('volume-voice-value')).toHaveText('%50')
  await expect.poll(() => audioElement(ayse.page, mehmet.user.id)).toEqual({ volume: 0.5, muted: false, route: 'element' })

  // 0 %: silent for me — and the ring still says Mehmet is talking (it reads what he sends).
  await slider.fill('0')
  await expect.poll(() => audioElement(ayse.page, mehmet.user.id)).toEqual({ volume: 0, muted: false, route: 'element' })
  await expect(ayse.page.getByTestId(`voice-user-${mehmet.user.id}`)).toHaveAttribute('data-speaking', 'true', { timeout: 15_000 })

  // Above 100 %: through Web Audio, element muted, the level scaled.
  await slider.fill('150')
  await expect.poll(async () => (await audioElement(ayse.page, mehmet.user.id)).route).toBe('webaudio')
  expect((await audioElement(ayse.page, mehmet.user.id)).muted).toBe(true)
  await expectGain(ayse, mehmet, 1.5, '150 %')
  await slider.fill('200')
  await expectGain(ayse, mehmet, 2, '200 %')
  // Zeynep is untouched.
  expect(await audioElement(ayse.page, zeynep.user.id)).toEqual({ volume: 1, muted: false, route: 'element' })
  await ayse.page.keyboard.press('Escape')
  await expect(ayse.page.getByTestId('volume-sheet')).toHaveCount(0)

  // Zeynep's quiet voice: below the limiter, the level is exactly the slider.
  await openSheet(ayse, zeynep)
  await ayse.page.getByTestId('volume-voice').fill('150')
  await expectGain(ayse, zeynep, 1.5, 'Zeynep 150 %')
  await ayse.page.getByTestId('volume-voice').fill('200')
  await expectGain(ayse, zeynep, 2, 'Zeynep 200 %')
  await ayse.page.getByTestId('volume-reset').click()
  await expect.poll(() => audioElement(ayse.page, zeynep.user.id)).toEqual({ volume: 1, muted: false, route: 'element' })
  await ayse.page.keyboard.press('Escape')
  await expect(ayse.page.getByTestId('volume-sheet')).toHaveCount(0)

  // Remembered per user id.
  expect(await ayse.page.evaluate(() => JSON.parse(localStorage.getItem('trio.voice6') ?? '{}').volumes)).toEqual({
    [String(mehmet.user.id)]: { voice: 2, stream: 1 },
  })

  // Deafen wins over the boost.
  await ayse.page.getByTestId('btn-deafen').click()
  await expect
    .poll(async () => (await boostLevels(ayse.page, mehmet.user.id)).tap, { message: 'deafened: the boosted route is silent' })
    .toBeLessThan(0.0005)
  expect((await audioElement(ayse.page, zeynep.user.id)).muted).toBe(true)
  await ayse.page.getByTestId('btn-deafen').click()
  await expectGain(ayse, mehmet, 2, '200 % after undeafen')

  // A signalling drop (the call is kept, then resumed): still boosted.
  await sw.cut()
  await expect(ayse.page.getByTestId('connection-banner')).toHaveAttribute('data-voice-kept', 'true')
  sw.online = true
  await expect(ayse.page.getByTestId('connection-banner')).toHaveCount(0, { timeout: 30_000 })
  await expect(ayse.page.locator('.voice-status strong')).toHaveText('Ses bağlı')
  await expectGain(ayse, mehmet, 2, '200 % after the resume')

  // The output device switch: the boosted audio follows it.
  await ayse.page.getByTestId('btn-settings').click()
  await ayse.page.getByTestId('settings-output').selectOption({ label: 'Fake Audio Output 1' })
  const chosen = await ayse.page.getByTestId('settings-output').inputValue()
  expect(chosen).not.toBe('')
  await expect
    .poll(() => ayse.page.evaluate(() => (window as unknown as { __trioMixer: { output: { via: string; sinkId: string } } }).__trioMixer.output))
    .toEqual({ via: 'element', sinkId: chosen })
  await ayse.page.getByTestId('settings-close').click()
  await expectGain(ayse, mehmet, 2, '200 % on Fake Audio Output 1')
  // And back to the default device: the context's own output again.
  await ayse.page.getByTestId('btn-settings').click()
  await ayse.page.getByTestId('settings-output').selectOption({ value: '' })
  await expect
    .poll(() => ayse.page.evaluate(() => (window as unknown as { __trioMixer: { output: { via: string; sinkId: string } } }).__trioMixer.output))
    .toEqual({ via: 'context', sinkId: '' })
  await ayse.page.getByTestId('settings-close').click()
  await expectGain(ayse, mehmet, 2, '200 % on the default output again')

  // Herkes için sıfırla: back to the element at 100 %.
  await openSheet(ayse, mehmet)
  await ayse.page.getByTestId('volume-reset-all').click()
  await expect(ayse.page.getByTestId('volume-voice-value')).toHaveText('%100')
  await expect.poll(() => audioElement(ayse.page, mehmet.user.id)).toEqual({ volume: 1, muted: false, route: 'element' })
  expect(await ayse.page.evaluate(() => JSON.parse(localStorage.getItem('trio.voice6') ?? '{}').volumes)).toEqual({})
  await zeynep.context.close()
  await quietBrowser.close()
})
