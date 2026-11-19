/**
 * CONTRACT-V7-READING §1–3: read state kept on the server follows a person
 * from one device to the other (nobody else is told), a channel opens at its
 * first unread message under a "Yeni mesajlar" line, and the jump to the
 * newest counts what arrived while the reader was up in history.
 */
import path from 'node:path'
import { E2E_DIR, freshServer } from '../lib/server'
import { api, apiLinkCode, bulkSend, expect, GENEL, linkedDevice, personViaApi, test, threePeople } from '../lib/trio'
import { row, send } from '../lib/messages'

const OUT = path.join(E2E_DIR, 'screenshots')

test.beforeEach(async () => {
  await freshServer()
})

test('read on one device is read on the other; nobody else learns anything', async ({ browser, trio }) => {
  const [ayse, mehmet, zeynep] = await threePeople(browser, trio)
  const { channel } = await api<{ channel: { id: number } }>(ayse.token, '/api/channels', {
    method: 'POST',
    body: { name: 'oyun', kind: 'text' },
  })
  const phone = trio.add(await linkedDevice(browser, ayse, await apiLinkCode(ayse.token)))

  await bulkSend(mehmet, channel.id, 3, 'akşam')
  for (const page of [ayse.page, phone.page, zeynep.page]) {
    await expect(page.getByTestId(`channel-${channel.id}`)).toHaveAttribute('data-unread', 'true')
    await expect(page).toHaveTitle('(3) Trio')
  }

  // Ayşe reads #oyun on her computer: her phone's dot and count go by themselves.
  await ayse.page.getByTestId(`channel-${channel.id}`).click()
  await expect(row(ayse.page, 'akşam 3')).toBeVisible()
  await expect(phone.page.getByTestId(`channel-${channel.id}`)).toHaveAttribute('data-unread', 'false')
  await expect(phone.page).toHaveTitle('Trio')
  // Zeynep's is hers: still unread.
  await expect(zeynep.page.getByTestId(`channel-${channel.id}`)).toHaveAttribute('data-unread', 'true')
  await expect(zeynep.page).toHaveTitle('(3) Trio')

  // A reload of the phone asks the server, not its own memory.
  await phone.page.evaluate(() => localStorage.removeItem('trio.lastRead'))
  await phone.page.reload()
  await expect(phone.page.getByTestId('composer')).toBeVisible()
  await expect(phone.page.getByTestId(`channel-${channel.id}`)).toHaveAttribute('data-unread', 'false')
  await expect(phone.page).toHaveTitle('Trio')

  // Someone who arrives later starts with the history read.
  const ece = trio.add(await personViaApi(browser, 'Ece'))
  await expect(ece.page.getByTestId(`channel-${channel.id}`)).toHaveAttribute('data-unread', 'false')
  await expect(ece.page).toHaveTitle('Trio')
})

test('a channel opens at its first unread message; the jump to the newest counts', async ({ browser, trio }) => {
  const [ayse, mehmet] = await threePeople(browser, trio)
  await bulkSend(mehmet, GENEL, 60, 'eski')
  const { channel } = await api<{ channel: { id: number } }>(ayse.token, '/api/channels', {
    method: 'POST',
    body: { name: 'gezi', kind: 'text' },
  })
  await bulkSend(mehmet, channel.id, 30, 'okundu')
  const page = ayse.page
  await page.getByTestId(`channel-${channel.id}`).click()
  await expect(row(page, 'okundu 30')).toBeVisible()
  await expect(page.getByTestId('new-messages-divider')).toHaveCount(0)
  await page.getByTestId(`channel-${GENEL}`).click()

  // 80 more while she is elsewhere: more than one page past her mark.
  await bulkSend(mehmet, channel.id, 80, 'yeni')
  await page.getByTestId(`channel-${channel.id}`).click()
  const divider = page.getByTestId('new-messages-divider')
  await expect(divider).toBeVisible()
  // The line sits right above the first unread message, near the top of the list.
  const first = await page.locator('[data-testid="new-messages-divider"] + [data-testid="message"]').textContent()
  expect(first).toContain('yeni 1')
  const list = page.getByTestId('message-list')
  const [listBox, lineBox] = [await list.boundingBox(), await divider.boundingBox()]
  expect(lineBox!.y - listBox!.y).toBeLessThan(60)
  // Everything after the mark is below: the button says so.
  const jump = page.getByTestId('jump-to-bottom')
  await expect(jump).toHaveAttribute('data-count', '80')
  await page.screenshot({ path: path.join(OUT, 'v7-reading-divider.png') })

  await jump.click()
  await expect(jump).toHaveCount(0)
  await expect(row(page, 'yeni 80')).toBeInViewport()

  // Up in history, two arrive: the button counts them.
  await list.evaluate((element) => (element.scrollTop = element.scrollHeight / 3))
  await expect(jump).toHaveAttribute('data-count', '0')
  await bulkSend(mehmet, channel.id, 1, 'bir')
  await expect(jump).toHaveAttribute('data-count', '1')
  await send(mehmet.page, 'genele bir şey') // Mehmet's own channel is #genel: not counted here
  await bulkSend(mehmet, channel.id, 1, 'iki')
  await expect(jump).toHaveAttribute('data-count', '2')
  await page.screenshot({ path: path.join(OUT, 'v7-reading-jump.png') })

  // Leaving the channel ends the divider; coming back with nothing new opens at the bottom.
  await page.getByTestId(`channel-${GENEL}`).click()
  await page.getByTestId(`channel-${channel.id}`).click()
  await expect(page.getByTestId('new-messages-divider')).toHaveCount(0)
  await expect(page.getByTestId('jump-to-bottom')).toHaveCount(0)
})
