/**
 * CONTRACT-V3 §2: a second device for an existing account (link codes), and
 * signing one device out without touching the account or the other devices.
 */
import { sql } from '../lib/db'
import { freshServer, INVITE_CODE, baseUrl } from '../lib/server'
import {
  apiJoin,
  apiLinkCode,
  expect,
  expectConnected,
  joinWithCodeThroughUi,
  linkedDevice,
  meStatus,
  newContext,
  personWithSession,
  sendThroughUi,
  test,
  threePeople,
} from '../lib/trio'

const INVALID_LINK_CODE = 'Bu kod geçersiz'

test.beforeEach(async () => {
  await freshServer()
})

test('add a device: the code in settings signs a fourth browser in as the SAME user', async ({ browser, trio }) => {
  const [ayse, mehmet] = await threePeople(browser, trio)
  await sendThroughUi(ayse, 'Akşam kim var?')
  await sendThroughUi(mehmet, 'Ben varım')

  // Ayşe makes a code in Ayarlar › Hesap.
  await ayse.page.getByTestId('btn-settings').click()
  const account = ayse.page.getByTestId('settings-account')
  await expect(account).toContainText('Ayşe')
  await account.getByTestId('settings-add-device').click()
  const shown = (await account.getByTestId('link-code').textContent()) ?? ''
  expect(shown).toMatch(/^[2-9A-HJKMNP-Z]{5}-[2-9A-HJKMNP-Z]{5}$/)
  await expect(account).toContainText('Zaten hesabım var')
  const countdown = account.getByTestId('link-code-countdown')
  await expect(countdown).toHaveText(/^(10:00|9:5\d)$/)
  const first = await countdown.textContent()
  await expect(countdown).not.toHaveText(first ?? '', { timeout: 3000 })

  // A fourth browser types it forgivingly (lower case, a space instead of the dash).
  const typed = shown.toLowerCase().replace('-', ' ')
  const laptop = trio.add(await linkedDevice(browser, ayse, typed))
  await expect(laptop.page.locator('.user-panel-name strong')).toHaveText('Ayşe')
  expect(await laptop.page.evaluate(() => JSON.parse(localStorage.getItem('trio.user') ?? 'null'))).toEqual(ayse.user)
  // The history is there, and it is hers.
  await expect(laptop.page.getByTestId('message')).toHaveCount(2)
  await expect(laptop.page.getByTestId('message').first()).toHaveAttribute('data-author-id', String(ayse.user.id))
  // No new member: the others still see three.
  await expect(mehmet.page.locator('[data-testid^="member-"]')).toHaveCount(3)

  // Both of her devices get new messages, and what one sends the other shows as hers.
  await sendThroughUi(mehmet, 'Pizza söyleyelim mi?')
  for (const device of [ayse, laptop]) {
    await expect(device.page.getByTestId('message').filter({ hasText: 'Pizza söyleyelim mi?' })).toHaveCount(1)
  }
  await sendThroughUi(laptop, 'Olur, ben söylerim')
  await expect(ayse.page.getByTestId('message').filter({ hasText: 'Olur, ben söylerim' })).toHaveAttribute(
    'data-author-id',
    String(ayse.user.id),
  )

  // A used code is refused, with words, and stores nothing.
  const stranger = await newContext(browser)
  const page = await stranger.newPage()
  await page.goto('/')
  const reused = await joinWithCodeThroughUi(page, shown)
  expect(reused.status()).toBe(403)
  await expect(page.getByTestId('join-error')).toContainText(INVALID_LINK_CODE)
  expect(await page.evaluate(() => localStorage.getItem('trio.token'))).toBeNull()

  // An expired code is refused the same way. The server's clock cannot be
  // moved, so the code's expiry is moved into the past in its database.
  const expired = await apiLinkCode(ayse.token)
  sql('UPDATE link_codes SET expires_ts = 0 WHERE user_id = ?', [ayse.user.id])
  const late = await joinWithCodeThroughUi(page, expired)
  expect(late.status()).toBe(403)
  await expect(page.getByTestId('join-error')).toContainText(INVALID_LINK_CODE)
  // A typo that cannot be a code is caught before it costs an attempt.
  await page.getByTestId('join-link-code').fill('K0QX3-MZ9OA')
  await expect(page.getByTestId('join-error')).toContainText('0 O')
  await expect(page.getByTestId('join-submit')).toBeDisabled()
  await stranger.close()

  // Five unused codes at once is the limit; the sixth is explained.
  for (let i = 0; i < 4; i += 1) await apiLinkCode(ayse.token)
  await account.getByTestId('settings-add-device').click() // the fifth, through the UI
  await expect(account.getByTestId('link-code')).not.toHaveText(shown)
  await account.getByTestId('settings-add-device').click()
  await expect(account.getByTestId('link-code-error')).toContainText('kullanılmamış 5 kodun var')
})

