/**
 * CONTRACT-V7-PHONE §2: where the member column is hidden, who is online and
 * who is in which voice room is in the sidebar (the drawer on a phone), and a
 * phone's header carries a pill with the online count that opens it.
 */
import path from 'node:path'
import { freshServer } from '../lib/server'
import { expect, joinVoice, personViaApi, SOHBET, test } from '../lib/trio'
import { DESKTOP, PHONE, SCREENSHOTS } from '../lib/v7phone'

test.beforeEach(async () => {
  await freshServer()
})

test('phone: the header pill counts who is online and opens the drawer on the people, with their voice rooms', async ({ browser, trio }) => {
  const ayse = trio.add(await personViaApi(browser, 'Ayşe', DESKTOP))
  const zeynep = trio.add(await personViaApi(browser, 'Zeynep', DESKTOP))
  const mehmet = trio.add(await personViaApi(browser, 'Mehmet', PHONE))
  const page = mehmet.page

  const pill = page.getByTestId('presence-pill')
  await expect(pill).toHaveAttribute('data-online', '3')
  // Zeynep goes away: the count follows the server's presence.
  await zeynep.context.close()
  await expect(pill).toHaveAttribute('data-online', '2')
  const box = (await pill.boundingBox())!
  expect(box.height).toBeGreaterThanOrEqual(44)
  await expect(page.locator('aside.members')).toBeHidden()

  await joinVoice(ayse)
  await pill.tap()
  await expect(page.locator('nav.sidebar')).toBeInViewport({ ratio: 0.99 })
  const presence = page.getByTestId('drawer-presence')
  await expect(presence).toBeInViewport()

  const ayseRow = page.getByTestId(`drawer-member-${ayse.user.id}`)
  await expect(ayseRow).toHaveAttribute('data-online', 'true')
  await expect(ayseRow).toHaveAttribute('data-voice-channel', String(SOHBET))
  await expect(ayseRow).toContainText('Sohbet')
  await expect(page.getByTestId(`drawer-member-${mehmet.user.id}`)).toHaveAttribute('data-voice-channel', '')
  await expect(page.getByTestId(`drawer-member-${zeynep.user.id}`)).toHaveAttribute('data-online', 'false')
  await expect(presence).toContainText('Çevrimiçi — 2')
  await expect(presence).toContainText('Çevrimdışı — 1')
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.screenshot({ path: path.join(SCREENSHOTS, 'v7-phone-presence.png') })

  // Leaving the room shows at once.
  await ayse.page.getByTestId('btn-hangup').click()
  await expect(ayseRow).toHaveAttribute('data-voice-channel', '')
})

test('a tablet width without the member column shows presence in the sidebar; a wide screen keeps the column', async ({ browser, trio }) => {
  const ayse = trio.add(await personViaApi(browser, 'Ayşe', DESKTOP))
  const tablet = trio.add(await personViaApi(browser, 'Mehmet', { viewport: { width: 820, height: 900 } }))
  await expect(tablet.page.locator('aside.members')).toBeHidden()
  await expect(tablet.page.getByTestId('drawer-presence')).toBeAttached()
  await expect(tablet.page.getByTestId(`drawer-member-${ayse.user.id}`)).toHaveAttribute('data-online', 'true')
  // No header pill: the sidebar is always on screen at this width.
  await expect(tablet.page.getByTestId('presence-pill')).toHaveCount(0)

  await expect(ayse.page.locator('aside.members')).toBeVisible()
  await expect(ayse.page.getByTestId('drawer-presence')).toHaveCount(0)
  await expect(ayse.page.getByTestId('presence-pill')).toHaveCount(0)
})
