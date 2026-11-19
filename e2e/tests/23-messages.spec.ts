/**
 * CONTRACT-V4 B, the message family, as the three people see it: edit,
 * delete (and the quota coming back), reactions, replies, pins, a reconnect
 * in the middle of it, and the phone's long-press sheet.
 */
import { freshServer } from '../lib/server'
import { bulkSend, expect, GENEL, personViaApi, test, threePeople, type Person } from '../lib/trio'
import {
  allMessages,
  barAction,
  chip,
  exactRow,
  idOf,
  longPress,
  menuAction,
  personBehindSwitch,
  pick,
  rest,
  restOk,
  row,
  rows,
  scrollUpTo,
  send,
  Switch,
} from '../lib/messages'

test.beforeEach(async () => {
  await freshServer()
})

async function rowTop(person: Person, text: string): Promise<number> {
  return exactRow(person.page, text).evaluate((element) => {
    const list = element.closest('[data-testid="message-list"]')!
    return element.getBoundingClientRect().top - list.getBoundingClientRect().top
  })
}

test('edit: in place, everybody sees it and the mark; only the author can edit or delete', async ({ browser, trio }) => {
  const [ayse, mehmet, zeynep] = await threePeople(browser, trio)
  await send(ayse.page, 'yarın saat 8de buluşalım')
  await send(mehmet.page, 'tamam')

  // Mehmet's bar and menu on Ayşe's message: no Düzenle, no Sil.
  const onMehmet = row(mehmet.page, 'yarın saat')
  await onMehmet.hover()
  await expect(onMehmet.getByTestId('msg-action-reply')).toBeVisible()
  await expect(onMehmet.getByTestId('msg-action-edit')).toHaveCount(0)
  await onMehmet.getByTestId('msg-action-menu').click()
  const menu = mehmet.page.getByTestId('message-menu')
  await expect(menu.getByTestId('msg-menu-pin')).toBeVisible()
  await expect(menu.getByTestId('msg-menu-edit')).toHaveCount(0)
  await expect(menu.getByTestId('msg-menu-delete')).toHaveCount(0)
  await mehmet.page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  // And on his own: both.
  await menuActionVisible(mehmet, 'tamam')

  // Esc cancels an edit without changing anything.
  const mine = row(ayse.page, 'yarın saat')
  await barAction(mine, 'edit')
  const editor = ayse.page.getByTestId('message-editor-input')
  await editor.fill('yanlışlıkla')
  await editor.press('Escape')
  await expect(ayse.page.getByTestId('message-editor')).toHaveCount(0)
  await expect(mine).toContainText('yarın saat 8de buluşalım')
  await expect(ayse.page.getByTestId('composer')).toBeFocused()

  // Enter saves; Shift+Enter is a newline.
  await barAction(mine, 'edit')
  await editor.fill('yarın saat 9da buluşalım')
  await editor.press('Shift+Enter')
  await editor.pressSequentially('kapıda')
  await editor.press('Enter')
  for (const person of [ayse, mehmet, zeynep]) {
    const target = row(person.page, 'yarın saat 9da')
    await expect(target.locator('.message-content')).toHaveText('yarın saat 9da buluşalım\nkapıda(düzenlendi)')
    await expect(target.getByTestId('edited-mark')).toHaveAttribute('title', /^Düzenlendi: /)
  }

  // An edit that empties a message with no file is refused in the editor.
  await barAction(row(ayse.page, 'yarın saat 9da'), 'edit')
  await editor.fill('   ')
  await expect(ayse.page.getByTestId('message-editor').getByRole('alert')).toContainText('boş olamaz')
  await editor.press('Enter')
  await expect(ayse.page.getByTestId('message-editor')).toHaveCount(1)
  await editor.press('Escape')

  // Up-arrow in an empty composer edits my last message in the channel.
  await send(ayse.page, 'son mesajım')
  await ayse.page.getByTestId('composer').press('ArrowUp')
  await expect(editor).toHaveValue('son mesajım')
  await editor.fill('son mesajım (değişti)')
  await editor.press('Enter')
  await expect(row(zeynep.page, 'son mesajım (değişti)')).toHaveCount(1)
  // …but not when the composer holds text.
  await ayse.page.getByTestId('composer').fill('taslak')
  await ayse.page.getByTestId('composer').press('ArrowUp')
  await expect(ayse.page.getByTestId('message-editor')).toHaveCount(0)
  await ayse.page.getByTestId('composer').fill('')

  // Keyboard: a focused row opens its menu with Shift+F10; Esc gives the focus back.
  const focused = row(zeynep.page, 'tamam')
  await focused.focus()
  await zeynep.page.keyboard.press('Shift+F10')
  await expect(zeynep.page.getByTestId('message-menu')).toBeVisible()
  await expect(zeynep.page.getByTestId('message-menu').getByTestId('quick-reaction').first()).toBeFocused()
  await zeynep.page.keyboard.press('Escape')
  await expect(zeynep.page.getByTestId('message-menu')).toHaveCount(0)
  await expect(focused).toBeFocused()
  await zeynep.page.keyboard.press('ArrowUp')
  await expect(row(zeynep.page, 'yarın saat 9da')).toBeFocused()

  // The REST refusal for somebody else's message (the UI never offers it).
  const id = await idOf(row(mehmet.page, 'yarın saat 9da'))
  expect((await rest(mehmet.token, `/api/messages/${id}`, 'PATCH', { content: 'x' })).status).toBe(403)
  expect((await rest(mehmet.token, `/api/messages/${id}`, 'DELETE')).status).toBe(403)
})

