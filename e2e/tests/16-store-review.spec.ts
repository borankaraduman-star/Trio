/**
 * Message state across connection drops, focus, and the composer's length
 * limit (the store review's findings 2, 3, 5, 7 and 8).
 */
import type { Page, WebSocketRoute } from '@playwright/test'
import { freshServer } from '../lib/server'
import {
  api,
  apiJoin,
  bulkSend,
  expect,
  expectConnected,
  GENEL,
  personViaApi,
  personWithSession,
  test,
  type ContextOptions,
  type Person,
} from '../lib/trio'

test.beforeEach(async () => {
  await freshServer()
})

const messages = (page: Page) => page.getByTestId('message')
const message = (page: Page, text: string) => messages(page).filter({ hasText: text })

async function send(page: Page, text: string): Promise<void> {
  await page.getByTestId('composer').fill(text)
  await page.getByTestId('composer').press('Enter')
}

/**
 * A websocket the test can cut. Frames go through the test in both directions,
 * so it can also drop one frame from the server and cut right there.
 */
class Switch {
  online = true
  /** Cut the connection instead of delivering the next `message.new` that carries a nonce. */
  loseNextEcho = false
  private current: { page: WebSocketRoute; server: WebSocketRoute } | null = null

  prepare: ContextOptions['prepare'] = (context) =>
    context.routeWebSocket(/\/ws/, (ws) => {
      if (!this.online) {
        void ws.close({ code: 1011, reason: 'offline' })
        return
      }
      const server = ws.connectToServer()
      const link = { page: ws, server }
      this.current = link
      ws.onMessage((frame) => server.send(frame))
      server.onMessage((frame) => {
        if (this.loseNextEcho && typeof frame === 'string') {
          const event = JSON.parse(frame) as { type?: string; nonce?: string }
          if (event.type === 'message.new' && event.nonce !== undefined) {
            // The server has stored it; the sender never hears so.
            this.loseNextEcho = false
            void this.cut(link)
            return
          }
        }
        if (this.current === link) ws.send(frame)
      })
    })

  /** Both halves go: the page sees a drop, the server sees the client leave. */
  async cut(link = this.current): Promise<void> {
    if (!link) return
    if (this.current === link) this.current = null
    await link.server.close({ code: 1000, reason: 'cut' }).catch(() => undefined)
    await link.page.close({ code: 1011, reason: 'cut' }).catch(() => undefined)
  }
}

async function personBehindSwitch(browser: Parameters<typeof personViaApi>[0], name: string, sw: Switch): Promise<Person> {
  return personWithSession(browser, name, await apiJoin(name), { prepare: sw.prepare })
}

const banner = (page: Page) => page.locator('.banner')

// --- finding 2 -----------------------------------------------------------------

test('a message whose echo was lost in a drop shows once, as sent, after the reconnect', async ({ browser, trio }) => {
  const ayse = trio.add(await personViaApi(browser, 'Ayşe'))
  const sw = new Switch()
  const zeynep = trio.add(await personBehindSwitch(browser, 'Zeynep', sw))

  sw.loseNextEcho = true
  await send(zeynep.page, 'yankısı kayboldu')
  await expect(banner(zeynep.page)).toHaveText('Bağlantı koptu, yeniden bağlanılıyor…')
  // The server has it: Ayşe got it live.
  await expect(message(ayse.page, 'yankısı kayboldu')).toHaveCount(1)

  await expectConnected(zeynep.page)
  await expect(message(zeynep.page, 'yankısı kayboldu')).toHaveCount(1)
  await expect(message(zeynep.page, 'yankısı kayboldu')).toHaveAttribute('data-status', 'sent')
  await expect(zeynep.page.getByRole('button', { name: 'Tekrar dene' })).toHaveCount(0)

  // And the next message is not mistaken for it.
  await send(zeynep.page, 'yankısı kayboldu')
  await expect(message(zeynep.page, 'yankısı kayboldu')).toHaveCount(2)
  await expect(message(zeynep.page, 'yankısı kayboldu').last()).toHaveAttribute('data-status', 'sent')
  await expect(message(ayse.page, 'yankısı kayboldu')).toHaveCount(2)
})

// --- finding 3 -----------------------------------------------------------------

