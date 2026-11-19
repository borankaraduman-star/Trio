/**
 * Screenshots of the message family (CONTRACT-V4 B), taken through the real
 * UI: `11-reactions-reply.png` (reactions, a reply quote, an edited mark),
 * `12-pins.png` (the Sabitlenenler panel) and `13-mobile-sheet.png` (the
 * long-press sheet at 390 px). Each also asserts what it shows.
 */
import path from 'node:path'
import { E2E_DIR, freshServer } from '../lib/server'
import { expect, personViaApi, test, type Person } from '../lib/trio'
import { barAction, chip, longPress, menuAction, pick, row, send } from '../lib/messages'

const OUT = path.join(E2E_DIR, 'screenshots')
const DESKTOP = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 }

test.beforeEach(async () => {
  await freshServer()
})

async function conversation(people: Person[]): Promise<void> {
  const [ayse, mehmet, zeynep] = people
  await send(ayse.page, 'Cumartesi kamp için yer buldum: Kazdağları, Ayazma tarafı 🏕️')
  await send(mehmet.page, 'Harika! Kaç kişilik çadır lazım?')
  await send(zeynep.page, 'Ben arabayı alabilirim, sabah 7 gibi çıkarız')
  await send(ayse.page, 'İki çadır yeter, benimki dört kişilik')

  // Mehmet edits his question.
  await barAction(row(mehmet.page, 'çadır lazım'), 'edit')
  await mehmet.page.getByTestId('message-editor-input').fill('Harika! Kaç çadır lazım, uyku tulumu da alalım mı?')
  await mehmet.page.getByTestId('message-editor-input').press('Enter')

  // Zeynep answers Ayşe's first message.
  await barAction(row(zeynep.page, 'yer buldum'), 'reply')
  await send(zeynep.page, 'Orayı çok seviyorum, şelaleye de yürürüz')

  // Reactions from everybody.
  await barAction(row(mehmet.page, 'yer buldum'), 'react')
  await pick(mehmet.page, '🔥')
  await chip(row(zeynep.page, 'yer buldum'), '🔥').click()
  await barAction(row(ayse.page, 'arabayı alabilirim'), 'react')
  await pick(ayse.page, '🙏')
  await barAction(row(mehmet.page, 'arabayı alabilirim'), 'react')
  await pick(mehmet.page, '👍')
  await barAction(row(zeynep.page, 'İki çadır'), 'react')
  await pick(zeynep.page, '👌')
  for (const person of people) {
    await expect(chip(row(person.page, 'yer buldum'), '🔥')).toContainText('2')
    await expect(chip(row(person.page, 'İki çadır'), '👌')).toContainText('1')
  }
}

test('screenshot 11: reactions, a reply and an edited message', async ({ browser, trio }) => {
  const ayse = trio.add(await personViaApi(browser, 'Ayşe', DESKTOP))
  const mehmet = trio.add(await personViaApi(browser, 'Mehmet', DESKTOP))
  const zeynep = trio.add(await personViaApi(browser, 'Zeynep', DESKTOP))
  await conversation([ayse, mehmet, zeynep])

  const page = ayse.page
  await expect(row(page, 'şelaleye').getByTestId('reply-quote')).toContainText('Ayşe')
  await expect(row(page, 'uyku tulumu').getByTestId('edited-mark')).toHaveCount(1)
  // Ayşe is about to answer Zeynep: the reply strip above the composer, the bar on a hovered row.
  await barAction(row(page, 'şelaleye'), 'reply')
  await page.getByTestId('composer').fill('Ben de termos getiririm ☕')
  await row(page, 'uyku tulumu').hover()
  await expect(row(page, 'uyku tulumu').getByTestId('msg-action-react')).toBeVisible()
  await page.screenshot({ path: path.join(OUT, '11-reactions-reply.png') })
})

test('screenshot 12: the pinned messages panel', async ({ browser, trio }) => {
  const ayse = trio.add(await personViaApi(browser, 'Ayşe', DESKTOP))
  const mehmet = trio.add(await personViaApi(browser, 'Mehmet', DESKTOP))
  const zeynep = trio.add(await personViaApi(browser, 'Zeynep', DESKTOP))
  await conversation([ayse, mehmet, zeynep])
  await menuAction(ayse.page, row(ayse.page, 'yer buldum'), 'pin')
  await menuAction(zeynep.page, row(zeynep.page, 'arabayı alabilirim'), 'pin')

  const page = mehmet.page
  await expect(row(page, 'yer buldum').getByTestId('pin-mark')).toHaveCount(1)
  await page.getByTestId('btn-pins').click()
  const items = page.getByTestId('pins-panel').getByTestId('pin-item')
  await expect(items).toHaveCount(2)
  await expect(items.first()).toContainText('arabayı alabilirim')
  await page.mouse.move(0, 0)
  await page.screenshot({ path: path.join(OUT, '12-pins.png') })
})

test('screenshot 13: the long-press sheet on a phone', async ({ browser, trio }) => {
  const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
  const ayse = trio.add(await personViaApi(browser, 'Ayşe', DESKTOP))
  const mehmet = trio.add(await personViaApi(browser, 'Mehmet', DESKTOP))
  const zeynep = trio.add(await personViaApi(browser, 'Zeynep', phone))
  await conversation([ayse, mehmet, zeynep])

  const page = zeynep.page
  const sheet = page.getByTestId('message-menu')
  await longPress(page, row(page, 'yer buldum'), sheet)
  await expect(sheet.getByTestId('menu-reactions')).toContainText('Mehmet ve Zeynep')
  await page.screenshot({ path: path.join(OUT, '13-mobile-sheet.png') })
})
