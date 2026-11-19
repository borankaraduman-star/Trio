/**
 * CONTRACT-V6-MEDIA §5a: a draft per channel. The composer's text and the
 * message being replied to survive switching channels and a reload of the tab,
 * are cleared by sending, and the reload onto a newer build still waits for
 * unsent text (lib/reloadGuard.ts "draft") — in another channel too.
 */
import type { Page } from '@playwright/test'
import { freshServer } from '../lib/server'
import { api, expect, expectConnected, GENEL, personViaApi, test, threePeople, type ContextOptions } from '../lib/trio'
import { barAction, longPress, personBehindSwitch, row, send, Switch } from '../lib/messages'

test.beforeEach(async () => {
  await freshServer()
})

const PHONE: ContextOptions = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }

async function openChannel(page: Page, id: number, phone: boolean): Promise<void> {
  if (phone) await page.getByTestId('btn-drawer').tap()
  await page.getByTestId(`channel-${id}`).click()
  await expect(page.getByTestId('composer')).toBeVisible()
}

for (const width of [1280, 390] as const) {
  test(`text and reply per channel, across switches and a reload, cleared by sending (${width} px)`, async ({ browser, trio }) => {
    const phone = width === 390
    const [ayse, mehmet] = await threePeople(browser, trio)
    const { channel } = await api<{ channel: { id: number } }>(ayse.token, '/api/channels', { method: 'POST', body: { name: 'plan', kind: 'text' } })
    await send(mehmet.page, 'Cumartesi Göreme mi Uçhisar mı?')
    const me = phone ? trio.add(await personViaApi(browser, 'Zeynep', PHONE)) : ayse
    const page = me.page
    const composer = page.getByTestId('composer')

    // A reply and half a sentence in #genel.
    const target = row(page, 'Cumartesi Göreme')
    if (phone) {
      const sheet = page.getByTestId('message-menu')
      await longPress(page, target, sheet)
      await sheet.getByTestId('msg-menu-reply').tap()
    } else {
      await barAction(target, 'reply')
    }
    await expect(page.getByTestId('reply-bar')).toContainText('Cumartesi Göreme')
    await composer.fill('Bence Göreme, çünkü')

    // To #plan: empty box, no reply; write something there too.
    await openChannel(page, channel.id, phone)
    await expect(composer).toHaveValue('')
    await expect(page.getByTestId('reply-bar')).toHaveCount(0)
    await composer.fill('liste: su, şapka')

    // Back: both are where they were.
    await openChannel(page, GENEL, phone)
    await expect(composer).toHaveValue('Bence Göreme, çünkü')
    await expect(page.getByTestId('reply-bar')).toContainText('Cumartesi Göreme')

    // A reload keeps them (this tab's sessionStorage).
    await page.reload()
    await expectConnected(page)
    await expect(composer).toHaveValue('Bence Göreme, çünkü')
    await expect(page.getByTestId('reply-bar')).toContainText('Cumartesi Göreme')
    await openChannel(page, channel.id, phone)
    await expect(composer).toHaveValue('liste: su, şapka')
    await openChannel(page, GENEL, phone)

    // Sending: a reply, and the draft is gone (also after a reload).
    await composer.fill('Bence Göreme, çünkü balonlar orada')
    await composer.press('Enter')
    const sent = row(mehmet.page, 'balonlar orada')
    await expect(sent).toHaveCount(1)
    await expect(sent.getByTestId('reply-quote')).toContainText('Cumartesi Göreme')
    await expect(composer).toHaveValue('')
    await expect(page.getByTestId('reply-bar')).toHaveCount(0)
    await page.reload()
    await expectConnected(page)
    await expect(composer).toHaveValue('')
    await expect(page.getByTestId('reply-bar')).toHaveCount(0)
    // The other channel's draft is still there.
    await openChannel(page, channel.id, phone)
    await expect(composer).toHaveValue('liste: su, şapka')
  })
}

test('a newer build is not loaded over unsent text, even in a channel not open', async ({ browser, trio }) => {
  const sw = new Switch()
  const ayse = trio.add(await personBehindSwitch(browser, 'Ayşe', sw))
  const page = ayse.page
  const { channel } = await api<{ channel: { id: number } }>(ayse.token, '/api/channels', { method: 'POST', body: { name: 'plan', kind: 'text' } })
  await expect(page.getByTestId(`channel-${channel.id}`)).toBeVisible()
  // The server now "serves a newer build": the check's fetch of / names another entry script.
  await page.route('**/', async (route) => {
    if (route.request().resourceType() !== 'fetch') return route.continue()
    const response = await route.fetch()
    const html = (await response.text()).replace(/src="\/assets\/index-[^"]+\.js"/, 'src="/assets/index-yeni.js"')
    await route.fulfill({ response, body: html })
  })
  await page.evaluate(() => ((window as unknown as { __same: boolean }).__same = true))

  // A draft in #plan, then #genel opened: the reconnect's check sees the new build and does NOT reload.
  await openChannel(page, channel.id, false)
  await page.getByTestId('composer').fill('yarım kalmış plan')
  await openChannel(page, GENEL, false)
  const checked = page.waitForResponse((r) => r.request().resourceType() === 'fetch' && new URL(r.url()).pathname === '/')
  await sw.cut()
  await checked
  await expectConnected(page)
  // The decision follows the response in the same task; a round trip later the page is still this one.
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)))
  expect(await page.evaluate(() => (window as unknown as { __same?: boolean }).__same)).toBe(true)

  // With the draft emptied, the next reconnect does load it.
  await openChannel(page, channel.id, false)
  await page.getByTestId('composer').fill('')
  await openChannel(page, GENEL, false)
  const reloaded = page.waitForEvent('load')
  await sw.cut()
  await reloaded
  await expectConnected(page)
  expect(await page.evaluate(() => (window as unknown as { __same?: boolean }).__same)).toBeUndefined()
})
