/**
 * The message family (CONTRACT-V4 B) and the voice work (V4 A1, A4, A2) on one
 * screen: reacting and editing while the server is down and the call is kept
 * ("ses sürüyor"), and at 390 px the ring band arriving over the action
 * sheet, a message notice and the Yenilikler card.
 */
import { freshServer, readState, startServer, stopServer } from '../lib/server'
import { barAction, chip, longPress, pick, row, send } from '../lib/messages'
import { bulkSend, expect, expectConnected, GENEL, expectHearing, joinVoice, personViaApi, test, type Person } from '../lib/trio'

const KEPT = 'Sunucuya yeniden bağlanılıyor… ses sürüyor'

test.beforeEach(async () => {
  await freshServer()
})

test('with the server down and the call kept, a reaction and an edit fail with their notice; both work after the resume', async ({ browser, trio }) => {
  test.setTimeout(120_000)
  const ayse = trio.add(await personViaApi(browser, 'Ayşe'))
  const mehmet = trio.add(await personViaApi(browser, 'Mehmet'))
  await send(ayse.page, 'bu akşam maç var')
  await send(ayse.page, 'saat dokuzda')
  for (const person of [ayse, mehmet]) await joinVoice(person)
  await expectHearing(mehmet, ayse)

  const state = readState()
  await stopServer('SIGKILL')
  await expect(ayse.page.getByTestId('connection-banner')).toHaveText(KEPT)

  // A reaction: refused quietly, with the family's notice; the call and the banner stay.
  const target = row(ayse.page, 'bu akşam maç var')
  await barAction(target, 'react')
  await pick(ayse.page, '🔥')
  const notice = ayse.page.getByTestId('message-notice')
  await expect(notice).toBeVisible()
  await expect(chip(target, '🔥')).toHaveCount(0)
  await expect(ayse.page.getByTestId('connection-banner')).toHaveText(KEPT)
  await expect(ayse.page.locator('.voice-status strong')).toHaveText('Ses bağlı')
  await expectHearing(mehmet, ayse)

  // An edit in place: shown at once, rolled back when the server cannot take it.
  const edited = row(ayse.page, 'saat dokuzda')
  await barAction(edited, 'edit')
  const editor = ayse.page.getByTestId('message-editor-input')
  await editor.fill('saat onda')
  await editor.press('Enter')
  await expect(row(ayse.page, 'saat dokuzda')).toHaveCount(1)
  await expect(row(ayse.page, 'saat onda')).toHaveCount(0)
  await expect(notice).toBeVisible()
  await expect(ayse.page.locator('.voice-status strong')).toHaveText('Ses bağlı')

  await startServer({ port: state.port, dataDir: state.dataDir })
  for (const person of [ayse, mehmet]) await expectConnected(person.page)
  await expect(ayse.page.locator('.voice-status strong')).toHaveText('Ses bağlı')

  // The same actions now land, for both.
  await barAction(target, 'react')
  await pick(ayse.page, '🔥')
  await expect(chip(row(mehmet.page, 'bu akşam maç var'), '🔥')).toContainText('1')
  await barAction(row(ayse.page, 'saat dokuzda'), 'edit')
  await editor.fill('saat onda')
  await editor.press('Enter')
  await expect(row(mehmet.page, 'saat onda')).toHaveCount(1)
  await expectHearing(mehmet, ayse)
})

/** Is the centre of `testId` the topmost thing there (nothing drawn over it)? */
async function onTop(person: Person, testId: string): Promise<boolean> {
  return person.page.getByTestId(testId).evaluate((element) => {
    const box = element.getBoundingClientRect()
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
    return hit !== null && (hit === element || element.contains(hit))
  })
}

test('390 px: the Yenilikler card leaves room, and steps aside for a ring arriving over the action sheet and a message notice', async ({ browser, trio }) => {
  test.setTimeout(120_000)
  const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
  const ayse = trio.add(await personViaApi(browser, 'Ayşe'))
  const zeynep = trio.add(
    await personViaApi(browser, 'Zeynep', {
      ...phone,
      // A device that last saw 0.2.0: the Yenilikler card comes up.
      prepare: async (context) => {
        await context.addInitScript(() => {
          if (!sessionStorage.getItem('trio.e2e.seen')) {
            sessionStorage.setItem('trio.e2e.seen', '1')
            localStorage.setItem('trio.seenVersion', '0.2.0')
          }
        })
      },
    }),
  )
  // A channel with a history: the newest message sits just above the composer.
  await bulkSend(ayse, GENEL, 20, 'eski mesaj')
  await send(ayse.page, 'kim geliyor?')
  const card = zeynep.page.getByTestId('whats-new')
  await expect(card).toBeVisible()
  // At most the top half: the newest message and the composer stay usable.
  const cardBox = (await card.boundingBox())!
  expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(844 / 2 + 60)
  await expect.poll(() => onTop(zeynep, 'composer')).toBe(true)

  // A reaction the server refuses: the family's notice, clear of the card.
  await zeynep.page.route('**/api/messages/*/reactions/**', (route) => route.fulfill({ status: 503, body: '{}' }))
  const target = row(zeynep.page, 'kim geliyor?')
  const sheet = zeynep.page.getByTestId('message-menu')
  // The newest row sits where the sheet comes up: lifting the finger must not pick
  // the item under it (it used to land on "Yanıtla" and close the sheet).
  await longPress(zeynep.page, target, sheet)
  await expect(sheet).toBeVisible()
  await expect(zeynep.page.getByTestId('reply-bar')).toHaveCount(0)
  await sheet.getByRole('button', { name: '👍 tepkisi' }).tap()
  const notice = zeynep.page.getByTestId('message-notice')
  await expect(notice).toBeVisible()
  const apart = (a: { y: number; height: number }, b: { y: number; height: number }) => a.y + a.height <= b.y || b.y + b.height <= a.y
  expect(apart((await notice.boundingBox())!, (await card.boundingBox())!), 'the notice and the card do not overlap').toBe(true)

  // The sheet open again when the ring comes.
  await longPress(zeynep.page, target, sheet)
  await ayse.page.getByTestId('channel-2').click()
  await expect(ayse.page.locator('.voice-status strong')).toHaveText('Ses bağlı')
  await ayse.page.getByTestId('btn-ring').click()
  const band = zeynep.page.getByTestId('ring-band')
  await expect(band).toBeVisible()
  // The card steps aside while the band is up.
  await expect(card).toHaveCount(0)
  await zeynep.page.screenshot({ path: 'screenshots/16-ring-over-sheet-390.png' })

  // The sheet is modal; once it is closed nothing covers the band's buttons, and
  // the band and the notice are side by side, within the screen.
  await zeynep.page.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
  for (const id of ['ring-join', 'ring-dismiss']) {
    await expect.poll(() => onTop(zeynep, id), { message: `${id} is not covered` }).toBe(true)
  }
  const bandBox = (await band.boundingBox())!
  const noticeBox = (await notice.boundingBox())!
  for (const box of [bandBox, noticeBox]) {
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.x + box.width).toBeLessThanOrEqual(390)
  }
  expect(apart(bandBox, noticeBox), 'the ring band and the notice do not overlap').toBe(true)
  await zeynep.page.screenshot({ path: 'screenshots/16b-ring-band-notice-390.png' })

  // Joining: the band goes, the card comes back as it was.
  await band.getByTestId('ring-join').tap()
  await expect(zeynep.page.locator('.voice-status strong')).toHaveText('Ses bağlı')
  await expect(card).toBeVisible()
  await expect.poll(() => onTop(zeynep, 'whats-new-dismiss')).toBe(true)
})