test('an unsent message in a channel you are not looking at survives the reconnect, attachment included', async ({ browser, trio }) => {
  const ayse = trio.add(await personViaApi(browser, 'Ayşe'))
  const sw = new Switch()
  const zeynep = trio.add(await personBehindSwitch(browser, 'Zeynep', sw))
  const { channel } = await api<{ channel: { id: number } }>(zeynep.token, '/api/channels', {
    method: 'POST',
    body: { name: 'planlar', kind: 'text' },
  })

  await zeynep.page.getByTestId(`channel-${channel.id}`).click()
  await expect(zeynep.page.locator('.main-header h1')).toHaveText('planlar')
  sw.online = false
  await sw.cut()
  await expect(banner(zeynep.page)).toHaveText('Bağlantı koptu, yeniden bağlanılıyor…')

  // Uploads are plain HTTP: they still work, the message cannot be sent.
  await zeynep.page.getByTestId('file-input').setInputFiles({
    name: 'liste.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('çadır, uyku tulumu, fener\n'),
  })
  await expect(zeynep.page.locator('[data-testid="pending-attachment"][data-status="done"]')).toHaveCount(1)
  await send(zeynep.page, 'malzeme listesi')
  await expect(message(zeynep.page, 'malzeme listesi')).toHaveAttribute('data-status', 'failed')

  // Somewhere else while it comes back.
  await zeynep.page.getByTestId(`channel-${GENEL}`).click()
  sw.online = true
  await expectConnected(zeynep.page)

  await zeynep.page.getByTestId(`channel-${channel.id}`).click()
  await expect(zeynep.page.locator('.list-note', { hasText: 'Yükleniyor' })).toHaveCount(0)
  const failed = message(zeynep.page, 'malzeme listesi')
  await expect(failed).toHaveCount(1)
  await expect(failed).toHaveAttribute('data-status', 'failed')
  await expect(failed).toContainText('liste.txt')

  await failed.getByRole('button', { name: 'Tekrar dene' }).click()
  await expect(failed).toHaveAttribute('data-status', 'sent')
  await ayse.page.getByTestId(`channel-${channel.id}`).click()
  await expect(message(ayse.page, 'malzeme listesi')).toContainText('liste.txt')
})

// --- finding 5 -----------------------------------------------------------------

/** Where the row with this text sits, relative to the top of the scrolling list. */
async function offsetInView(page: Page, text: string): Promise<number> {
  return page.evaluate((wanted) => {
    const list = document.querySelector('[data-testid="message-list"]')!
    const row = [...document.querySelectorAll('[data-testid="message"]')].find(
      (element) => element.querySelector('.message-content')?.textContent === wanted,
    )
    if (!row) throw new Error(`no row ${wanted}`)
    return row.getBoundingClientRect().top - list.getBoundingClientRect().top
  }, text)
}

const contents = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-testid="message"] .message-content')].map((e) => e.textContent),
  )

