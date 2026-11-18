import type { Page } from '@playwright/test'
import { expectEnergy, fakeAudioArgs, voiceish, wavFile } from '../lib/media'
import { freshServer } from '../lib/server'
import { apiJoin, expect, joinVoice, personViaApi, personWithSession, test, type Person } from '../lib/trio'

// A continuous voice-like microphone instead of the fake device's beep, so
// that "silent" and "heard" can be told apart at any moment.
test.use({ launchOptions: { args: fakeAudioArgs(wavFile('voiceish.wav', 10, voiceish)) } })

test.beforeEach(async () => {
  await freshServer()
})

const row = (viewer: Person, subject: Person) => viewer.page.getByTestId(`voice-user-${subject.user.id}`)
const transmitting = (person: Person) => expect(person.page.getByTestId('btn-mute'))

/** Somewhere to put the focus that is not a text field. */
async function focusOutsideFields(page: Page): Promise<void> {
  await page.locator('.main-header h1').click()
}

test('push-to-talk: silent unless the key is held; tail, typing, blur, mute', async ({ browser, trio }) => {
  test.setTimeout(150_000)
  // Ayşe uses push-to-talk with the default key (Backquote); RNNoise is off
  // so that what is sent is exactly the gate's doing.
  const ayse = trio.add(
    await personWithSession(browser, 'Ayşe', await apiJoin('Ayşe'), {
      prepare: async (context) => {
        await context.addInitScript(() => {
          if (!sessionStorage.getItem('trio.e2e.settings')) {
            sessionStorage.setItem('trio.e2e.settings', '1')
            localStorage.setItem('trio.settings', JSON.stringify({ version: 1, inputMode: 'ptt', noiseSuppression: false }))
          }
        })
      },
    }),
  )
  const mehmet = trio.add(await personViaApi(browser, 'Mehmet'))
  const zeynep = trio.add(await personViaApi(browser, 'Zeynep'))
  const listeners = [mehmet, zeynep]
  for (const person of [ayse, mehmet, zeynep]) await joinVoice(person)
  for (const listener of listeners) await expect(listener.page.getByTestId(`remote-audio-${ayse.user.id}`)).toHaveCount(1)

  // Key up: nothing is sent, and the others see her NOT muted (PTT is local).
  for (const listener of listeners) {
    await expectEnergy(listener, ayse, false, 'key up')
    await expect(row(listener, ayse)).toHaveAttribute('data-muted', 'false')
    await expect(row(listener, ayse)).toHaveAttribute('data-speaking', 'false')
  }
  await transmitting(ayse).toHaveAttribute('data-transmitting', 'false')
  // Mehmet (activity mode) is heard all the time.
  await expectEnergy(ayse, mehmet, true, 'activity mode')

  // Held, with the focus outside any text field: heard, and shown speaking.
  await focusOutsideFields(ayse.page)
  await ayse.page.keyboard.down('Backquote')
  await transmitting(ayse).toHaveAttribute('data-transmitting', 'true')
  for (const listener of listeners) {
    await expectEnergy(listener, ayse, true, 'key held')
    await expect(row(listener, ayse)).toHaveAttribute('data-speaking', 'true')
    await expect(row(listener, ayse)).toHaveAttribute('data-muted', 'false')
  }

  // Release: the gate stays open for the 150 ms tail, then closes.
  await ayse.page.evaluate(() => {
    const w = window as unknown as { __release: { up: number; closed: number } }
    w.__release = { up: 0, closed: 0 }
    window.addEventListener('keyup', () => (w.__release.up = performance.now()), { once: true, capture: true })
    const button = document.querySelector('[data-testid="btn-mute"]')!
    new MutationObserver((_, observer) => {
      if (button.getAttribute('data-transmitting') === 'false') {
        w.__release.closed = performance.now()
        observer.disconnect()
      }
    }).observe(button, { attributes: true, attributeFilter: ['data-transmitting'] })
  })
  await ayse.page.keyboard.up('Backquote')
  await transmitting(ayse).toHaveAttribute('data-transmitting', 'false')
  const tail = await ayse.page.evaluate(() => {
    const r = (window as unknown as { __release: { up: number; closed: number } }).__release
    return r.closed - r.up
  })
  expect(tail).toBeGreaterThanOrEqual(140)
  expect(tail).toBeLessThan(600)
  for (const listener of listeners) {
    await expectEnergy(listener, ayse, false, 'after release')
    await expect(row(listener, ayse)).toHaveAttribute('data-speaking', 'false')
  }

  // Typing: the same key in the composer types a character and opens nothing.
  await ayse.page.getByTestId('composer').click()
  await ayse.page.keyboard.down('Backquote')
  await expect(ayse.page.getByTestId('composer')).toHaveValue('`')
  await transmitting(ayse).toHaveAttribute('data-transmitting', 'false')
  await expectEnergy(mehmet, ayse, false, 'key held while typing')
  await ayse.page.keyboard.up('Backquote')

  // Losing the window while held releases the key.
  await focusOutsideFields(ayse.page)
  await ayse.page.keyboard.down('Backquote')
  await transmitting(ayse).toHaveAttribute('data-transmitting', 'true')
  await expectEnergy(mehmet, ayse, true, 'held again')
  await ayse.page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await transmitting(ayse).toHaveAttribute('data-transmitting', 'false')
  await expectEnergy(mehmet, ayse, false, 'after blur, the key still physically down')
  await ayse.page.keyboard.up('Backquote')

  // Mute wins over the key, and only the mute button reaches voice.state.
  await ayse.page.getByTestId('btn-mute').click()
  for (const listener of listeners) await expect(row(listener, ayse)).toHaveAttribute('data-muted', 'true')
  await focusOutsideFields(ayse.page)
  await ayse.page.keyboard.down('Backquote')
  await transmitting(ayse).toHaveAttribute('data-transmitting', 'false')
  for (const listener of listeners) await expectEnergy(listener, ayse, false, 'muted, key held')
  await ayse.page.keyboard.up('Backquote')
  await ayse.page.getByTestId('btn-mute').click()
  for (const listener of listeners) {
    await expect(row(listener, ayse)).toHaveAttribute('data-muted', 'false')
    await expectEnergy(listener, ayse, false, 'unmuted, key up')
  }

  // Back to voice activity in the settings: heard without the key.
  await ayse.page.getByTestId('btn-settings').click()
  await ayse.page.getByTestId('settings-mode-activity').check()
  await ayse.page.getByTestId('settings-close').click()
  await transmitting(ayse).toHaveAttribute('data-transmitting', 'true')
  for (const listener of listeners) await expectEnergy(listener, ayse, true, 'activity mode again')
})
