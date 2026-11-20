/**
 * CONTRACT-V11-ADDRESS §2–§3: a server with a canonical address
 * (TRIO_PUBLIC_URL = http://127.0.0.1:<port>) reached through its OLD one
 * (http://localhost:<port>): the band, one tap, the confirmation screen on the
 * new address, preferences carried, the old session ended, "Bu cihaz taşındı"
 * back on the old address, a signed-out visitor forwarded with their invite.
 */
import path from 'node:path'
import { E2E_DIR, freshServer, INVITE_CODE } from '../lib/server'
import { localhost, loopback, meStatus, signInOn, storage } from '../lib/address'
import { apiJoin, expect, expectConnected, newContext, test, type ContextOptions } from '../lib/trio'

const OUT = path.join(E2E_DIR, 'screenshots')
const PHONE: ContextOptions = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
const DESKTOP: ContextOptions = { viewport: { width: 1440, height: 900 } }

test.beforeEach(async () => {
  await freshServer({ TRIO_PUBLIC_URL: loopback(), TRIO_TEST_HTTP_PUBLIC_URL: '1' })
})

for (const [label, options] of [
  ['1440', DESKTOP],
  ['390', PHONE],
] as const) {
  test(`a signed-in device moves with one tap (${label})`, async ({ browser }) => {
    const ayse = await apiJoin('Ayşe')
    const context = await newContext(browser, options)
    const old = await signInOn(context, localhost(), ayse, {
      'trio.v10.membersHidden': '1',
      'trio.lastName': 'Ayşe',
      'trio.drafts': '{"x":1}',
    })
    const band = old.getByTestId('address-band')
    await expect(band).toBeVisible()
    await expect(band).toContainText('Trio yeni adrese taşındı')
    await expect(band).toHaveAttribute('data-host', `127.0.0.1:${new URL(loopback()).port}`)
    await old.screenshot({ path: path.join(OUT, `v11-address-band-${label}.png`), animations: 'disabled' })

    const requested: string[] = []
    old.on('request', (r) => requested.push(r.url()))
    await old.getByTestId('address-move').click()
    // The same tab is now on the canonical address, the code already out of the address bar.
    await expect(old.getByTestId('move-arrival-who')).toContainText('Ayşe')
    await expect.poll(() => old.url()).toBe(`${loopback()}/`)
    // The code went to no server in a URL.
    expect(requested.filter((u) => u.includes('tasi=') && !u.startsWith(loopback() + '/#'))).toEqual([])
    await old.screenshot({ path: path.join(OUT, `v11-address-arrival-${label}.png`), animations: 'disabled' })
    await old.getByTestId('move-arrival-go').click()
    await expectConnected(old)

    // Carried: the allowlisted preferences; a new token, never the old one.
    expect(await storage(old, 'trio.v10.membersHidden')).toBe('1')
    expect(await storage(old, 'trio.drafts')).toBe('{"x":1}')
    const token = await storage(old, 'trio.token')
    expect(token).not.toBeNull()
    expect(token).not.toBe(ayse.token)
    // The old session is ended once the new one is confirmed.
    await expect.poll(() => meStatus(loopback(), ayse.token)).toBe(401)
    await expect(old.getByTestId('address-band')).toHaveCount(0)

    // Back on the old address: "Bu cihaz taşındı", and the carried preferences are gone there.
    const back = await context.newPage()
    await back.goto(`${localhost()}/`)
    const moved = back.getByTestId('address-moved')
    await expect(moved).toHaveAttribute('data-moved', 'device')
    await expect(moved).toContainText('Bu cihaz taşındı')
    await expect.poll(() => storage(back, 'trio.drafts')).toBeNull()
    await expect(back.getByTestId('address-band')).toHaveCount(0)
    await back.screenshot({ path: path.join(OUT, `v11-address-moved-${label}.png`), animations: 'disabled' })
    await context.close()
  })
}

test('a signed-out visitor on the old address is forwarded with the invite', async ({ browser }) => {
  const context = await newContext(browser, PHONE)
  const page = await context.newPage()
  await page.goto(`${localhost()}/#davet=${encodeURIComponent(INVITE_CODE)}`)
  const moved = page.getByTestId('address-moved')
  await expect(moved).toHaveAttribute('data-moved', 'server')
  const go = page.getByTestId('address-moved-go')
  await expect(go).toHaveAttribute('href', `${loopback()}/#davet=${encodeURIComponent(INVITE_CODE)}`)
  await page.screenshot({ path: path.join(OUT, 'v11-address-forward-390.png'), animations: 'disabled' })
  await go.tap()
  await expect(page.getByTestId('join-code-from-link')).toBeVisible()
  await expect.poll(() => page.url()).toBe(`${loopback()}/`)
  // "Bu adreste devam et" still offers the ordinary join form on the old address.
  const other = await context.newPage()
  await other.goto(`${localhost()}/`)
  await other.getByTestId('address-moved-stay').tap()
  await expect(other.getByTestId('join-form')).toBeVisible()
  await context.close()
})

test('the move only ever goes to the address the server declares', async ({ browser }) => {
  const mehmet = await apiJoin('Mehmet')
  const context = await newContext(browser)
  const old = await signInOn(context, localhost(), mehmet)
  // A tampered answer that names another host: the page rebuilds the address from public_url.
  await old.route('**/api/move', async (route) => {
    const response = await route.fetch()
    const body = (await response.json()) as Record<string, string>
    await route.fulfill({ response, json: { ...body, url: `https://evil.example/#tasi=${body.code}` } })
  })
  const navigations: string[] = []
  old.on('framenavigated', (frame) => {
    if (frame === old.mainFrame()) navigations.push(frame.url())
  })
  await old.getByTestId('address-move').click()
  await expect(old.getByTestId('move-arrival')).toBeVisible()
  expect(navigations.some((u) => u.includes('evil.example'))).toBe(false)
  await old.getByTestId('move-arrival-go').click()
  await expectConnected(old)

  // A pasted move link of somebody ELSE's account names that account and redeems nothing without a tap.
  const zeynep = await apiJoin('Zeynep')
  const made = await fetch(`${localhost()}/api/move`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${zeynep.token}`, 'Content-Type': 'application/json' },
    body: '{}',
  }).then((r) => r.json() as Promise<{ code: string }>)
  const victim = await newContext(browser)
  const page = await victim.newPage()
  await page.goto(`${loopback()}/#tasi=${made.code}`)
  await expect(page.getByTestId('move-arrival-who')).toContainText('Zeynep')
  await page.getByTestId('move-arrival-cancel').click()
  await expect(page.getByTestId('join-form')).toBeVisible()
  expect(await storage(page, 'trio.token')).toBeNull()
  // Signed in as Mehmet on the canonical address, the same link changes nothing.
  const again = await context.newPage()
  await again.goto(`${loopback()}/#tasi=${made.code}`)
  await expect(again.getByTestId('address-notice')).toContainText('Zeynep hesabına ait')
  await expect(again.locator('.user-panel-name')).toContainText('Mehmet')
  await victim.close()
  await context.close()
})