async function menuActionVisible(person: Person, text: string): Promise<void> {
  const target = row(person.page, text)
  await barAction(target, 'menu')
  const menu = person.page.getByTestId('message-menu')
  await expect(menu.getByTestId('msg-menu-edit')).toBeVisible()
  await expect(menu.getByTestId('msg-menu-delete')).toBeVisible()
  await person.page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
}

test('delete: gone for everybody, its file 404s and the quota comes back', async ({ browser, trio }) => {
  await freshServer({ TRIO_USER_QUOTA_MB: '1' })
  const [ayse, mehmet, zeynep] = await threePeople(browser, trio)
  const file = (name: string) => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.alloc(700_000, 7) })

  await ayse.page.getByTestId('file-input').setInputFiles(file('arsiv.bin'))
  await expect(ayse.page.locator('[data-testid="pending-attachment"][data-status="done"]')).toHaveCount(1)
  await send(ayse.page, 'eski arşiv burada')
  await expect(row(zeynep.page, 'eski arşiv burada')).toHaveCount(1)
  const url = await row(zeynep.page, 'eski arşiv burada').locator('a[href^="/api/files/"]').first().getAttribute('href')
  expect(url).toBeTruthy()
  expect((await rest(zeynep.token, url!, 'GET')).status).toBe(200)

  // A second file does not fit in her 1 MB.
  await ayse.page.getByTestId('file-input').setInputFiles(file('yeni.bin'))
  await expect(ayse.page.getByTestId('pending-attachment')).toContainText('Yükleme kotan doldu')
  await ayse.page.getByTestId('pending-remove').click()

  await menuAction(ayse.page, row(ayse.page, 'eski arşiv burada'), 'delete')
  const dialog = ayse.page.getByTestId('delete-confirm')
  await expect(dialog).toContainText('Ekli dosya da sunucudan silinir')
  await expect(dialog.getByTestId('delete-confirm-no')).toBeFocused()
  await dialog.getByTestId('delete-confirm-yes').click()
  for (const person of [ayse, mehmet, zeynep]) await expect(row(person.page, 'eski arşiv burada')).toHaveCount(0)
  expect((await rest(zeynep.token, url!, 'GET')).status).toBe(404)

  // Now it fits.
  await ayse.page.getByTestId('file-input').setInputFiles(file('yeni.bin'))
  await expect(ayse.page.locator('[data-testid="pending-attachment"][data-status="done"]')).toHaveCount(1)

  // After a reload it is still gone.
  await mehmet.page.reload()
  await expect(rows(mehmet.page)).toHaveCount(0)
})