test('a reader deep in history stays where they were through a reconnect, and nothing loaded is thrown away', async ({ browser, trio }) => {
  test.setTimeout(120_000)
  const ayse = trio.add(await personViaApi(browser, 'Ayşe'))
  await bulkSend(ayse, GENEL, 300, 'eski')
  const sw = new Switch()
  const zeynep = trio.add(await personBehindSwitch(browser, 'Zeynep', sw))
  const page = zeynep.page
  const list = page.getByTestId('message-list')

  // Scroll up until the whole history is loaded.
  await expect(message(page, 'eski 300')).toHaveCount(1)
  while ((await page.locator('.list-note.start').count()) === 0) {
    const count = await messages(page).count()
    await list.evaluate((element) => (element.scrollTop = 0))
    await expect.poll(async () => (await messages(page).count()) > count || (await page.locator('.list-note.start').count()) > 0).toBe(true)
  }
  await expect(messages(page)).toHaveCount(300)

  // Read around the first third. A programmatic scroll's `scroll` event comes
  // a frame later; until the list has handled it, it still holds the row it
  // was showing before, and any render meanwhile (the drop below re-renders
  // the session) puts THAT row back. A person's scroll is handled long before
  // they can lose their connection: wait for it here too.
  await page.evaluate(async () => {
    const list = document.querySelector('[data-testid="message-list"]')!
    const handled = new Promise<void>((resolve) => list.addEventListener('scroll', () => resolve(), { once: true }))
    const row = [...document.querySelectorAll('[data-testid="message"]')].find(
      (element) => element.querySelector('.message-content')?.textContent === 'eski 100',
    )!
    row.scrollIntoView({ block: 'start' })
    list.scrollTop -= 40
    await handled
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })
  const before = await offsetInView(page, 'eski 100')
  const loadedBefore = await contents(page)

  sw.online = false
  await sw.cut()
  await expect(banner(page)).toHaveText('Bağlantı koptu, yeniden bağlanılıyor…')
  for (const text of ['sen yokken 1', 'sen yokken 2', 'sen yokken 3']) await send(ayse.page, text)
  await expect(message(ayse.page, 'sen yokken 3')).toHaveAttribute('data-status', 'sent')

  sw.online = true
  await expectConnected(page)
  await expect(messages(page)).toHaveCount(303)
  const after = await contents(page)
  expect(after.slice(0, 300)).toEqual(loadedBefore)
  expect(after.slice(300)).toEqual(['sen yokken 1', 'sen yokken 2', 'sen yokken 3'])
  expect(Math.abs((await offsetInView(page, 'eski 100')) - before)).toBeLessThanOrEqual(1)
  await expect(page.locator('.list-note.start')).toHaveCount(1)
})

// --- finding 7 -----------------------------------------------------------------

/** Make the page lose or regain focus as a window behind another one does: still visible, not focused. */
async function setFocused(page: Page, focused: boolean): Promise<void> {
  await page.evaluate((value) => {
    const w = window as unknown as { __trioFocused?: boolean }
    if (w.__trioFocused === undefined) {
      const native = document.hasFocus.bind(document)
      document.hasFocus = () => w.__trioFocused !== false && native()
    }
    w.__trioFocused = value
    window.dispatchEvent(new Event(value ? 'focus' : 'blur'))
  }, focused)
}

/**
 * Headless Chromium answers `Notification.permission` with "denied" even when
 * the permission is granted, so the page gets a stand-in that is granted and
 * records what the app asks to show. It checks the app's DECISION to notify,
 * not that the system shows anything.
 */
const NOTIFICATION_PROBE = `
(() => {
  window.__trioNotifications = []
  class Recorded {
    static permission = 'granted'
    static requestPermission() { return Promise.resolve('granted') }
    constructor(title) { window.__trioNotifications.push(title) }
    close() {}
  }
  window.Notification = Recorded
})()
`

test('a visible but unfocused window counts the open channel unread and notifies, until focus returns', async ({ browser, trio }) => {
  const mehmet = trio.add(await personViaApi(browser, 'Mehmet'))
  const ayse = trio.add(
    await personWithSession(browser, 'Ayşe', await apiJoin('Ayşe'), {
      prepare: async (context) => {
        await context.addInitScript(NOTIFICATION_PROBE)
      },
    }),
  )
  await expect(ayse.page).toHaveTitle('Trio')
  expect(await ayse.page.evaluate(() => document.visibilityState)).toBe('visible')

  // Focused: read at once, no notification.
  await send(mehmet.page, 'buradayken')
  await expect(message(ayse.page, 'buradayken')).toHaveCount(1)
  await expect(ayse.page).toHaveTitle('Trio')

  await setFocused(ayse.page, false)
  await send(mehmet.page, 'başka penceredeyken')
  await expect(message(ayse.page, 'başka penceredeyken')).toHaveCount(1)
  await expect(ayse.page).toHaveTitle('(1) Trio')
  expect(await ayse.page.evaluate(() => (window as unknown as { __trioNotifications: string[] }).__trioNotifications)).toEqual([
    'Mehmet — #genel',
  ])
  // It stays unread while the window has no focus.
  await send(mehmet.page, 'hâlâ yoksun')
  await expect(ayse.page).toHaveTitle('(2) Trio')

  await setFocused(ayse.page, true)
  await expect(ayse.page).toHaveTitle('Trio')
})

// --- finding 8 -----------------------------------------------------------------

