import type { Page } from '@playwright/test'
import { freshServer } from '../lib/server'
import { api, expect, expectConnected, GENEL, test, threePeople } from '../lib/trio'

test.beforeEach(async () => {
  await freshServer()
})

async function send(page: Page, text: string): Promise<void> {
  await page.getByTestId('composer').fill(text)
  await page.getByTestId('composer').press('Enter')
}

const messages = (page: Page) => page.getByTestId('message')


test('text: real-time delivery, persistence, typing, HTML as text, links', async ({ browser, trio }) => {
  const [ayse, mehmet, zeynep] = await threePeople(browser, trio)

  await send(ayse.page, 'Selam millet!')
  for (const person of [ayse, mehmet, zeynep]) {
    await expect(messages(person.page).last()).toContainText('Selam millet!')
    await expect(messages(person.page).last()).toHaveAttribute('data-status', 'sent')
  }
  await expect(messages(ayse.page)).toHaveCount(1)

  // Shift+Enter is a newline, not a send.
  await mehmet.page.getByTestId('composer').fill('birinci satır')
  await mehmet.page.getByTestId('composer').press('Shift+Enter')
  await mehmet.page.getByTestId('composer').pressSequentially('ikinci satır')
  await mehmet.page.getByTestId('composer').press('Enter')
  await expect(messages(zeynep.page).last().locator('.message-content')).toHaveText('birinci satır\nikinci satır')

  // HTML is shown as text, never parsed.
  const html = '<img src=x onerror="window.__xss=1"><b>kalın değil</b>'
  await send(zeynep.page, html)
  for (const person of [ayse, mehmet, zeynep]) {
    const content = messages(person.page).last().locator('.message-content')
    await expect(content).toHaveText(html)
    await expect(content.locator('img, b')).toHaveCount(0)
    expect(await person.page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined()
  }

  // A URL becomes a link that opens safely in a new tab.
  await send(ayse.page, 'Şuna bakın: https://example.com/yol?a=1 güzel')
  for (const person of [mehmet, zeynep]) {
    const link = messages(person.page).last().locator('a')
    await expect(link).toHaveAttribute('href', 'https://example.com/yol?a=1')
    await expect(link).toHaveText('https://example.com/yol?a=1')
    await expect(link).toHaveAttribute('target', '_blank')
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  }

  // Typing indicator, on the others' pages only, and gone after the send.
  await mehmet.page.getByTestId('composer').pressSequentially('yazıyorum')
  await expect(ayse.page.getByTestId('typing')).toHaveText('Mehmet yazıyor…')
  await expect(zeynep.page.getByTestId('typing')).toHaveText('Mehmet yazıyor…')
  await expect(mehmet.page.getByTestId('typing')).toHaveText('')
  await mehmet.page.getByTestId('composer').press('Enter')
  await expect(ayse.page.getByTestId('typing')).toHaveText('')

  // Persistence across a reload.
  await zeynep.page.reload()
  await expectConnected(zeynep.page)
  await expect(messages(zeynep.page)).toHaveCount(5)
  await expect(messages(zeynep.page).first()).toContainText('Selam millet!')
  await expect(messages(zeynep.page).last()).toContainText('yazıyorum')
})

test('text: unread dot and a new channel appear for everybody', async ({ browser, trio }) => {
  const [ayse, mehmet, zeynep] = await threePeople(browser, trio)

  // Ayşe creates a channel; everyone sees it.
  await ayse.page.getByTestId('add-channel-text').click()
  await ayse.page.getByTestId('add-channel-name').fill('oyunlar')
  await ayse.page.getByTestId('add-channel-submit').click()
  const { channels } = await api<{ channels: { id: number; name: string }[] }>(ayse.token, '/api/channels')
  const oyunlar = channels.find((c) => c.name === 'oyunlar')!
  expect(oyunlar).toBeTruthy()
  for (const person of [ayse, mehmet, zeynep]) {
    await expect(person.page.getByTestId(`channel-${oyunlar.id}`)).toHaveText(/oyunlar/)
  }
  // The creator is moved into it.
  await expect(ayse.page.locator('.main-header h1')).toHaveText('oyunlar')
  await expect(mehmet.page.locator('.main-header h1')).toHaveText('genel')

  // A message in #oyunlar lights the dot for those looking at #genel.
  await send(ayse.page, 'Akşam oyun var mı?')
  for (const person of [mehmet, zeynep]) {
    await expect(person.page.getByTestId(`channel-${oyunlar.id}`)).toHaveAttribute('data-unread', 'true')
    await expect(person.page.getByTestId(`channel-${GENEL}`)).toHaveAttribute('data-unread', 'false')
    await expect(person.page).toHaveTitle('(1) Trio')
  }
  await expect(ayse.page.getByTestId(`channel-${oyunlar.id}`)).toHaveAttribute('data-unread', 'false')

  // Opening the channel clears it, and shows the message.
  await mehmet.page.getByTestId(`channel-${oyunlar.id}`).click()
  await expect(messages(mehmet.page).last()).toContainText('Akşam oyun var mı?')
  await expect(mehmet.page.getByTestId(`channel-${oyunlar.id}`)).toHaveAttribute('data-unread', 'false')
  await expect(mehmet.page).toHaveTitle('Trio')

  // Zeynep reloads before reading: the dot survives (it is learned from the server).
  await zeynep.page.reload()
  await expectConnected(zeynep.page)
  await expect(zeynep.page.getByTestId(`channel-${oyunlar.id}`)).toHaveAttribute('data-unread', 'true')
  // and a message in #genel from Ayşe does the same for Mehmet, who is now in #oyunlar.
  await ayse.page.getByTestId(`channel-${GENEL}`).click()
  await send(ayse.page, 'genel kanala da yazayım')
  await expect(mehmet.page.getByTestId(`channel-${GENEL}`)).toHaveAttribute('data-unread', 'true')
})

test('text: scrolling up loads older pages', async ({ browser, trio }) => {
  const [ayse, mehmet] = await threePeople(browser, trio)
  // 120 messages in #genel, through the websocket like the UI does: send them
  // with Ayşe's own socket by driving her composer would be slow, so the
  // last few go through the UI and the bulk through a second tab of hers.
  const bulk = await ayse.context.newPage()
  await bulk.goto('/')
  await expectConnected(bulk)
  await bulk.evaluate(async (count) => {
    const token = localStorage.getItem('trio.token')!
    const ws = new WebSocket(`ws://${location.host}/ws?token=${encodeURIComponent(token)}`)
    await new Promise((resolve) => ws.addEventListener('message', resolve, { once: true }))
    let confirmed = 0
    const done = new Promise<void>((resolve) =>
      ws.addEventListener('message', (event) => {
        const frame = JSON.parse(String(event.data))
        if (frame.type === 'message.new' && frame.nonce?.startsWith('bulk-') && ++confirmed === count) resolve()
      }),
    )
    for (let i = 1; i <= count; i++) {
      ws.send(JSON.stringify({ type: 'message.send', channel_id: 1, content: `eski mesaj ${i}`, nonce: `bulk-${i}` }))
    }
    await done
    ws.close()
  }, 120)
  await bulk.close()

  const page = mehmet.page
  await expect(messages(page).last()).toContainText('eski mesaj 120')
  await page.reload()
  await expectConnected(page)
  // The first page is the newest 50.
  await expect(messages(page)).toHaveCount(50)
  await expect(messages(page).first()).toContainText('eski mesaj 71')
  await expect(page.getByText('Kanalın başlangıcı.')).toHaveCount(0)

  const scroller = page.getByTestId('message-list')
  await scroller.evaluate((el) => (el.scrollTop = 0))
  await expect(messages(page)).toHaveCount(100)
  await expect(messages(page).first()).toContainText('eski mesaj 21')
  // The message that was at the top is still in view: the list did not jump to the start.
  await expect(page.getByText('eski mesaj 71', { exact: true })).toBeInViewport()

  await scroller.evaluate((el) => (el.scrollTop = 0))
  await expect(messages(page)).toHaveCount(120)
  await expect(messages(page).first()).toContainText('eski mesaj 1')
  await expect(page.getByText('Kanalın başlangıcı.')).toBeVisible()
  // Ids are in order with no gaps or duplicates.
  const texts = await messages(page).locator('.message-content').allTextContents()
  expect(texts).toEqual(Array.from({ length: 120 }, (_, i) => `eski mesaj ${i + 1}`))
})
