import type { Page } from '@playwright/test'
import { expectTileDecoding, stageTiles } from '../lib/media'
import { freshServer } from '../lib/server'
import { expect, expectHearing, joinVoice, test, threePeople, type Person } from '../lib/trio'

test.beforeEach(async () => {
  await freshServer()
})

const row = (viewer: Person, subject: Person) => viewer.page.getByTestId(`voice-user-${subject.user.id}`)

async function expectEveryoneHears(people: Person[]): Promise<void> {
  for (const listener of people) for (const speaker of people) {
    if (listener !== speaker) await expectHearing(listener, speaker)
  }
}

/** The camera tracks this page ever opened, and which of them it still sends. */
async function cameraTracks(page: Page): Promise<{ states: string[]; sent: number }> {
  return page.evaluate(() => {
    const w = window as unknown as { __trioCameraTracks: MediaStreamTrack[]; __trioPcs: RTCPeerConnection[] }
    const tracks = w.__trioCameraTracks
    const sent = w.__trioPcs
      .filter((pc) => pc.connectionState !== 'closed')
      .flatMap((pc) => pc.getSenders())
      .filter((s) => s.track !== null && tracks.includes(s.track)).length
    return { states: tracks.map((t) => t.readyState), sent }
  })
}

test('camera: two cameras and a screen at once, for everyone; camera off keeps the screen; a late joiner gets it all', async ({ browser, trio }) => {
  test.setTimeout(180_000)
  const people = await threePeople(browser, trio)
  const [ayse, mehmet, zeynep] = people
  await joinVoice(ayse)
  await joinVoice(mehmet)

  // Ayşe turns on her camera AND shares her screen in the same instant (one
  // task: concurrent Playwright clicks on one page would share its mouse):
  // two video streams on one connection, told apart only by the `meta` signal.
  await ayse.page.evaluate(() => {
    for (const id of ['btn-camera', 'btn-screen']) document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!.click()
  })
  await mehmet.page.getByTestId('btn-camera').click()
  await expect(ayse.page.getByTestId('btn-camera')).toHaveAttribute('aria-pressed', 'true')
  await expect(ayse.page.getByTestId('btn-screen')).toHaveAttribute('aria-pressed', 'true')
  await expect(ayse.page.getByTestId('local-camera')).toBeVisible()
  await expect(ayse.page.getByTestId('local-video')).toBeVisible()

  await expectTileDecoding(mehmet.page, `remote-camera-${ayse.user.id}`, 'camera', 'Ayşe')
  await expectTileDecoding(mehmet.page, 'remote-video', 'screen', 'Ayşe · ekran')
  await expectTileDecoding(ayse.page, `remote-camera-${mehmet.user.id}`, 'camera', 'Mehmet')
  await expect(ayse.page.getByTestId('remote-video')).toHaveCount(0)

  // Zeynep joins the call afterwards and gets all three, each in its own tile.
  await joinVoice(zeynep)
  await expectTileDecoding(zeynep.page, `remote-camera-${ayse.user.id}`, 'camera', 'Ayşe')
  await expectTileDecoding(zeynep.page, `remote-camera-${mehmet.user.id}`, 'camera', 'Mehmet')
  await expectTileDecoding(zeynep.page, 'remote-video', 'screen', 'Ayşe · ekran')
  expect(await stageTiles(zeynep.page)).toEqual([
    `screen:${ayse.user.id}`,
    `camera:${ayse.user.id}`,
    `camera:${mehmet.user.id}`,
  ])
  expect(await stageTiles(mehmet.page)).toEqual([`screen:${ayse.user.id}`, `camera:${ayse.user.id}`, 'camera:me'])
  expect(await stageTiles(ayse.page)).toEqual([`camera:${mehmet.user.id}`, 'screen:me', 'camera:me'])
  for (const viewer of people) {
    await expect(row(viewer, ayse)).toHaveAttribute('data-camera', 'true')
    await expect(row(viewer, ayse)).toHaveAttribute('data-screensharing', 'true')
    await expect(row(viewer, mehmet)).toHaveAttribute('data-camera', 'true')
    await expect(row(viewer, zeynep)).toHaveAttribute('data-camera', 'false')
  }
  await expectEveryoneHears(people)

  // Ayşe's camera off: the device is released, nothing of it is sent, its
  // tile goes for everyone, and her screen share carries on.
  await ayse.page.getByTestId('btn-camera').click()
  await expect(ayse.page.getByTestId('btn-camera')).toHaveAttribute('aria-pressed', 'false')
  await expect(ayse.page.getByTestId('local-camera')).toHaveCount(0)
  const released = await cameraTracks(ayse.page)
  expect(released.states.length).toBeGreaterThan(0)
  expect(released.states.every((state) => state === 'ended')).toBe(true)
  expect(released.sent).toBe(0)
  for (const viewer of [mehmet, zeynep]) {
    await expect(viewer.page.getByTestId(`remote-camera-${ayse.user.id}`)).toHaveCount(0)
    await expect(row(viewer, ayse)).toHaveAttribute('data-camera', 'false')
    await expectTileDecoding(viewer.page, 'remote-video', 'screen', 'Ayşe · ekran')
  }
  await expectTileDecoding(zeynep.page, `remote-camera-${mehmet.user.id}`, 'camera', 'Mehmet')
  expect(await stageTiles(zeynep.page)).toEqual([`screen:${ayse.user.id}`, `camera:${mehmet.user.id}`])

  // On again: a new stream, announced before its track, labelled a camera again.
  await ayse.page.getByTestId('btn-camera').click()
  for (const viewer of [mehmet, zeynep]) {
    await expectTileDecoding(viewer.page, `remote-camera-${ayse.user.id}`, 'camera', 'Ayşe')
    await expect(viewer.page.getByTestId('remote-video')).toHaveCount(1)
  }

  // The screen share stops; both cameras stay.
  await ayse.page.getByTestId('btn-screen').click()
  for (const viewer of [mehmet, zeynep]) {
    await expect(viewer.page.getByTestId('remote-video')).toHaveCount(0)
    await expectTileDecoding(viewer.page, `remote-camera-${ayse.user.id}`, 'camera', 'Ayşe')
  }
  await expectEveryoneHears(people)
})