test('sign out: confirm, the token stops working, the other device stays, the name is not burnt', async ({ browser, trio }) => {
  const [ayse, mehmet] = await threePeople(browser, trio)
  const phone = trio.add(await linkedDevice(browser, ayse, await apiLinkCode(ayse.token)))

  // A second socket of the phone's token, to see the server close it.
  await phone.page.evaluate((token) => {
    const ws = new WebSocket(`ws://${location.host}/ws?token=${encodeURIComponent(token)}`)
    ;(window as unknown as { __closed: number | null }).__closed = null
    ws.onclose = (event) => ((window as unknown as { __closed: number }).__closed = event.code)
  }, phone.token)

  // The dialog says what happens, truthfully, and offers a code first.
  await phone.page.getByTestId('btn-logout').click()
  const dialog = phone.page.getByTestId('logout-dialog')
  await expect(dialog).toContainText('Bu cihazdan çıkış yapılsın mı?')
  await expect(dialog).toContainText('Hesabın, adın (Ayşe) ve mesajların silinmez')
  await expect(dialog).toContainText('farklı bir adla yeni bir hesap')
  await dialog.getByTestId('logout-cancel').click()
  await expect(dialog).toHaveCount(0)
  await expectConnected(phone.page)

  // The safe path: make a code first (it opens Ayarlar › Hesap with one made).
  await phone.page.getByTestId('btn-logout').click()
  await dialog.getByTestId('logout-code-first').click()
  const account = phone.page.getByTestId('settings-account')
  const code = (await account.getByTestId('link-code').textContent()) ?? ''
  expect(code).toMatch(/^\w{5}-\w{5}$/)
  await account.getByTestId('settings-sign-out').click()
  const signedOut = phone.page.waitForResponse((r) => r.url().endsWith('/api/session') && r.request().method() === 'DELETE')
  await dialog.getByTestId('logout-confirm').click()
  expect((await signedOut).status()).toBe(204)

  // This device: the join screen, nothing remembered, no "ended elsewhere" notice.
  await expect(phone.page.getByTestId('join-form')).toBeVisible()
  await expect(phone.page.getByTestId('join-notice')).toHaveCount(0)
  expect(await phone.page.evaluate(() => localStorage.getItem('trio.token'))).toBeNull()
  // The token no longer works for REST, and its other socket was closed with 4401.
  expect(await meStatus(phone.token)).toBe(401)
  await expect.poll(() => phone.page.evaluate(() => (window as unknown as { __closed: number | null }).__closed)).toBe(4401)

  // Her other device is still signed in and talking.
  expect(await meStatus(ayse.token)).toBe(200)
  await expectConnected(ayse.page)
  await sendThroughUi(ayse, 'Telefondan çıktım, buradayım')
  await expect(mehmet.page.getByTestId('message').filter({ hasText: 'Telefondan çıktım' })).toHaveCount(1)

  // The name is still hers: nobody can take it with the invite code.
  const taken = await fetch(`${baseUrl()}/api/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ invite_code: INVITE_CODE, name: 'ayşe' }),
  })
  expect(taken.status).toBe(409)

  // And the code made before signing out brings the phone back as the same Ayşe.
  const back = await joinWithCodeThroughUi(phone.page, code)
  expect(back.status()).toBe(200)
  expect(((await back.json()) as { user: unknown }).user).toEqual(ayse.user)
  await expectConnected(phone.page)
  await expect(phone.page.getByTestId('message').filter({ hasText: 'Telefondan çıktım' })).toHaveCount(1)
})

test('sign out still clears this device when the server answers 401', async ({ browser, trio }) => {
  const session = await apiJoin('Ayşe')
  const ayse = trio.add(await personWithSession(browser, 'Ayşe', session))
  // As if the token had been signed out elsewhere a moment ago.
  await ayse.page.route('**/api/session', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'missing or invalid token' } }),
    }),
  )
  await ayse.page.getByTestId('btn-logout').click()
  await ayse.page.getByTestId('logout-confirm').click()
  await expect(ayse.page.getByTestId('join-form')).toBeVisible()
  await expect(ayse.page.getByTestId('join-notice')).toHaveCount(0)
  expect(await ayse.page.evaluate(() => localStorage.getItem('trio.token'))).toBeNull()
})