test('reactions: two people aggregate, toggle, names in the tooltip; only that row re-renders', async ({ browser, trio }) => {
  const [ayse, mehmet, zeynep] = await threePeople(browser, trio)
  await send(ayse.page, 'pizza mı söyleyelim')
  await send(ayse.page, 'yoksa döner mi')

  // Mehmet from the picker, searched in Turkish.
  await barAction(row(mehmet.page, 'pizza'), 'react')
  await mehmet.page.getByTestId('emoji-search').fill('beğen')
  await pick(mehmet.page, '👍')
  for (const person of [ayse, mehmet, zeynep]) await expect(chip(row(person.page, 'pizza'), '👍')).toContainText('1')

  // Zeynep by clicking the chip; only her row re-renders on Ayşe's page.
  await ayse.page.evaluate(() => ((window as unknown as { __trioRowRenders: object }).__trioRowRenders = {}))
  await chip(row(zeynep.page, 'pizza'), '👍').click()
  for (const person of [ayse, mehmet, zeynep]) await expect(chip(row(person.page, 'pizza'), '👍')).toContainText('2')
  const key = await row(ayse.page, 'pizza').getAttribute('data-key')
  const renders = await ayse.page.evaluate(() => (window as unknown as { __trioRowRenders: Record<string, number> }).__trioRowRenders)
  expect(Object.keys(renders)).toEqual([key])

  await expect(chip(row(zeynep.page, 'pizza'), '👍')).toHaveAttribute('aria-pressed', 'true')
  await expect(chip(row(ayse.page, 'pizza'), '👍')).toHaveAttribute('aria-pressed', 'false')
  await expect(chip(row(ayse.page, 'pizza'), '👍')).toHaveAttribute('title', 'Mehmet ve Zeynep: 👍')

  // A heart from the menu's quick row, and Ayşe's from the picker: one key (both send ❤️ with VS16).
  await barAction(row(zeynep.page, 'pizza'), 'menu')
  await zeynep.page.getByTestId('message-menu').getByRole('button', { name: '❤️ tepkisi' }).click()
  for (const person of [ayse, mehmet, zeynep]) await expect(chip(row(person.page, 'pizza'), '❤️')).toContainText('1')
  const id = await idOf(row(ayse.page, 'pizza'))
  await barAction(row(ayse.page, 'pizza'), 'react')
  await ayse.page.getByTestId('emoji-search').fill('kalp kırmızı')
  await pick(ayse.page, '❤️')
  for (const person of [ayse, mehmet, zeynep]) await expect(chip(row(person.page, 'pizza'), '❤️')).toContainText('2')
  const page = (await (await rest(ayse.token, `/api/channels/${GENEL}/messages`, 'GET')).json()) as {
    messages: { id: number; reactions: { key: string; count: number; user_ids: number[] }[] }[]
  }
  expect(page.messages.find((message) => message.id === id)?.reactions).toEqual([
    { key: '👍', count: 2, user_ids: [mehmet.user.id, zeynep.user.id] },
    { key: '❤️', count: 2, user_ids: [zeynep.user.id, ayse.user.id] },
  ])

  // Toggling off.
  await chip(row(mehmet.page, 'pizza'), '👍').click()
  for (const person of [ayse, mehmet, zeynep]) await expect(chip(row(person.page, 'pizza'), '👍')).toContainText('1')
  await chip(row(zeynep.page, 'pizza'), '👍').click()
  for (const person of [ayse, mehmet, zeynep]) await expect(chip(row(person.page, 'pizza'), '👍')).toHaveCount(0)

  // The most recent first in the picker.
  await barAction(row(mehmet.page, 'döner'), 'react')
  await expect(mehmet.page.getByTestId('emoji-picker').locator('section').first()).toHaveAttribute('aria-label', 'Son kullanılanlar')
  await expect(mehmet.page.getByTestId('emoji-picker').locator('section').first().locator('[data-emoji]').first()).toHaveAttribute('data-emoji', '👍')
  await mehmet.page.keyboard.press('Escape')
  await expect(mehmet.page.getByTestId('emoji-picker')).toHaveCount(0)
})

