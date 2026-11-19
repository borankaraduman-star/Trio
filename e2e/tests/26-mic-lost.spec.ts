/**
 * Review finding 4: the microphone ends mid-call (unplugged, permission
 * revoked) and opening it again fails. The UI must say so, the mute button
 * must show that nothing is sent, and it must come back by itself when a
 * device appears (`devicechange`), or from the retry button.
 */
import type { Page } from '@playwright/test'
import { AUDIBLE, inboundEnergy, SILENT } from '../lib/media'
import { freshServer } from '../lib/server'
import { expect, expectHearing, joinVoice, test, threePeople } from '../lib/trio'

test.beforeEach(async () => {
  await freshServer()
})

/** From now on a microphone request fails (as with no microphone plugged in), or works again. */
async function micAvailable(page: Page, available: boolean): Promise<void> {
  await page.evaluate((ok) => {
    const w = window as unknown as { __trioMicBlocked?: boolean; __trioMicGateInstalled?: boolean; __trioMicRefused?: number }
    w.__trioMicBlocked = !ok
    if (w.__trioMicGateInstalled) return
    w.__trioMicGateInstalled = true
    const media = navigator.mediaDevices
    const getUserMedia = media.getUserMedia.bind(media)
    media.getUserMedia = async (constraints) => {
      if (w.__trioMicBlocked && constraints?.audio) {
        w.__trioMicRefused = (w.__trioMicRefused ?? 0) + 1
        throw new DOMException('Requested device not found', 'NotFoundError')
      }
      return getUserMedia(constraints)
    }
  }, available)
}

/** The live microphone ends the way an unplugged one does: stopped, and `ended` fired. */
async function refusedOpens(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __trioMicRefused?: number }).__trioMicRefused ?? 0)
}

async function unplugMic(page: Page): Promise<void> {
  const ended = await page.evaluate(() => {
    const tracks = (window as unknown as { __trioMicTracks: MediaStreamTrack[] }).__trioMicTracks
    const live = tracks.filter((track) => track.readyState === 'live')
    for (const track of live) {
      track.stop()
      track.dispatchEvent(new Event('ended'))
    }
    return live.length
  })
  expect(ended).toBe(1)
}

test('the microphone is unplugged: the call says so, sends nothing, and recovers on devicechange or retry', async ({ browser, trio }) => {
  test.setTimeout(150_000)
  const people = await threePeople(browser, trio)
  const [ayse, mehmet] = people
  for (const person of people) await joinVoice(person)
  await expectHearing(mehmet, ayse)
  await expect(ayse.page.getByTestId('btn-mute')).toHaveAttribute('data-transmitting', 'true')

  // Unplugged, and no other microphone to fall back to.
  await micAvailable(ayse.page, false)
  await unplugMic(ayse.page)
  const notice = ayse.page.getByTestId('mic-lost')
  await expect(notice).toBeVisible()
  await expect(notice).toContainText('Mikrofon bağlantısı kesildi')
  await expect(ayse.page.getByTestId('btn-mute')).toHaveAttribute('data-transmitting', 'false')
  await expect(ayse.page.getByTestId('btn-mute')).toHaveClass(/\boff\b/)
  // Still in the call (she hears the others), but sends silence.
  await expect(ayse.page.locator('.voice-status strong')).toHaveText('Ses bağlı')
  await expectHearing(ayse, mehmet)
  await expect.poll(() => inboundEnergy(mehmet, ayse), { timeout: 15_000 }).toBeLessThan(SILENT)

  // A device change while there is still none: tried again, still lost.
  let refused = await refusedOpens(ayse.page)
  await ayse.page.evaluate(() => navigator.mediaDevices.dispatchEvent(new Event('devicechange')))
  await expect.poll(() => refusedOpens(ayse.page)).toBeGreaterThan(refused)
  await expect(notice).toBeVisible()

  // A microphone is plugged in: the device change brings it back by itself.
  await micAvailable(ayse.page, true)
  await ayse.page.evaluate(() => navigator.mediaDevices.dispatchEvent(new Event('devicechange')))
  await expect(notice).toHaveCount(0)
  await expect(ayse.page.getByTestId('btn-mute')).toHaveAttribute('data-transmitting', 'true')
  await expect.poll(() => inboundEnergy(mehmet, ayse), { timeout: 15_000 }).toBeGreaterThan(AUDIBLE)
  for (const listener of people.slice(1)) await expectHearing(listener, ayse)

  // Again, and this time the retry button.
  await micAvailable(ayse.page, false)
  await unplugMic(ayse.page)
  await expect(notice).toBeVisible()
  refused = await refusedOpens(ayse.page)
  await ayse.page.getByTestId('mic-retry').click()
  await expect.poll(() => refusedOpens(ayse.page)).toBeGreaterThan(refused)
  await expect(notice).toBeVisible()
  await micAvailable(ayse.page, true)
  await ayse.page.getByTestId('mic-retry').click()
  await expect(notice).toHaveCount(0)
  for (const listener of people.slice(1)) await expectHearing(listener, ayse)
  // The microphone is still sent on the same track: nothing renegotiated for it.
  await expect(ayse.page.getByTestId('btn-mute')).toHaveAttribute('data-transmitting', 'true')
})
