/**
 * Review finding 1: turning a camera or a screen share on and off again and
 * again must not grow the session description. Before the fix every cycle
 * added m-lines (removeTrack + addTrack never reuses a transceiver), the
 * offer grew ~5.4 KB per camera cycle, and on the 12th camera-on it passed
 * the server's 64 KiB signal cap: the pair could never renegotiate again.
 */
import type { Page } from '@playwright/test'
import { expectTileDecoding } from '../lib/media'
import { freshServer } from '../lib/server'
import { expect, expectHearing, expectScreensDecoding, joinVoice, test, threePeople, type Person } from '../lib/trio'

test.beforeEach(async () => {
  await freshServer()
})

/** The largest session description (local or remote) of this page's open connections. */
async function largestSdp(page: Page): Promise<number> {
  return page.evaluate(() =>
    Math.max(
      0,
      ...(window as unknown as { __trioPcs: RTCPeerConnection[] }).__trioPcs
        .filter((pc) => pc.connectionState !== 'closed')
        .flatMap((pc) => [pc.localDescription?.sdp.length ?? 0, pc.remoteDescription?.sdp.length ?? 0]),
    ),
  )
}

/** Every open connection of the page is stable (no negotiation left half-way). */
async function expectStable(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          (window as unknown as { __trioPcs: RTCPeerConnection[] }).__trioPcs
            .filter((pc) => pc.connectionState !== 'closed')
            .every((pc) => pc.signalingState === 'stable'),
        ),
      { timeout: 15_000, message: 'every connection should be stable' },
    )
    .toBe(true)
}

/** Live audio tracks of the screen stream a `<video data-testid=...>` plays. */
async function screenAudioTracks(page: Page, testId: string): Promise<number> {
  return page.evaluate((id) => {
    const video = document.querySelector<HTMLVideoElement>(`[data-testid="${id}"]`)
    const stream = video?.srcObject as MediaStream | null
    return stream ? stream.getAudioTracks().filter((track) => track.readyState === 'live').length : -1
  }, testId)
}

async function expectEveryoneHears(people: Person[]): Promise<void> {
  for (const listener of people) for (const speaker of people) {
    if (listener !== speaker) await expectHearing(listener, speaker)
  }
}

test('30 camera cycles and 15 screen-share cycles on one connection keep the SDP bounded; media still flows', async ({ browser, trio }) => {
  test.setTimeout(420_000)
  const people = await threePeople(browser, trio)
  const [ayse, mehmet, zeynep] = people
  for (const person of people) await joinVoice(person)
  for (const person of people) await expect(person.page.locator('[data-testid^="voice-user-"]')).toHaveCount(3)
  await expectEveryoneHears(people)

  // Mehmet's camera: he is the polite side towards Ayşe and the impolite one towards Zeynep.
  const cameraSizes: number[] = []
  for (let cycle = 1; cycle <= 30; cycle++) {
    await mehmet.page.getByTestId('btn-camera').click()
    await expect(mehmet.page.getByTestId('btn-camera')).toHaveAttribute('aria-pressed', 'true')
    for (const viewer of [ayse, zeynep]) {
      await expect(viewer.page.getByTestId(`remote-camera-${mehmet.user.id}`), `camera cycle ${cycle}`).toHaveCount(1, {
        timeout: 20_000,
      })
    }
    await expectStable(mehmet.page)
    cameraSizes.push(Math.max(await largestSdp(mehmet.page), await largestSdp(ayse.page), await largestSdp(zeynep.page)))
    if (cycle === 30) {
      for (const viewer of [ayse, zeynep]) {
        await expectTileDecoding(viewer.page, `remote-camera-${mehmet.user.id}`, 'camera', 'Mehmet')
      }
    }
    await mehmet.page.getByTestId('btn-camera').click()
    await expect(mehmet.page.getByTestId('btn-camera')).toHaveAttribute('aria-pressed', 'false')
    for (const viewer of [ayse, zeynep]) {
      await expect(viewer.page.getByTestId(`remote-camera-${mehmet.user.id}`)).toHaveCount(0)
    }
    await expectStable(mehmet.page)
  }
  console.log(`camera cycles: SDP sizes ${cameraSizes.join(' ')}`)
  // Bounded: the 30th cycle's description is no larger than the second one's (a small slack for
  // ICE candidates and longer mid numbers), and far below the 64 KiB signal cap.
  expect(cameraSizes[29]).toBeLessThanOrEqual(cameraSizes[1] + 1500)
  expect(Math.max(...cameraSizes)).toBeLessThan(20_000)
  await expectEveryoneHears(people)

  // Finding 9: a screen share carries no sound unless the sharer chose it.
  await ayse.page.getByTestId('btn-screen').click()
  await expectScreensDecoding(mehmet.page, 1)
  expect(await screenAudioTracks(ayse.page, 'local-video')).toBe(0)
  await ayse.page.getByTestId('btn-screen').click()
  await expect(mehmet.page.getByTestId('remote-video')).toHaveCount(0)
  await ayse.page.getByTestId('btn-settings').click()
  await ayse.page.getByTestId('settings-screen-audio').check()
  await ayse.page.getByTestId('settings-close').click()

  // Ayşe's screen, with its sound (screen video AND screen audio): the impolite side towards both.
  const screenSizes: number[] = []
  for (let cycle = 1; cycle <= 15; cycle++) {
    await ayse.page.getByTestId('btn-screen').click()
    await expect(ayse.page.getByTestId('btn-screen')).toHaveAttribute('aria-pressed', 'true')
    for (const viewer of [mehmet, zeynep]) {
      await expect(viewer.page.getByTestId('remote-video'), `screen cycle ${cycle}`).toHaveCount(1, { timeout: 20_000 })
    }
    await expectStable(ayse.page)
    screenSizes.push(Math.max(await largestSdp(ayse.page), await largestSdp(mehmet.page), await largestSdp(zeynep.page)))
    if (cycle === 15) {
      for (const viewer of [mehmet, zeynep]) {
        await expectScreensDecoding(viewer.page, 1)
        await expect.poll(() => screenAudioTracks(viewer.page, 'remote-video')).toBe(1)
      }
      expect(await screenAudioTracks(ayse.page, 'local-video')).toBe(1)
    }
    await ayse.page.getByTestId('btn-screen').click()
    await expect(ayse.page.getByTestId('btn-screen')).toHaveAttribute('aria-pressed', 'false')
    for (const viewer of [mehmet, zeynep]) await expect(viewer.page.getByTestId('remote-video')).toHaveCount(0)
    await expectStable(ayse.page)
  }
  console.log(`screen cycles: SDP sizes ${screenSizes.join(' ')}`)
  expect(screenSizes[14]).toBeLessThanOrEqual(screenSizes[1] + 1500)
  expect(Math.max(...screenSizes)).toBeLessThan(20_000)
  await expectEveryoneHears(people)

  // Camera and screen at once still work after all that, and so does a late joiner.
  await mehmet.page.getByTestId('btn-camera').click()
  await ayse.page.getByTestId('btn-screen').click()
  await expectTileDecoding(zeynep.page, `remote-camera-${mehmet.user.id}`, 'camera', 'Mehmet')
  await expectTileDecoding(zeynep.page, 'remote-video', 'screen', 'Ayşe · ekran')
  await zeynep.page.getByTestId('btn-hangup').click()
  await joinVoice(zeynep)
  await expectTileDecoding(zeynep.page, `remote-camera-${mehmet.user.id}`, 'camera', 'Mehmet')
  await expectTileDecoding(zeynep.page, 'remote-video', 'screen', 'Ayşe · ekran')
  await expectEveryoneHears(people)
})