test('reactions: the limit is a quiet notice; a reaction far up does not move another reader', async ({ browser, trio }) => {
  const [ayse, mehmet, zeynep] = await threePeople(browser, trio)
  await bulkSend(mehmet, GENEL, 120, 'geçmiş')
  const all = await allMessages(ayse.token, GENEL)

  // 20 distinct keys by REST, then the 21st from the UI.
  const target = all.find((message) => message.content === 'geçmiş 120')!
  const keys = ['😀', '😄', '😂', '🤣', '😊', '🙂', '😉', '😍', '🥰', '😘', '😎', '🤔', '🙄', '😏', '😐', '😅', '😬', '😮', '😱', '😢']
  for (const key of keys) await restOk(mehmet.token, `/api/messages/${target.id}/reactions/${encodeURIComponent(key)}`, 'PUT')
  await expect(exactRow(ayse.page, 'geçmiş 120').getByTestId('reaction-chip')).toHaveCount(20)
  await barAction(exactRow(ayse.page, 'geçmiş 120'), 'react')
  await pick(ayse.page, '👍')
  await expect(ayse.page.getByTestId('message-notice')).toContainText('en fazla 20 farklı tepki')
  // An existing key may still gain people.
  await chip(exactRow(ayse.page, 'geçmiş 120'), '😀').click()
  await expect(chip(exactRow(zeynep.page, 'geçmiş 120'), '😀')).toContainText('2')

  // Zeynep reads far up in the history.
  await scrollUpTo(zeynep.page, exactRow(zeynep.page, 'geçmiş 20'))
  const reading = exactRow(zeynep.page, 'geçmiş 30')
  await expect(zeynep.page.locator('.list-note', { hasText: 'Eski mesajlar yükleniyor' })).toHaveCount(0)
  await reading.evaluate(async (element) => {
    const list = element.closest<HTMLElement>('[data-testid="message-list"]')!
    const heard = new Promise((resolve) => list.addEventListener('scroll', resolve, { once: true }))
    const from = list.scrollTop
    list.scrollTop += element.getBoundingClientRect().top - list.getBoundingClientRect().top - 40
    // As a person's scroll: the list hears the scroll event (and records what is being read) first.
    if (list.scrollTop !== from) await heard
  })
  const before = await rowTop(zeynep, 'geçmiş 30')
  // Above her view, in her view, and at the bottom.
  for (const text of ['geçmiş 25', 'geçmiş 31', 'geçmiş 119']) {
    const message = all.find((item) => item.content === text)!
    for (const key of ['🎉', '🔥', '❤️'])
      await restOk(ayse.token, `/api/messages/${message.id}/reactions/${encodeURIComponent(key)}`, 'PUT')
    await expect(chip(exactRow(zeynep.page, text), '🔥')).toHaveCount(1)
  }
  expect(await rowTop(zeynep, 'geçmiş 30')).toBe(before)
})

test('reply: the quote for everybody, a jump to an older page, edits and deletion of the target', async ({ browser, trio }) => {
  const [ayse, mehmet, zeynep] = await threePeople(browser, trio)
  await send(mehmet.page, 'hedef: kamp yeri Kaz Dağları')
  await bulkSend(mehmet, GENEL, 130, 'ara')

  // Ayşe finds it up in the history and replies; Esc lets a reply go first.
  await scrollUpTo(ayse.page, row(ayse.page, 'hedef: kamp'))
  await barAction(row(ayse.page, 'hedef: kamp'), 'reply')
  await expect(ayse.page.getByTestId('reply-bar')).toContainText('Mehmet')
  await expect(ayse.page.getByTestId('composer')).toBeFocused()
  await ayse.page.getByTestId('composer').press('Escape')
  await expect(ayse.page.getByTestId('reply-bar')).toHaveCount(0)
  await barAction(row(ayse.page, 'hedef: kamp'), 'reply')
  await send(ayse.page, 'bence çok iyi fikir')

  for (const person of [ayse, mehmet, zeynep]) {
    const quote = row(person.page, 'bence çok iyi').getByTestId('reply-quote')
    await expect(quote).toContainText('Mehmet')
    await expect(quote).toContainText('hedef: kamp yeri Kaz Dağları')
  }

  // Zeynep has only the newest page: the jump loads older ones and lands on it.
  const targetId = (await allMessages(mehmet.token, GENEL)).find((message) => message.content.startsWith('hedef: kamp'))!.id
  const onMehmet = mehmet.page.locator(`li[data-message-id="${targetId}"]`)
  const target = zeynep.page.locator(`li[data-message-id="${targetId}"]`)
  await zeynep.page.reload()
  await expect(row(zeynep.page, 'bence çok iyi')).toHaveCount(1)
  await expect(target).toHaveCount(0)
  await row(zeynep.page, 'bence çok iyi').getByTestId('reply-quote').click()
  await expect(target).toBeInViewport()
  await expect(target).toHaveClass(/msg-flash/)

  // The target is edited: the shown quotes follow.
  await barAction(onMehmet, 'edit')
  await mehmet.page.getByTestId('message-editor-input').fill('hedef: kamp yeri Ida')
  await mehmet.page.getByTestId('message-editor-input').press('Enter')
  for (const person of [ayse, mehmet, zeynep])
    await expect(row(person.page, 'bence çok iyi').getByTestId('reply-quote')).toContainText('hedef: kamp yeri Ida')

  // …and deleted: "silinmiş mesaj" for all three, and after a reload too.
  await menuAction(mehmet.page, onMehmet, 'delete')
  await mehmet.page.getByTestId('delete-confirm-yes').click()
  for (const person of [ayse, mehmet, zeynep]) {
    await expect(row(person.page, 'bence çok iyi').getByTestId('reply-quote')).toHaveText('silinmiş mesaj')
    await expect(person.page.locator(`li[data-message-id="${targetId}"]`)).toHaveCount(0)
  }
  await ayse.page.reload()
  await expect(row(ayse.page, 'bence çok iyi').getByTestId('reply-quote')).toHaveText('silinmiş mesaj')
})

