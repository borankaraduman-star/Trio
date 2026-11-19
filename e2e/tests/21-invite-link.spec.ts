/**
 * Invite links: `<origin>/#davet=<code>`. The code is in the fragment (never
 * sent to the server), taken out of the address bar at once, and shared again
 * from Ayarlar › Hesap.
 */
import { baseUrl, freshServer, INVITE_CODE } from '../lib/server'
import { apiLinkCode, expect, expectConnected, linkedDevice, newContext, test, type Person } from '../lib/trio'
import { settingsTab, startSignOut } from '../lib/v7phone'

test.beforeEach(async () => {
  await freshServer()
})

test('open the link, type only a name, join; the link is shared from settings', async ({ browser, trio }) => {
  const context = await newContext(browser)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseUrl() })
  const page = await context.newPage()
  const requested: string[] = []
  page.on('request', (request) => requested.push(request.url()))

  await page.goto(`/#davet=${encodeURIComponent(INVITE_CODE)}`)
  await expect(page.getByTestId('join-code-from-link')).toContainText('Davet koduyla katılıyorsun')
  await expect(page.getByTestId('join-code')).toHaveCount(0)
  await expect(page.getByTestId('join-name')).toBeFocused()
  // Gone from the address bar straight away.
  expect(await page.evaluate(() => location.href)).toBe(`${baseUrl()}/`)

  await page.keyboard.type('Ayşe')
  const joined = page.waitForResponse((r) => r.url().endsWith('/api/join'))
  await page.getByTestId('join-submit').click()
  const response = await joined
  expect(response.status()).toBe(201)
  const body = (await response.json()) as { token: string; user: { id: number; name: string } }
  await expectConnected(page)
  // The code never went anywhere but the join's own body.
  expect(requested.filter((url) => url.includes(encodeURIComponent(INVITE_CODE)) || url.includes(INVITE_CODE))).toEqual([])

  await page.getByTestId('btn-settings').click()
  await settingsTab(page, 'hesap')
  const link = `${baseUrl()}/#davet=${encodeURIComponent(INVITE_CODE)}`
  await expect(page.getByTestId('invite-link')).toHaveValue(link)
  await expect(page.getByTestId('settings-account')).toContainText('kişi sınırı dolana kadar')
  await page.getByTestId('invite-link-copy').click()
  await expect(page.getByTestId('invite-link-copy')).toHaveText('Kopyalandı')
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link)
  await page.getByTestId('settings-close').click()

  // A device that came in with a device code does not know the invite code.
  const ayse: Person = { name: 'Ayşe', context, page, user: body.user, token: body.token }
  const other = trio.add(await linkedDevice(browser, ayse, await apiLinkCode(body.token)))
  await other.page.getByTestId('btn-settings').click()
  await settingsTab(other.page, 'hesap')
  await expect(other.page.getByTestId('invite-link-unknown')).toBeVisible()
  await expect(other.page.getByTestId('invite-link')).toHaveCount(0)

  // Signing out forgets the code, and remembers the name for next time.
  await startSignOut(page)
  await page.getByTestId('logout-confirm').click()
  await expect(page.getByTestId('join-form')).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('trio.invite'))).toBeNull()
  await page.getByTestId('join-mode-invite').click()
  await expect(page.getByTestId('join-name')).toHaveValue('Ayşe')
  await context.close()
})

test('a wrong code from a link falls back to the ordinary form with the ordinary error', async ({ browser }) => {
  const context = await newContext(browser)
  const page = await context.newPage()
  await page.goto('/#x=1&invite=eski-kod')
  await expect(page.getByTestId('join-code-from-link')).toBeVisible()
  // The invite is taken out; whatever else the fragment held stays.
  expect(await page.evaluate(() => location.hash)).toBe('#x=1')
  await page.getByTestId('join-name').fill('Mehmet')
  await page.getByTestId('join-submit').click()
  await expect(page.getByTestId('join-error')).toHaveText('Davet kodu yanlış.')
  await expect(page.getByTestId('join-code-from-link')).toHaveCount(0)
  await page.getByTestId('join-code').fill(INVITE_CODE)
  await page.getByTestId('join-submit').click()
  await expectConnected(page)
  await context.close()
})
