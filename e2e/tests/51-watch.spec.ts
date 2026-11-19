/**
 * CONTRACT-V6-VOICE §2: "İzlemeyi bırak". A viewer hides a shared screen;
 * the sharer pauses ONLY that viewer's encoding (outbound bytes stop, the
 * other viewer's keep growing), shows who watches, and resumes on "İzle"
 * within ~2 s (a keyframe). None of it renegotiates; a new share is watched
 * again by default.
 */
import { freshServer } from '../lib/server'
import { expect, expectHearing, expectScreensDecoding, joinVoice, test, threePeople } from '../lib/trio'
import { countNegotiations, negotiationCounts, screenIn, screenOut } from '../lib/v6voice'

test.beforeEach(async () => {
  await freshServer()
})

/** A measurement window (not a wait for something to happen). */
const window_ = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test('a viewer that stops watching gets no encoding; the other keeps it; watching again resumes within ~2 s', async ({ browser, trio }) => {
  test.setTimeout(180_000)
  const people = await threePeople(browser, trio)
  const [ayse, mehmet, zeynep] = people
  for (const person of people) await joinVoice(person)
  for (const person of people) await expect(person.page.locator('[data-testid^="voice-user-"]')).toHaveCount(3)

  await ayse.page.getByTestId('btn-screen').click()
  await expectScreensDecoding(mehmet.page, 1)
  await expectScreensDecoding(zeynep.page, 1)
  await expect(ayse.page.getByTestId('local-watchers')).toHaveAttribute('data-count', '2')
  for (const person of people) await countNegotiations(person.page)

  // Mehmet stops watching.
  await mehmet.page.getByTestId('stage').locator('figure[data-kind="screen"]').hover()
  await mehmet.page.getByTestId(`btn-unwatch-${ayse.user.id}`).click()
  await expect(mehmet.page.getByTestId('remote-video')).toHaveCount(0)
  await expect(mehmet.page.getByTestId(`hidden-screen-${ayse.user.id}`)).toBeVisible()
  await expect(ayse.page.getByTestId('local-watchers')).toHaveAttribute('data-count', '1')
  await expect.poll(async () => (await screenOut(ayse, mehmet)).active).toEqual([false])
  expect((await screenOut(ayse, zeynep)).active).toEqual([true])

  // Over two seconds: nothing more goes to Mehmet, Zeynep's keeps growing.
  // The pause has taken effect once two readings 300 ms apart agree (packets in flight have landed).
  let previous = -1
  await expect
    .poll(async () => {
      const now = (await screenOut(ayse, mehmet)).bytesSent
      const same = now === previous
      previous = now
      return same
    }, { intervals: [300] })
    .toBe(true)
  const toMehmet = (await screenOut(ayse, mehmet)).bytesSent
  const toZeynep = (await screenOut(ayse, zeynep)).bytesSent
  const atMehmet = await screenIn(mehmet, ayse)
  await window_(2000)
  const toMehmet2 = (await screenOut(ayse, mehmet)).bytesSent
  const toZeynep2 = (await screenOut(ayse, zeynep)).bytesSent
  const atMehmet2 = await screenIn(mehmet, ayse)
  expect(toMehmet2 - toMehmet, 'bytes sent to the viewer who stopped watching').toBe(0)
  expect(atMehmet2.bytes - atMehmet.bytes, 'bytes Mehmet received').toBe(0)
  expect(toZeynep2 - toZeynep, 'bytes sent to the viewer still watching').toBeGreaterThan(20_000)
  await expectScreensDecoding(zeynep.page, 1)

  // The share menu says who is watching.
  await ayse.page.getByTestId('btn-share-menu').click()
  await expect(ayse.page.getByTestId('share-watchers')).toHaveText('İzleyenler: Zeynep')
  await expect(ayse.page.getByTestId('share-estimate')).toHaveText('Yükleme: 1 izleyici × 3 Mbps ≈ 3 Mbps')
  await ayse.page.keyboard.press('Escape')

  // Watching again: frames decode again within ~2 s (the encoder restarts with a keyframe).
  const before = await screenIn(mehmet, ayse)
  const clicked = Date.now()
  await mehmet.page.getByTestId(`btn-watch-${ayse.user.id}`).click()
  await expect
    .poll(async () => (await screenIn(mehmet, ayse)).frames, { timeout: 2500, intervals: [100], message: 'frames again within ~2 s' })
    .toBeGreaterThan(before.frames)
  const resumedMs = Date.now() - clicked
  await expectScreensDecoding(mehmet.page, 1)
  await expect(ayse.page.getByTestId('local-watchers')).toHaveAttribute('data-count', '2')
  console.log(`watch: frames decoded again ${resumedMs} ms after "İzle"`)

  // No renegotiation on any side; the call is intact.
  for (const person of people) {
    expect(await negotiationCounts(person.page), person.name).toEqual({ transitions: 0, needed: 0, offers: 0 })
  }
  await expectHearing(mehmet, ayse)
  await expectHearing(ayse, mehmet)

  // Hidden again, then a NEW share: watched by default (a new stream id).
  await mehmet.page.getByTestId('stage').locator('figure[data-kind="screen"]').hover()
  await mehmet.page.getByTestId(`btn-unwatch-${ayse.user.id}`).click()
  await expect(mehmet.page.getByTestId('remote-video')).toHaveCount(0)
  await ayse.page.getByTestId('btn-screen').click()
  await expect(mehmet.page.getByTestId(`hidden-screen-${ayse.user.id}`)).toHaveCount(0)
  await ayse.page.getByTestId('btn-screen').click()
  await expectScreensDecoding(mehmet.page, 1)
  await expect(ayse.page.getByTestId('local-watchers')).toHaveAttribute('data-count', '2')
  await expect.poll(async () => (await screenOut(ayse, mehmet)).active).toEqual([true])
})
