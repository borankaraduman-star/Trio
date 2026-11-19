/**
 * The voice review's UI (peer-health dot and its tooltip, the lost-microphone
 * notice, "Ekran sesini de paylaş" with its warning) and the V4 settings
 * sections, with the theme, at desktop and 390 px (deviceScaleFactor 2):
 * screenshots into e2e/screenshots/ to look at, plus the layout facts that
 * can be asserted (nothing wider than the screen, controls reachable).
 */
import type { Page } from '@playwright/test'
import { freshServer } from '../lib/server'
import { expect, joinVoice, test, threePeople, type Person } from '../lib/trio'

test.beforeEach(async () => {
  await freshServer()
})

const DESKTOP = { deviceScaleFactor: 2 }
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }

async function noOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await page.evaluate(() => window.innerWidth),
  )
}

/** Drop every ICE candidate this page signals to `to` (as in 27-ice-health). */
async function blockCandidates(page: Page, to: number): Promise<void> {
  await page.evaluate((target) => {
    const send = WebSocket.prototype.send
    WebSocket.prototype.send = function (this: WebSocket, data: string | ArrayBufferLike | Blob | ArrayBufferView) {
      if (typeof data === 'string') {
        const frame = JSON.parse(data) as { type?: string; to?: number; data?: { candidate?: unknown; description?: { sdp?: string } } }
        if (frame.type === 'signal' && frame.to === target && frame.data) {
          if ('candidate' in frame.data) return
          const sdp = frame.data.description?.sdp
          if (typeof sdp === 'string') {
            frame.data.description!.sdp = sdp.split('\r\n').filter((l) => !l.startsWith('a=candidate')).join('\r\n')
            return send.call(this, JSON.stringify(frame))
          }
        }
      }
      return send.call(this, data)
    }
  }, to)
}

async function loseMic(page: Page): Promise<void> {
  await page.evaluate(() => {
    const media = navigator.mediaDevices
    media.getUserMedia = async () => {
      throw new DOMException('Requested device not found', 'NotFoundError')
    }
    for (const track of (window as unknown as { __trioMicTracks: MediaStreamTrack[] }).__trioMicTracks) {
      if (track.readyState !== 'live') continue
      track.stop()
      track.dispatchEvent(new Event('ended'))
    }
  })
}

async function openDrawerIfNeeded(person: Person): Promise<void> {
  if (!(await person.page.getByTestId('btn-settings').isVisible())) await person.page.getByTestId('btn-drawer').click()
}

for (const [label, options] of [
  ['desktop', DESKTOP],
  ['390', PHONE],
] as const) {
  test(`voice UI with the theme (${label}): peer health, lost microphone, the settings sections`, async ({ browser, trio }) => {
    test.setTimeout(150_000)
    const people = await threePeople(browser, trio, options)
    const [ayse, mehmet, zeynep] = people
    // Mehmet and Zeynep can never reach each other: their rows show the dot.
    await blockCandidates(mehmet.page, zeynep.user.id)
    await blockCandidates(zeynep.page, mehmet.user.id)
    for (const person of people) {
      await openDrawerIfNeeded(person)
      await joinVoice(person)
    }
    const dot = mehmet.page.getByTestId(`voice-user-${zeynep.user.id}`).getByTestId('peer-health')
    await expect(dot).toBeVisible({ timeout: 20_000 })
    await expect(dot).toHaveAttribute('title', /.+/)
    await openDrawerIfNeeded(mehmet)
    await noOverflow(mehmet.page)
    await mehmet.page.screenshot({ path: `screenshots/voice-peer-health-${label}.png` })

    await loseMic(ayse.page)
    await openDrawerIfNeeded(ayse)
    await expect(ayse.page.getByTestId('mic-lost')).toBeVisible()
    await expect(ayse.page.getByTestId('mic-retry')).toBeVisible()
    await noOverflow(ayse.page)
    await ayse.page.screenshot({ path: `screenshots/voice-mic-lost-${label}.png` })

    await openDrawerIfNeeded(zeynep)
    await zeynep.page.getByTestId('btn-settings').click()
    const dialog = zeynep.page.getByTestId('settings-dialog')
    await expect(dialog).toBeVisible()
    const screenAudio = zeynep.page.getByTestId('settings-screen-audio')
    await screenAudio.scrollIntoViewIfNeeded()
    await expect(screenAudio).not.toBeChecked()
    await noOverflow(zeynep.page)
    await zeynep.page.screenshot({ path: `screenshots/settings-screen-audio-${label}.png` })
    await zeynep.page.getByTestId('settings-cues').scrollIntoViewIfNeeded()
    await zeynep.page.screenshot({ path: `screenshots/v4-settings-sounds-${label}.png` })
  })
}
