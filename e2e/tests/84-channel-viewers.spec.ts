/**
 * CONTRACT-V10-GROUPS §4b, the owner's words: "switching works, but it is not
 * clear who is in which channel". Under every text channel row: who has it
 * open right now (me included); in the header "Burada: …". Moving updates
 * within a second, a page nobody looks at leaves its channel, "Hangi kanalda
 * olduğumu göster" hides me, and six of fifteen in one channel fold into "+n".
 * Screenshots `v10-groups-viewers-*.png` at 1440, at 150 % and at 390.
 */
import path from 'node:path'
import type { Page } from '@playwright/test'
import { freshServer } from '../lib/server'
import { crowd, GROUP_NAMES, joinFrom, seedAccounts } from '../lib/groups'
import { api, expect, GENEL, personWithSession, test, type Person } from '../lib/trio'
import { SCREENSHOTS, openDrawer } from '../lib/v7phone'
import { AWAY_SCRIPT, setAway } from '../lib/push'
import { openSettings } from '../lib/ops'

const WIDE = { viewport: { width: 1440, height: 900 }, prepare: async (c: import('@playwright/test').BrowserContext) => void (await c.addInitScript(AWAY_SCRIPT)) }
const shot = (name: string) => path.join(SCREENSHOTS, `v10-groups-viewers-${name}.png`)

test.beforeEach(async () => {
  await freshServer()
})

async function open(person: Person, channelId: number): Promise<void> {
  await person.page.getByTestId(`channel-${channelId}`).click()
  await expect(person.page.getByTestId(`channel-${channelId}`)).toHaveAttribute('aria-current', 'page')
}

const viewer = (page: Page, channelId: number, userId: number) => page.getByTestId(`viewer-${channelId}-${userId}`)

test('three people in three channels see each other under the right rows; moving, hiding and the setting', async ({ browser, trio }) => {
  test.setTimeout(180_000)
  const [ayse, mehmet, zeynep] = await crowd(browser, trio, 3, WIDE)
  const oyun = (await api<{ channel: { id: number } }>(ayse.token, '/api/channels', { method: 'POST', body: { name: 'oyun', kind: 'text' } })).channel.id
  const film = (await api<{ channel: { id: number } }>(ayse.token, '/api/channels', { method: 'POST', body: { name: 'film', kind: 'text' } })).channel.id
  await open(ayse, GENEL)
  await open(mehmet, oyun)
  await open(zeynep, film)

  for (const page of [ayse.page, mehmet.page, zeynep.page]) {
    await expect(viewer(page, GENEL, ayse.user.id)).toBeVisible()
    await expect(viewer(page, oyun, mehmet.user.id)).toBeVisible()
    await expect(viewer(page, film, zeynep.user.id)).toBeVisible()
    await expect(page.locator('[data-testid^="viewer-"]')).toHaveCount(3)
  }
  await expect(viewer(ayse.page, GENEL, ayse.user.id)).toContainText('(sen)')
  await expect(ayse.page.getByTestId('here-line')).toContainText('Burada: Sen')

  // Mehmet moves to genel: Ayşe sees it within a second.
  const moved = Date.now()
  await open(mehmet, GENEL)
  await expect(viewer(ayse.page, GENEL, mehmet.user.id)).toBeVisible({ timeout: 1500 })
  await expect(viewer(ayse.page, oyun, mehmet.user.id)).toHaveCount(0)
  console.log(`[84] a move reached another page after ${Date.now() - moved} ms`)
  await expect(ayse.page.getByTestId('here-line')).toContainText('Burada: Sen, Mehmet')
  await ayse.page.screenshot({ path: shot('1440') })

  // Zeynep stops looking at the app (another window, the tray): under no channel, still online.
  await setAway(zeynep.page, true)
  await expect(viewer(ayse.page, film, zeynep.user.id)).toHaveCount(0)
  await expect(ayse.page.getByTestId(`member-${zeynep.user.id}`)).toHaveAttribute('data-online', 'true')
  await setAway(zeynep.page, false)
  await expect(viewer(ayse.page, film, zeynep.user.id)).toBeVisible()

  // Mehmet turns "Hangi kanalda olduğumu göster" off: gone everywhere, his own view included.
  await openSettings(mehmet.page, 'hesap')
  await mehmet.page.getByTestId('settings-show-channel').uncheck()
  await expect(viewer(ayse.page, GENEL, mehmet.user.id)).toHaveCount(0)
  await expect(viewer(zeynep.page, GENEL, mehmet.user.id)).toHaveCount(0)
  await expect(viewer(mehmet.page, GENEL, mehmet.user.id)).toHaveCount(0)
  // ...and it stays off after a reload (this device).
  await mehmet.page.reload()
  await expect(mehmet.page.getByTestId('composer')).toBeVisible()
  await mehmet.page.waitForTimeout(1500)
  await expect(viewer(ayse.page, GENEL, mehmet.user.id)).toHaveCount(0)
  await openSettings(mehmet.page, 'hesap')
  await expect(mehmet.page.getByTestId('settings-show-channel')).not.toBeChecked()
  await mehmet.page.getByTestId('settings-show-channel').check()
  await expect(viewer(ayse.page, GENEL, mehmet.user.id)).toBeVisible()

  // Closing the page: gone.
  await zeynep.context.close()
  await expect(viewer(ayse.page, film, zeynep.user.id)).toHaveCount(0)
})

