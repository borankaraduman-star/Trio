/**
 * CONTRACT-V10-GROUPS §4a, from the owner's reports: "in a text channel I am
 * not there" (desktop app) and "I can't switch between channels".
 *
 * At every width and at Windows display scaling (a 1280×820 window at 125 %
 * and 150 % is 1024×656 and 853×547 CSS px; a 1366×768 laptop at 150 % is
 * ~911 px wide): "Üyeler" is in the channel header and opens a panel that
 * lists everybody with their online state and me; and a click anywhere on a
 * channel row (left, middle, right edge), a key press on it and a tap on a
 * phone switch the open channel: the header and the message list change.
 */
import path from 'node:path'
import type { Page } from '@playwright/test'
import { freshServer } from '../lib/server'
import { joinFrom, seedAccounts } from '../lib/groups'
import { api, expect, personWithSession, SOHBET, test, type ContextOptions } from '../lib/trio'
import { SCREENSHOTS } from '../lib/v7phone'

test.beforeEach(async () => {
  await freshServer()
})

interface Layout {
  label: string
  options: ContextOptions
  phone?: boolean
  /** The member list is a column (else "Üyeler" opens it over the chat). */
  column: boolean
}

const LAYOUTS: Layout[] = [
  { label: '1440', options: { viewport: { width: 1440, height: 900 } }, column: true },
  { label: '1280x820 at 125 %', options: { viewport: { width: 1024, height: 656 }, deviceScaleFactor: 1.25 }, column: true },
  { label: '1366x768 at 150 %', options: { viewport: { width: 911, height: 488 }, deviceScaleFactor: 1.5 }, column: true },
  { label: '1280x820 at 150 %', options: { viewport: { width: 853, height: 547 }, deviceScaleFactor: 1.5 }, column: false },
  { label: '1100', options: { viewport: { width: 1100, height: 800 } }, column: true },
  { label: '1000', options: { viewport: { width: 1000, height: 800 } }, column: true },
  { label: '960', options: { viewport: { width: 960, height: 800 } }, column: true },
  { label: '900', options: { viewport: { width: 900, height: 800 } }, column: true },
  { label: '800', options: { viewport: { width: 800, height: 800 } }, column: false },
  { label: '700', options: { viewport: { width: 700, height: 800 } }, column: false },
  {
    label: '390 phone',
    options: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
    phone: true,
    column: false,
  },
]

async function header(page: Page): Promise<string> {
  return (await page.locator('.main-header h1').textContent()) ?? ''
}

