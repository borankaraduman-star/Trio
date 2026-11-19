/**
 * Helpers for the message family specs (CONTRACT-V4 B): a row by its text,
 * its hover bar and menu, a long-press on a touch screen, a websocket the test
 * can cut, and REST shortcuts for setting a scene.
 */
import type { Locator, Page, WebSocketRoute } from '@playwright/test'
import { baseUrl } from './server'
import { apiJoin, expect, personWithSession, type ContextOptions, type Person } from './trio'

export const rows = (page: Page) => page.getByTestId('message')

/** The one confirmed row whose text contains `text`. */
export function row(page: Page, text: string): Locator {
  return rows(page).filter({ hasText: text })
}

/** The row whose text is exactly `text` ("not 3", not "not 30"). */
export function exactRow(page: Page, text: string): Locator {
  return rows(page).filter({ has: page.getByText(text, { exact: true }) })
}

export async function send(page: Page, text: string): Promise<void> {
  await page.getByTestId('composer').fill(text)
  await submitComposer(page)
  await expect(row(page, text).last()).toHaveAttribute('data-status', 'sent')
}

/**
 * Send what the composer holds the way the device does: Enter on a desktop,
 * the "Gönder" button on a touch-first device, where Enter is the newline key
 * (CONTRACT-V7-READING §4).
 */
export async function submitComposer(page: Page): Promise<void> {
  const composer = page.getByTestId('composer')
  if ((await composer.getAttribute('data-enter')) === 'newline') await page.getByTestId('composer-send').click()
  else await composer.press('Enter')
}

/** Hover the row and press one of its bar's buttons (react, reply, edit, menu). */
export async function barAction(target: Locator, kind: 'react' | 'reply' | 'edit' | 'menu'): Promise<void> {
  await target.hover()
  await target.getByTestId(`msg-action-${kind}`).click()
}

/** "⋯" → one menu item. */
export async function menuAction(page: Page, target: Locator, item: string): Promise<void> {
  await barAction(target, 'menu')
  await page.getByTestId('message-menu').getByTestId(`msg-menu-${item}`).click()
}

/** Pick an emoji in the open picker. */
export async function pick(page: Page, emoji: string): Promise<void> {
  await page.getByTestId('emoji-picker').locator(`[data-emoji="${emoji}"]`).first().click()
  await expect(page.getByTestId('emoji-picker')).toHaveCount(0)
}

export function chip(target: Locator, emoji: string): Locator {
  return target.locator(`[data-testid="reaction-chip"][data-reaction="${emoji}"]`)
}

/** The message ids of the rows a page shows, by their text. */
export async function idOf(target: Locator): Promise<number> {
  return Number(await target.getAttribute('data-message-id'))
}

/** Press and hold on a touch screen until `until` is visible, then lift the finger. */
export async function longPress(page: Page, target: Locator, until: Locator): Promise<void> {
  const box = await target.boundingBox()
  if (!box) throw new Error('long-press target is not on screen')
  const point = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + Math.min(box.height / 2, 20)) }
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
  try {
    await expect(until).toBeVisible()
  } finally {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await cdp.detach()
  }
}

/** REST as a test sets a scene (not what the UI does; the UI is asserted on separately). */
export async function rest(token: string, path: string, method: string, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl()}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

export async function restOk(token: string, path: string, method: string, body?: unknown): Promise<void> {
  const response = await rest(token, path, method, body)
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`)
}

export interface WireMessage {
  id: number
  content: string
}

/** Every message of a channel, oldest first (all pages). */
export async function allMessages(token: string, channelId: number): Promise<WireMessage[]> {
  const result: WireMessage[] = []
  let before: number | undefined
  for (;;) {
    const query = before === undefined ? 'limit=100' : `limit=100&before=${before}`
    const response = await fetch(`${baseUrl()}/api/channels/${channelId}/messages?${query}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const page = (await response.json()) as { messages: WireMessage[]; has_more: boolean }
    result.unshift(...page.messages)
    if (!page.has_more || page.messages.length === 0) return result
    before = page.messages[0].id
  }
}

/** Scroll a page's list up until `target` is in it (older pages load on the way). */
export async function scrollUpTo(page: Page, target: Locator): Promise<void> {
  await expect
    .poll(
      async () => {
        if ((await target.count()) > 0) return true
        await page.getByTestId('message-list').evaluate((element) => (element.scrollTop = 0))
        return false
      },
      { timeout: 20_000, intervals: [100, 200, 300] },
    )
    .toBe(true)
}

/** A websocket the test can cut (and keep cut). */
export class Switch {
  online = true
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
        if (this.current === link) ws.send(frame)
      })
    })

  async cut(): Promise<void> {
    const link = this.current
    if (!link) return
    this.current = null
    await link.server.close({ code: 1000, reason: 'cut' }).catch(() => undefined)
    await link.page.close({ code: 1011, reason: 'cut' }).catch(() => undefined)
  }
}

export async function personBehindSwitch(
  browser: Parameters<typeof personWithSession>[0],
  name: string,
  sw: Switch,
  options: ContextOptions = {},
): Promise<Person> {
  return personWithSession(browser, name, await apiJoin(name), { ...options, prepare: sw.prepare })
}