test('a long paste is never cut: the composer counts like the server and refuses to send what is over', async ({ browser, trio }) => {
  const ayse = trio.add(await personViaApi(browser, 'Ayşe'))
  const page = ayse.page
  const composer = page.getByTestId('composer')
  const sendButton = page.getByTestId('composer-send')
  const length = page.getByTestId('composer-length')

  await composer.focus()
  await page.keyboard.insertText('x'.repeat(3799))
  await expect(length).toHaveCount(0)
  await page.keyboard.insertText('x')
  await expect(length).toHaveText('3800 / 4000')
  await expect(sendButton).toBeEnabled()

  // Pasted past the limit: everything is kept, nothing can be sent.
  await page.keyboard.insertText('y'.repeat(300))
  expect(await composer.inputValue()).toBe('x'.repeat(3800) + 'y'.repeat(300))
  await expect(length).toContainText('4100 / 4000')
  await expect(length.getByRole('alert')).toHaveText(
    'Mesaj çok uzun: en fazla 4000 karakter olabilir. 100 karakter fazla.',
  )
  await expect(sendButton).toBeDisabled()
  await composer.press('Enter')
  await expect(messages(page)).toHaveCount(0)
  expect((await composer.inputValue()).length).toBe(4100)

  // Exactly the limit as the server counts it: code points after the trim.
  // 3999 letters and an emoji are 4001 UTF-16 units but 4000 characters.
  await composer.fill('')
  const text = `${'a'.repeat(3999)}😀`
  await page.keyboard.insertText(`  ${text}\n`)
  await expect(length).toHaveText('4000 / 4000')
  await expect(sendButton).toBeEnabled()
  await sendButton.click()
  await expect(messages(page)).toHaveCount(1)
  await expect(messages(page)).toHaveAttribute('data-status', 'sent')
  const stored = await api<{ messages: { content: string }[] }>(ayse.token, `/api/channels/${GENEL}/messages?limit=1`)
  expect(stored.messages[0].content).toBe(text)
  await expect(composer).toHaveValue('')
})

test('after a drop that missed more than a catch-up fetches, a reader up in history is not moved and is offered the newest', async ({ browser, trio }) => {
  test.setTimeout(120_000)
  const ayse = trio.add(await personViaApi(browser, 'Ayşe'))
  await bulkSend(ayse, GENEL, 60, 'önce')
  const sw = new Switch()
  const zeynep = trio.add(await personBehindSwitch(browser, 'Zeynep', sw))
  const page = zeynep.page
  await expect(message(page, 'önce 60')).toHaveCount(1)
  await expect(messages(page)).toHaveCount(50)
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('[data-testid="message"]')].find(
      (element) => element.querySelector('.message-content')?.textContent === 'önce 15',
    )!
    row.scrollIntoView({ block: 'start' })
  })
  const before = await offsetInView(page, 'önce 15')
  const loadedBefore = await contents(page)
  // Really up in history, not within the "at the bottom" margin.
  expect(await page.getByTestId('message-list').evaluate((e) => e.scrollHeight - e.scrollTop - e.clientHeight)).toBeGreaterThan(200)

  sw.online = false
  await sw.cut()
  await expect(banner(page)).toHaveText('Bağlantı koptu, yeniden bağlanılıyor…')
  await bulkSend(ayse, GENEL, 600, 'yokken') // more than ten pages of fifty

  sw.online = true
  await expectConnected(page)
  const jump = page.getByTestId('jump-to-latest')
  await expect(jump).toHaveText('Yeni mesajlar var — en yeniye git')
  expect(await contents(page)).toEqual(loadedBefore)
  expect(Math.abs((await offsetInView(page, 'önce 15')) - before)).toBeLessThanOrEqual(1)
  // A live message is not put below the gap.
  await send(ayse.page, 'canlı')
  await expect(message(ayse.page, 'canlı')).toHaveAttribute('data-status', 'sent')
  expect(await contents(page)).toEqual(loadedBefore)

  await jump.click()
  await expect(jump).toHaveCount(0)
  await expect(messages(page).last()).toContainText('canlı')
  await expect(message(page, 'önce 15')).toHaveCount(0)
  await expect(messages(page).last()).toBeInViewport()
})