test('fifteen members, six in one channel: the stacked "+n" form, at 1440, 150 % and 390', async ({ browser, trio }) => {
  test.setTimeout(240_000)
  const six = await crowd(browser, trio, 6, WIDE)
  await seedAccounts(GROUP_NAMES.slice(6, 13))
  for (const person of six) await open(person, GENEL)
  // Two more people with their own pages: one at 150 % (1280×820 → 853×547 CSS), one at 390.
  const scaled = trio.add(await personWithSession(browser, GROUP_NAMES[13], await joinFrom(GROUP_NAMES[13]), { viewport: { width: 853, height: 547 }, deviceScaleFactor: 1.5 }))
  const phone = trio.add(
    await personWithSession(browser, GROUP_NAMES[14], await joinFrom(GROUP_NAMES[14]), {
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    }),
  )
  // Everybody opens genel on load: eight there now.
  const page = six[0].page
  const list = page.getByTestId(`channel-viewers-${GENEL}`)
  await expect(list).toHaveAttribute('data-count', '8')
  await expect(page.getByTestId(`channel-viewers-more-${GENEL}`)).toHaveText('+4')
  await expect(page.getByTestId('here-line')).toBeVisible()
  await page.screenshot({ path: shot('stacked-1440') })

  // The two others move to a channel of their own: six left, still "+2".
  const oyun = (await api<{ channel: { id: number } }>(six[0].token, '/api/channels', { method: 'POST', body: { name: 'oyun', kind: 'text' } })).channel.id
  await scaled.page.getByTestId(`channel-${oyun}`).click()
  await openDrawer(phone.page)
  await phone.page.getByTestId(`channel-${oyun}`).tap()
  await expect(list).toHaveAttribute('data-count', '6')
  await expect(page.getByTestId(`channel-viewers-more-${GENEL}`)).toHaveText('+2')
  await expect(page.getByTestId(`channel-viewers-${oyun}`)).toHaveAttribute('data-count', '2')
  await expect(scaled.page.getByTestId(`viewer-${oyun}-${scaled.user.id}`)).toBeVisible()
  await scaled.page.screenshot({ path: shot('150') })
  await openDrawer(phone.page)
  await expect(phone.page.getByTestId(`channel-viewers-${GENEL}`)).toHaveAttribute('data-count', '6')
  await expect(phone.page.getByTestId(`viewer-${oyun}-${phone.user.id}`)).toBeVisible()
  await phone.page.screenshot({ path: shot('390') })
})