test('pins: the panel for all three, newest first, jump and unpin; the limit is a notice', async ({ browser, trio }) => {
  const [ayse, mehmet, zeynep] = await threePeople(browser, trio)
  await send(ayse.page, 'adres: Moda sahili')
  await bulkSend(ayse, GENEL, 70, 'sohbet')
  await send(mehmet.page, 'saat: 19.00')

  await menuAction(ayse.page, row(ayse.page, 'saat: 19.00'), 'pin')
  await expect(row(zeynep.page, 'saat: 19.00').getByTestId('pin-mark')).toHaveCount(1)
  await scrollUpTo(mehmet.page, row(mehmet.page, 'adres: Moda'))
  await menuAction(mehmet.page, row(mehmet.page, 'adres: Moda'), 'pin')
  await expect(row(mehmet.page, 'adres: Moda').getByTestId('pin-mark')).toHaveAttribute('title', 'Sabitlendi (Mehmet)')

  for (const person of [ayse, mehmet, zeynep]) {
    await person.page.getByTestId('btn-pins').click()
    const items = person.page.getByTestId('pins-panel').getByTestId('pin-item')
    await expect(items).toHaveCount(2)
    await expect(items.nth(0)).toContainText('adres: Moda sahili')
    await expect(items.nth(1)).toContainText('saat: 19.00')
  }
  // Zeynep jumps to the older one (not loaded on her page after a reload) from the panel.
  await zeynep.page.reload()
  await expect(row(zeynep.page, 'saat: 19.00')).toHaveCount(1)
  await expect(row(zeynep.page, 'adres: Moda')).toHaveCount(0)
  await zeynep.page.getByTestId('btn-pins').click()
  await expect(zeynep.page.getByTestId('pins-panel').getByTestId('pin-item')).toHaveCount(2)
  await zeynep.page.getByTestId('pins-panel').getByTestId('pin-jump').first().click()
  await expect(zeynep.page.getByTestId('pins-panel')).toHaveCount(0)
  await expect(row(zeynep.page, 'adres: Moda')).toBeInViewport()

  // Ayşe unpins from her panel; the others' open panels follow.
  await ayse.page.getByTestId('pins-panel').getByTestId('pin-unpin').last().click()
  await expect(mehmet.page.getByTestId('pins-panel').getByTestId('pin-item')).toHaveCount(1)
  await expect(row(zeynep.page, 'saat: 19.00').getByTestId('pin-mark')).toHaveCount(0)
  await ayse.page.keyboard.press('Escape')
  await expect(ayse.page.getByTestId('pins-panel')).toHaveCount(0)
  await mehmet.page.keyboard.press('Escape')

  // 50 pins (spread over three people: 30 pin changes a minute each), then one more from the UI.
  const all = await allMessages(ayse.token, GENEL)
  const free = all.filter((message) => message.content.startsWith('sohbet'))
  const pinners = [ayse, mehmet, zeynep]
  for (let index = 0; index < 49; index += 1) {
    await restOk(pinners[index % 3].token, `/api/messages/${free[index].id}/pin`, 'PUT')
  }
  await menuAction(ayse.page, row(ayse.page, 'saat: 19.00'), 'pin')
  await expect(ayse.page.getByTestId('message-notice')).toContainText('en fazla 50 sabitlenmiş')
  await expect(row(ayse.page, 'saat: 19.00').getByTestId('pin-mark')).toHaveCount(0)
})

