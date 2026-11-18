import { expectTileDecoding, stageTiles } from '../lib/media'
import { freshServer, readState, restartServer, startServer, stopServer } from '../lib/server'
import { expect, expectConnected, expectHearing, joinVoice, test, threePeople, type Person } from '../lib/trio'

test.beforeEach(async () => {
  await freshServer()
})

const row = (viewer: Person, subject: Person) => viewer.page.getByTestId(`voice-user-${subject.user.id}`)

async function expectEveryoneHears(people: Person[]): Promise<void> {
  for (const listener of people) for (const speaker of people) {
    if (listener !== speaker) await expectHearing(listener, speaker)
  }
}

/**
 * The intended behaviour, which this test holds the client to: cameras and a
 * shared screen survive a lost server. The streams stay open in each tab
 * while the socket is down (the local previews never go), the rejoin
 * announces them (`voice.join` carries `camera`, the screen flag follows the
 * join), and the new connections carry them again with their `meta`. A
 * camera turned off while the server was away stays off.
 */
test('resilience: the server dies while two cameras and a screen share are on; everything comes back as it was left', async ({ browser, trio }) => {
  test.setTimeout(240_000)
  const people = await threePeople(browser, trio)
  const [ayse, mehmet, zeynep] = people
  for (const person of people) await joinVoice(person)
  await ayse.page.getByTestId('btn-camera').click()
  await ayse.page.getByTestId('btn-screen').click()
  await mehmet.page.getByTestId('btn-camera').click()
  await expectTileDecoding(zeynep.page, `remote-camera-${ayse.user.id}`, 'camera', 'Ayşe')
  await expectTileDecoding(zeynep.page, `remote-camera-${mehmet.user.id}`, 'camera', 'Mehmet')
  await expectTileDecoding(zeynep.page, 'remote-video', 'screen', 'Ayşe · ekran')

  // Crash. The remote tiles go with the connections; the own previews stay.
  const state = readState()
  await stopServer('SIGKILL')
  for (const person of people) {
    await expect(person.page.locator('.banner')).toHaveText('Bağlantı koptu, yeniden bağlanılıyor…')
    await expect(person.page.locator('[data-testid^="remote-"]')).toHaveCount(0)
  }
  await expect(ayse.page.getByTestId('local-camera')).toBeVisible()
  await expect(ayse.page.getByTestId('local-video')).toBeVisible()
  await expect(ayse.page.getByTestId('btn-camera')).toHaveAttribute('aria-pressed', 'true')
  await expect(ayse.page.getByTestId('btn-screen')).toHaveAttribute('aria-pressed', 'true')

  await startServer({ port: state.port, dataDir: state.dataDir })
  for (const person of people) await expectConnected(person.page)

  // Back as they were: the same tiles, decoding, and the same flags for everyone.
  await expectTileDecoding(zeynep.page, `remote-camera-${ayse.user.id}`, 'camera', 'Ayşe')
  await expectTileDecoding(zeynep.page, `remote-camera-${mehmet.user.id}`, 'camera', 'Mehmet')
  await expectTileDecoding(zeynep.page, 'remote-video', 'screen', 'Ayşe · ekran')
  await expectTileDecoding(mehmet.page, `remote-camera-${ayse.user.id}`, 'camera', 'Ayşe')
  await expectTileDecoding(mehmet.page, 'remote-video', 'screen', 'Ayşe · ekran')
  await expectTileDecoding(ayse.page, `remote-camera-${mehmet.user.id}`, 'camera', 'Mehmet')
  expect(await stageTiles(zeynep.page)).toEqual([`screen:${ayse.user.id}`, `camera:${ayse.user.id}`, `camera:${mehmet.user.id}`])
  for (const viewer of people) {
    await expect(viewer.page.locator('[data-testid^="voice-user-"]')).toHaveCount(3)
    await expect(row(viewer, ayse)).toHaveAttribute('data-camera', 'true')
    await expect(row(viewer, ayse)).toHaveAttribute('data-screensharing', 'true')
    await expect(row(viewer, mehmet)).toHaveAttribute('data-camera', 'true')
    await expect(row(viewer, zeynep)).toHaveAttribute('data-camera', 'false')
  }
  await expectEveryoneHears(people)

  // A second crash; this time Mehmet turns his camera off while the server is away.
  await stopServer('SIGKILL')
  await expect(mehmet.page.locator('.banner')).toHaveText('Bağlantı koptu, yeniden bağlanılıyor…')
  await mehmet.page.getByTestId('btn-camera').click()
  await expect(mehmet.page.getByTestId('btn-camera')).toHaveAttribute('aria-pressed', 'false')
  await expect(mehmet.page.getByTestId('local-camera')).toHaveCount(0)
  await startServer({ port: state.port, dataDir: state.dataDir })
  for (const person of people) await expectConnected(person.page)

  await expectTileDecoding(zeynep.page, `remote-camera-${ayse.user.id}`, 'camera', 'Ayşe')
  await expectTileDecoding(zeynep.page, 'remote-video', 'screen', 'Ayşe · ekran')
  await expectTileDecoding(mehmet.page, `remote-camera-${ayse.user.id}`, 'camera', 'Ayşe')
  for (const viewer of people) {
    await expect(row(viewer, mehmet)).toHaveAttribute('data-camera', 'false')
    await expect(row(viewer, ayse)).toHaveAttribute('data-camera', 'true')
  }
  for (const viewer of [ayse, zeynep]) await expect(viewer.page.getByTestId(`remote-camera-${mehmet.user.id}`)).toHaveCount(0)
  await expectEveryoneHears(people)

  // And through restartServer while she stops sharing right after: the stage follows.
  await restartServer('SIGKILL')
  for (const person of people) await expectConnected(person.page)
  await expectTileDecoding(mehmet.page, 'remote-video', 'screen', 'Ayşe · ekran')
  await ayse.page.getByTestId('btn-screen').click()
  for (const viewer of [mehmet, zeynep]) {
    await expect(viewer.page.getByTestId('remote-video')).toHaveCount(0)
    await expect(row(viewer, ayse)).toHaveAttribute('data-screensharing', 'false')
    await expectTileDecoding(viewer.page, `remote-camera-${ayse.user.id}`, 'camera', 'Ayşe')
  }
  await expectEveryoneHears(people)
})