test('camera: two people turning their cameras on at the same instant (glare); audio still flows on every pair', async ({ browser, trio }) => {
  test.setTimeout(180_000)
  const people = await threePeople(browser, trio)
  const [ayse, mehmet, zeynep] = people
  for (const person of people) await joinVoice(person)
  for (const person of people) await expect(person.page.locator('[data-testid^="voice-user-"]')).toHaveCount(3)
  await expectEveryoneHears(people)

  for (let round = 1; round <= 2; round++) {
    // On together: both offer on the Ayşe–Mehmet connection at once.
    await Promise.all([ayse.page.getByTestId('btn-camera').click(), mehmet.page.getByTestId('btn-camera').click()])
    await expectTileDecoding(ayse.page, `remote-camera-${mehmet.user.id}`, 'camera', 'Mehmet')
    await expectTileDecoding(mehmet.page, `remote-camera-${ayse.user.id}`, 'camera', 'Ayşe')
    await expectTileDecoding(zeynep.page, `remote-camera-${ayse.user.id}`, 'camera', 'Ayşe')
    await expectTileDecoding(zeynep.page, `remote-camera-${mehmet.user.id}`, 'camera', 'Mehmet')
    for (const viewer of people) await expect(viewer.page.getByTestId('remote-video')).toHaveCount(0)
    await expectEveryoneHears(people)

    // Off together.
    await Promise.all([ayse.page.getByTestId('btn-camera').click(), mehmet.page.getByTestId('btn-camera').click()])
    for (const viewer of people) await expect(viewer.page.locator('[data-testid^="remote-camera-"]')).toHaveCount(0)
    for (const viewer of people) await expect(viewer.page.getByTestId('stage')).toHaveCount(0)
    await expectEveryoneHears(people)
  }
})
