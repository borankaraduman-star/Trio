import { freshServer } from '../lib/server'
import { expect, expectHearing, expectScreensDecoding, joinVoice, test, threePeople, type Person } from '../lib/trio'

test.beforeEach(async () => {
  await freshServer()
})

const row = (viewer: Person, subject: Person) => viewer.page.getByTestId(`voice-user-${subject.user.id}`)

test('screen share: the others see it decoding; stop removes it; a late joiner gets it', async ({ browser, trio }) => {
  test.setTimeout(150_000)
  const [ayse, mehmet, zeynep] = await threePeople(browser, trio)
  await joinVoice(ayse)
  await joinVoice(mehmet)

  await ayse.page.getByTestId('btn-screen').click()
  await expect(ayse.page.getByTestId('btn-screen')).toHaveAttribute('aria-pressed', 'true')
  await expect(ayse.page.getByTestId('local-video')).toBeVisible()
  await expectScreensDecoding(mehmet.page, 1)
  await expect(row(mehmet, ayse)).toHaveAttribute('data-screensharing', 'true')
  await expect(mehmet.page.getByTestId('stage').locator('figcaption')).toHaveText(['Ayşe · ekran'])
  // The sharer sees no remote screen of her own.
  await expect(ayse.page.getByTestId('remote-video')).toHaveCount(0)
  // The renegotiation did not break the audio.
  await expectHearing(mehmet, ayse)
  await expectHearing(ayse, mehmet)

  // Zeynep joins the call AFTER the share started and still gets it.
  await joinVoice(zeynep)
  await expectScreensDecoding(zeynep.page, 1)
  await expect(row(zeynep, ayse)).toHaveAttribute('data-screensharing', 'true')
  await expectHearing(zeynep, ayse)
  await expectHearing(zeynep, mehmet)

  // Stop: gone for both, the flag follows, audio stays.
  await ayse.page.getByTestId('btn-screen').click()
  await expect(ayse.page.getByTestId('btn-screen')).toHaveAttribute('aria-pressed', 'false')
  for (const viewer of [mehmet, zeynep]) {
    await expect(viewer.page.getByTestId('remote-video')).toHaveCount(0)
    await expect(viewer.page.getByTestId('stage')).toHaveCount(0)
    await expect(row(viewer, ayse)).toHaveAttribute('data-screensharing', 'false')
  }
  await expect(ayse.page.getByTestId('local-video')).toHaveCount(0)
  await expectHearing(mehmet, ayse)

  // Share again after stopping: arrives again.
  await ayse.page.getByTestId('btn-screen').click()
  await expectScreensDecoding(mehmet.page, 1)
  await expectScreensDecoding(zeynep.page, 1)
})

test('screen share: two people sharing at once both arrive', async ({ browser, trio }) => {
  test.setTimeout(150_000)
  const people = await threePeople(browser, trio)
  const [ayse, mehmet, zeynep] = people
  for (const person of people) await joinVoice(person)
  for (const person of people) {
    await expect(person.page.locator('[data-testid^="voice-user-"]')).toHaveCount(3)
  }

  // Both click at the same moment: renegotiation glare on the Ayşe-Mehmet link.
  await Promise.all([ayse.page.getByTestId('btn-screen').click(), mehmet.page.getByTestId('btn-screen').click()])
  await expectScreensDecoding(zeynep.page, 2)
  await expectScreensDecoding(ayse.page, 1)
  await expectScreensDecoding(mehmet.page, 1)
  await expect(zeynep.page.getByTestId('stage').locator('figcaption')).toHaveText(['Ayşe · ekran', 'Mehmet · ekran'])
  for (const listener of people) for (const speaker of people) {
    if (listener !== speaker) await expectHearing(listener, speaker)
  }

  // One stops; the other's screen stays.
  await mehmet.page.getByTestId('btn-screen').click()
  await expectScreensDecoding(zeynep.page, 1)
  await expect(zeynep.page.getByTestId('stage').locator('figcaption')).toHaveText(['Ayşe · ekran'])
  await expect(ayse.page.getByTestId('remote-video')).toHaveCount(0)

  // The tile's fullscreen button asks for fullscreen (CallStage: a click on
  // the tile itself enlarges it in the stage instead).
  const fullscreenButton = zeynep.page.getByRole('button', { name: 'Tam ekran: Ayşe · ekran' })
  await fullscreenButton.click()
  await expect
    .poll(() => zeynep.page.evaluate(() => document.fullscreenElement?.querySelector('video')?.getAttribute('data-testid')))
    .toBe('remote-video')
  await fullscreenButton.click()
  await expect.poll(() => zeynep.page.evaluate(() => document.fullscreenElement)).toBeNull()

  // The sharer leaving the call takes the screen away.
  await ayse.page.getByTestId('btn-hangup').click()
  await expect(zeynep.page.getByTestId('remote-video')).toHaveCount(0)
  await expect(mehmet.page.getByTestId('remote-video')).toHaveCount(0)
})
