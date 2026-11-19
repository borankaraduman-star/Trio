/**
 * CONTRACT-V6-VOICE §1: screen-share profiles. Each profile reaches the
 * sender (setParameters) and the capture (contentHint, applyConstraints), a
 * switch during a share renegotiates NOTHING (no signaling-state transition,
 * no negotiationneeded, no offer, the same SDP), and what the encoder then
 * produces is measured from outbound-rtp stats under the fake capture.
 */
import { localDescriptions } from '../lib/media'
import { freshServer } from '../lib/server'
import { expect, expectHearing, expectScreensDecoding, joinVoice, test, threePeople, type Person } from '../lib/trio'
import { countNegotiations, negotiationCounts, screenOut, type ScreenOut } from '../lib/v6voice'

test.beforeEach(async () => {
  await freshServer()
})

/** Poll the sender towards `viewer` until `check` holds; the last reading. */
async function settled(sharer: Person, viewer: Person, check: (out: ScreenOut) => boolean, what: string): Promise<ScreenOut> {
  let last: ScreenOut | null = null
  await expect
    .poll(
      async () => {
        last = await screenOut(sharer, viewer)
        return check(last)
      },
      { timeout: 20_000, message: `${what}: ${JSON.stringify(last)}` },
    )
    .toBe(true)
  return last as unknown as ScreenOut
}

test('share profiles: parameters reach every sender, switching never renegotiates, the choice is remembered', async ({ browser, trio }) => {
  test.setTimeout(180_000)
  const people = await threePeople(browser, trio)
  const [ayse, mehmet, zeynep] = people
  for (const person of people) await joinVoice(person)
  for (const person of people) await expect(person.page.locator('[data-testid^="voice-user-"]')).toHaveCount(3)

  // Before sharing: the menu estimates the mesh upload for the two others.
  await ayse.page.getByTestId('btn-share-menu').click()
  await ayse.page.getByTestId('share-profile-game').click()
  await ayse.page.getByTestId('share-quality-high').click()
  await expect(ayse.page.getByTestId('share-estimate')).toHaveText('Paylaşırsan yükleme: 2 izleyici × 6 Mbps ≈ 12 Mbps')
  await ayse.page.keyboard.press('Escape')
  await expect(ayse.page.getByTestId('share-menu')).toHaveCount(0)

  await ayse.page.getByTestId('btn-screen').click()
  await expectScreensDecoding(mehmet.page, 1)
  await expectScreensDecoding(zeynep.page, 1)

  const measured: Record<string, ScreenOut> = {}
  for (const viewer of [mehmet, zeynep]) {
    measured[`game→${viewer.name}`] = await settled(
      ayse,
      viewer,
      (o) =>
        o.maxBitrate[0] === 6_000_000 &&
        o.maxFramerate[0] === 60 &&
        o.degradationPreference === 'maintain-framerate' &&
        o.contentHint === 'motion' &&
        (o.frameHeight ?? 0) > 0,
      `Oyun/Yüksek towards ${viewer.name}`,
    )
  }
  const game = measured[`game→${mehmet.name}`]
  // The capture is capped at 1080p for Oyun/Yüksek.
  expect(game.trackSettings?.height ?? 0).toBeLessThanOrEqual(1080)
  expect(game.trackSettings?.width ?? 0).toBeLessThanOrEqual(1920)

  // --- switching during the share: nothing renegotiates ---------------------------------
  for (const person of people) await countNegotiations(person.page)
  const sdpBefore = await Promise.all(people.map((p) => localDescriptions(p.page)))

  await ayse.page.getByTestId('share-chip').click()
  await ayse.page.getByTestId('share-profile-text').click()
  measured['text'] = await settled(
    ayse,
    mehmet,
    (o) =>
      o.maxFramerate[0] === 15 &&
      o.degradationPreference === 'maintain-resolution' &&
      o.contentHint === 'detail' &&
      o.trackSettings?.frameRate !== undefined &&
      o.trackSettings.frameRate <= 15 &&
      // full resolution again after Oyun's cap: the fake source's own 1920×1080
      (o.trackSettings.height ?? 0) >= 1080 &&
      // the encoder follows: at most the cap (with a frame of slack in the rate estimate)
      o.framesPerSecond !== null &&
      o.framesPerSecond <= 16,
    'Metin towards Mehmet',
  )
  await ayse.page.getByTestId('share-quality-low').click()
  await ayse.page.getByTestId('share-profile-film').click()
  measured['film'] = await settled(
    ayse,
    zeynep,
    (o) =>
      o.maxBitrate[0] === 1_500_000 &&
      o.maxFramerate[0] === 30 &&
      o.degradationPreference === 'balanced' &&
      o.contentHint === 'motion' &&
      o.framesPerSecond !== null &&
      o.framesPerSecond <= 31,
    'Film/Düşük towards Zeynep',
  )
  await ayse.page.getByTestId('share-profile-game').click()
  await ayse.page.getByTestId('share-quality-mid').click()
  measured['game-mid'] = await settled(
    ayse,
    mehmet,
    (o) => o.maxFramerate[0] === 60 && o.maxBitrate[0] === 3_000_000 && (o.trackSettings?.height ?? 9999) <= 720,
    'Oyun/Orta towards Mehmet (720p cap)',
  )

  for (const [i, person] of people.entries()) {
    expect(await negotiationCounts(person.page), `${person.name}: no renegotiation from a profile switch`).toEqual({
      transitions: 0,
      needed: 0,
      offers: 0,
    })
    expect(await localDescriptions(person.page)).toEqual(sdpBefore[i])
  }
  // The screen still decodes for both, and the call is intact.
  await expectScreensDecoding(mehmet.page, 1)
  await expectScreensDecoding(zeynep.page, 1)
  await expectHearing(mehmet, ayse)
  await expectHearing(ayse, zeynep)

  // Remembered for the next share (and the next load).
  expect(await ayse.page.evaluate(() => JSON.parse(localStorage.getItem('trio.voice6') ?? '{}'))).toMatchObject({
    shareProfile: 'game',
    shareQuality: 'mid',
  })
  await ayse.page.getByTestId('btn-screen').click()
  await expect(mehmet.page.getByTestId('remote-video')).toHaveCount(0)
  await ayse.page.reload()
  await expect(ayse.page.getByTestId('composer')).toBeVisible()
  await joinVoice(ayse)
  await ayse.page.getByTestId('btn-share-menu').click()
  await expect(ayse.page.getByTestId('share-profile-game')).toHaveAttribute('aria-checked', 'true')
  await expect(ayse.page.getByTestId('share-quality-mid')).toHaveAttribute('aria-checked', 'true')

  // What the fake capture gave per profile (for the report; asserted above only as caps).
  console.log(
    'share profiles measured:',
    JSON.stringify(
      Object.fromEntries(
        Object.entries(measured).map(([k, o]) => [
          k,
          { fps: o.framesPerSecond, w: o.frameWidth, h: o.frameHeight, limit: o.qualityLimitationReason, capture: o.trackSettings },
        ]),
      ),
    ),
  )
})