test('every channel row switches the view, and Üyeler lists everybody, at every width and scale', async ({ browser, trio }) => {
  test.setTimeout(300_000)
  const me = await joinFrom('Ayşe')
  const others = await seedAccounts(['Mehmet', 'Zeynep', 'Ali'])
  const channels: { id: number; name: string }[] = []
  for (const name of ['oyun', 'film-gecesi-ve-uzun-bir-ad']) {
    const body = await api<{ channel: { id: number; name: string } }>(me.token, '/api/channels', { method: 'POST', body: { name, kind: 'text' } })
    channels.push(body.channel)
  }
  const texts = [{ id: 1, name: 'genel' }, ...channels]

  for (const layout of LAYOUTS) {
    const person = trio.add(await personWithSession(browser, `Ayşe ${layout.label}`, me, layout.options))
    const page = person.page
    const sidebarRow = (id: number) => page.getByTestId(`channel-${id}`)
    const openDrawer = async () => {
      if (!layout.phone) return
      await page.getByTestId('btn-drawer').tap()
      await expect(page.locator('nav.sidebar')).toBeInViewport({ ratio: 0.99 })
    }

    for (const index of texts.keys()) {
      // Three points along the row: the icon, the middle, the right edge.
      for (const where of ['left', 'middle', 'right'] as const) {
        const target = texts[(index + 1) % texts.length]
        await openDrawer()
        const row = sidebarRow(target.id)
        const box = (await row.boundingBox())!
        const x = where === 'left' ? 6 : where === 'middle' ? box.width / 2 : box.width - 4
        if (layout.phone) await row.tap({ position: { x, y: box.height / 2 } })
        else await row.click({ position: { x, y: box.height / 2 } })
        await expect.poll(() => header(page), { message: `${layout.label}: ${where} of #${target.name}` }).toBe(target.name)
        await expect(row).toHaveAttribute('aria-current', 'page')
        // The drawer closes on a phone, showing the channel.
        if (layout.phone) await expect(page.locator('nav.sidebar')).not.toBeInViewport()
        await expect(page.getByTestId('composer')).toHaveAttribute('placeholder', `Mesaj yaz… (#${target.name})`)
      }
    }

    // The keyboard: Tab to a row, Enter.
    if (!layout.phone) {
      await sidebarRow(1).focus()
      await page.keyboard.press('Enter')
      await expect.poll(() => header(page)).toBe('genel')
    }

    // Who is here, in a text channel: "Üyeler" (a phone has the pill and the drawer).
    if (layout.phone) {
      await expect(page.getByTestId('presence-pill')).toBeVisible()
      await page.getByTestId('presence-pill').tap()
      await expect(page.getByTestId(`drawer-member-${me.user.id}`)).toBeVisible()
      await page.locator('.backdrop').tap({ position: { x: 370, y: 400 } })
    } else {
      const toggle = page.getByTestId('btn-members')
      await expect(toggle).toBeVisible()
      await expect(toggle).toBeInViewport({ ratio: 1 })
      const panel = page.getByTestId('members-panel')
      if (layout.column) {
        await expect(panel).toBeVisible()
        await expect(toggle).toHaveAttribute('aria-pressed', 'true')
      } else {
        await expect(panel).toBeHidden()
        await toggle.click()
        await expect(panel).toBeVisible()
        await expect(panel).toBeInViewport()
      }
      await expect(page.getByTestId('members-title')).toHaveText(/^Üyeler — \d+ çevrimiçi$/)
      await expect(page.getByTestId(`member-${me.user.id}`)).toContainText('(sen)')
      await expect(page.getByTestId(`member-${me.user.id}`)).toHaveAttribute('data-online', 'true')
      for (const other of others) await expect(page.getByTestId(`member-${other.user.id}`)).toBeAttached()
      const tag = layout.label.match(/(125|150) %/)?.[1]
      if (tag) await page.screenshot({ path: path.join(SCREENSHOTS, `v10-groups-scale-${tag}-${layout.options.viewport!.width}.png`) })
      // Close it again: the column is remembered hidden, the overlay closes on its button.
      if (layout.column) {
        await toggle.click()
        await expect(panel).toBeHidden()
        await page.reload()
        await expect(page.getByTestId('members-panel')).toBeHidden()
        await page.getByTestId('btn-members').click()
        await expect(page.getByTestId('members-panel')).toBeVisible()
      } else {
        await page.getByTestId('members-close').click()
        await expect(panel).toBeHidden()
      }
    }

    // A voice row joins (the room's people under it, the panel says so) and the text view stays.
    const before = await header(page)
    await openDrawer()
    if (layout.phone) await sidebarRow(SOHBET).tap()
    else await sidebarRow(SOHBET).click()
    await expect(page.locator('.voice-status strong')).toHaveText('Ses bağlı')
    await expect(page.getByTestId(`voice-user-${me.user.id}`)).toBeVisible()
    if (layout.phone) await page.locator('.backdrop').tap({ position: { x: 370, y: 400 } })
    expect(await header(page)).toBe(before)
    if (layout.phone) await page.getByTestId('call-bar-hangup').tap()
    else await page.getByTestId('btn-hangup').click()
    await expect(page.locator('.voice-panel')).toHaveCount(0)

    // After a reload the open channel is the one chosen last.
    const last = texts[2]
    await openDrawer()
    if (layout.phone) await sidebarRow(last.id).tap()
    else await sidebarRow(last.id).click()
    await expect.poll(() => header(page)).toBe(last.name)
    await page.reload()
    await expect.poll(() => header(page)).toBe(last.name)
    await person.context.close()
  }
})