test('a reconnect in the middle: edits, reactions, pins and deletions made meanwhile converge', async ({ browser, trio }) => {
  const ayse = trio.add(await personViaApi(browser, 'Ayşe'))
  const mehmet = trio.add(await personViaApi(browser, 'Mehmet'))
  const sw = new Switch()
  const zeynep = trio.add(await personBehindSwitch(browser, 'Zeynep', sw))
  await bulkSend(ayse, GENEL, 90, 'not')
  // Zeynep has loaded all of it (older pages too).
  await scrollUpTo(zeynep.page, exactRow(zeynep.page, 'not 3'))
  await expect(rows(zeynep.page)).toHaveCount(90)

  sw.online = false
  await sw.cut()
  await expect(zeynep.page.locator('.banner')).toBeVisible()

  const all = await allMessages(ayse.token, GENEL)
  const find = (text: string) => all.find((message) => message.content === text)!.id
  await restOk(ayse.token, `/api/messages/${find('not 3')}`, 'PATCH', { content: 'not 3 düzeltildi' })
  await restOk(ayse.token, `/api/messages/${find('not 5')}`, 'DELETE')
  await restOk(mehmet.token, `/api/messages/${find('not 7')}/reactions/${encodeURIComponent('🔥')}`, 'PUT')
  await restOk(mehmet.token, `/api/messages/${find('not 9')}/pin`, 'PUT')
  await restOk(ayse.token, `/api/messages/${find('not 89')}`, 'DELETE')
  await send(mehmet.page, 'kopukken yazıldı')

  sw.online = true
  await expect(zeynep.page.locator('.banner')).toHaveCount(0, { timeout: 20_000 })
  await expect(row(zeynep.page, 'kopukken yazıldı')).toHaveCount(1)
  await expect(row(zeynep.page, 'not 3 düzeltildi').getByTestId('edited-mark')).toHaveCount(1)
  await expect(exactRow(zeynep.page, 'not 5')).toHaveCount(0)
  await expect(exactRow(zeynep.page, 'not 89')).toHaveCount(0)
  await expect(chip(exactRow(zeynep.page, 'not 7'), '🔥')).toContainText('1')
  await expect(exactRow(zeynep.page, 'not 9').getByTestId('pin-mark')).toHaveCount(1)
  await expect(rows(zeynep.page)).toHaveCount(89)

  // And live again: a change from her reaches the others.
  await chip(exactRow(zeynep.page, 'not 7'), '🔥').click()
  await expect(chip(exactRow(ayse.page, 'not 7'), '🔥')).toContainText('2')
})

test('phone width: long-press opens the sheet; react, reply and the picker fit the screen', async ({ browser, trio }) => {
  const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
  const ayse = trio.add(await personViaApi(browser, 'Ayşe'))
  const mehmet = trio.add(await personViaApi(browser, 'Mehmet', phone))
  await send(ayse.page, 'akşam sinemaya gidiyor muyuz?')

  const target = row(mehmet.page, 'sinemaya')
  // No hover bar on a touch screen.
  await expect(target.getByTestId('msg-action-react')).toBeHidden()
  const sheet = mehmet.page.getByTestId('message-menu')
  await longPress(mehmet.page, target, sheet)
  await expect(sheet).toHaveClass(/sheet/)
  const box = (await sheet.boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(390)
  // Nothing selected by the press.
  expect(await mehmet.page.evaluate(() => String(window.getSelection() ?? ''))).toBe('')
  await sheet.getByRole('button', { name: '👍 tepkisi' }).tap()
  await expect(sheet).toHaveCount(0)
  await expect(chip(row(ayse.page, 'sinemaya'), '👍')).toContainText('1')

  // The sheet lists who reacted.
  await longPress(mehmet.page, target, sheet)
  await expect(sheet.getByTestId('menu-reactions')).toContainText('Mehmet')
  await sheet.getByTestId('msg-menu-react').tap()
  const picker = mehmet.page.getByTestId('emoji-picker')
  await expect(picker).toBeVisible()
  const pickerBox = (await picker.boundingBox())!
  expect(pickerBox.x).toBeGreaterThanOrEqual(0)
  expect(pickerBox.x + pickerBox.width).toBeLessThanOrEqual(390)
  expect(pickerBox.y + pickerBox.height).toBeLessThanOrEqual(844)
  await picker.locator('[data-emoji="🎉"]').first().tap()
  await expect(chip(row(ayse.page, 'sinemaya'), '🎉')).toContainText('1')

  // A tap on a chip toggles it; a long-press on it opens the sheet instead.
  await chip(target, '🎉').tap()
  await expect(chip(row(ayse.page, 'sinemaya'), '🎉')).toHaveCount(0)

  await longPress(mehmet.page, target, sheet)
  await sheet.getByTestId('msg-menu-reply').tap()
  await expect(mehmet.page.getByTestId('reply-bar')).toContainText('Ayşe')
  await mehmet.page.getByTestId('composer').fill('olur, 8 seansı')
  await mehmet.page.getByTestId('composer-send').tap()
  await expect(row(ayse.page, 'olur, 8 seansı').getByTestId('reply-quote')).toContainText('akşam sinemaya')
})
