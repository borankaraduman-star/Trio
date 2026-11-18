import { freshServer } from '../lib/server'
import { expect, expectConnected, expectHearing, joinThroughUi, newContext, personViaApi, SOHBET, GENEL, test } from '../lib/trio'

test.beforeEach(async () => {
  await freshServer()
})

const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }

test('phone width: join, open the drawer, send a message, join voice', async ({ browser, trio }) => {
  const ayse = trio.add(await personViaApi(browser, 'Ayşe'))
  await ayse.page.getByTestId(`channel-${SOHBET}`).click()

  const context = await newContext(browser, PHONE)
  const page = await context.newPage()
  trio.add({ name: 'Mehmet', context, page, user: { id: 0, name: 'Mehmet' }, token: '' })
  await page.goto('/')
  // Nothing on the join screen is wider than the phone.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await joinThroughUi(page, 'Mehmet')
  await expectConnected(page)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)

  // The sidebar is a closed drawer and the member list is hidden.
  const sidebar = page.locator('nav.sidebar')
  await expect(sidebar).not.toBeInViewport()
  await expect(page.locator('aside.members')).toBeHidden()

  // Send a message from the phone (with the drawer closed).
  await page.getByTestId('composer').tap()
  await page.getByTestId('composer').fill('telefondan selam')
  await page.getByTestId('composer-send').tap()
  await expect(ayse.page.getByTestId('message').last()).toContainText('telefondan selam')
  await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'sent')
  // The composer and the send button are fully on screen.
  await expect(page.getByTestId('composer')).toBeInViewport({ ratio: 1 })
  await expect(page.getByTestId('composer-send')).toBeInViewport({ ratio: 1 })

  // Open the drawer; it covers the chat, and choosing a channel closes it.
  await page.getByTestId('btn-drawer').tap()
  await expect(sidebar).toBeInViewport({ ratio: 0.99 })
  await page.getByTestId(`channel-${GENEL}`).tap()
  await expect(sidebar).not.toBeInViewport()

  // Join voice from the drawer; the user panel's buttons are reachable.
  await page.getByTestId('btn-drawer').tap()
  await page.getByTestId(`channel-${SOHBET}`).tap()
  await expect(page.locator('.voice-status strong')).toHaveText('Ses bağlı')
  for (const id of ['btn-mute', 'btn-deafen', 'btn-screen', 'btn-hangup']) {
    await expect(page.getByTestId(id)).toBeInViewport({ ratio: 1 })
  }
  await expect(page.locator('[data-testid^="voice-user-"]')).toHaveCount(2)
  await expect(ayse.page.locator('[data-testid^="voice-user-"]')).toHaveCount(2)
  const user = await page.evaluate(() => JSON.parse(localStorage.getItem('trio.user')!))
  const mehmet = { name: 'Mehmet', context, page, user, token: '' }
  await expectHearing(mehmet, ayse)
  await expectHearing(ayse, mehmet)

  // The backdrop closes the drawer.
  await page.locator('.backdrop').tap({ position: { x: 370, y: 400 } })
  await expect(sidebar).not.toBeInViewport()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
})
