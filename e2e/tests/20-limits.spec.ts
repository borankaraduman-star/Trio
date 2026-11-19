/**
 * CONTRACT-V3 §5, §6 and the desktop shell: what the join screen says under
 * the join limits, a user with too many sockets open, and the desktop app's
 * join screen.
 */
import { baseUrl, freshServer, INVITE_CODE } from '../lib/server'
import { apiJoin, expect, expectConnected, joinThroughUi, newContext, test } from '../lib/trio'

test.beforeEach(async () => {
  await freshServer()
})

async function wrongJoin(forwardedFor?: string): Promise<number> {
  const response = await fetch(`${baseUrl()}/api/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(forwardedFor ? { 'X-Forwarded-For': forwardedFor } : {}) },
    body: JSON.stringify({ invite_code: 'yanlis', name: 'Yabancı' }),
  })
  return response.status
}

test('too many wrong invite codes from one address: when to try again, in Turkish', async ({ browser }) => {
  const context = await newContext(browser)
  const page = await context.newPage()
  await page.goto('/')
  // Ten attempts per address per 10 minutes, right or wrong; this browser is the same address.
  for (let i = 0; i < 9; i += 1) expect(await wrongJoin()).toBe(403)
  await joinThroughUi(page, 'Ayşe', 'yanlis-kod')
  await expect(page.getByTestId('join-error')).toHaveText('Davet kodu yanlış.')
  await joinThroughUi(page, 'Ayşe', INVITE_CODE)
  await expect(page.getByTestId('join-error')).toHaveText(/^Çok fazla deneme yapıldı\. (9|10) dakika sonra tekrar dene\.$/)
  await expect(page.getByTestId('join-submit')).toBeDisabled()
  // The other mode is held by the same wait.
  await page.getByTestId('join-mode-link').click()
  await page.getByTestId('join-link-code').fill('K7QX3MZ9PA')
  await expect(page.getByTestId('join-submit')).toBeDisabled()
  await context.close()
})

test('the global ceiling on failures: a few seconds, counted down, then the right code gets in', async ({ browser }) => {
  // Thirty failures from thirty addresses (the server trusts one proxy hop),
  // then one more that uses up the ten-second trickle.
  for (let i = 1; i <= 30; i += 1) expect(await wrongJoin(`10.0.0.${i}`)).toBe(403)
  expect(await wrongJoin('10.0.1.1')).toBe(403)

  const context = await newContext(browser)
  const page = await context.newPage()
  await page.goto('/')
  const answer = page.waitForResponse((r) => r.url().endsWith('/api/join'))
  await joinThroughUi(page, 'Ayşe', INVITE_CODE)
  const refused = await answer
  expect(refused.status()).toBe(429)
  const wait = Number(refused.headers()['retry-after'])
  expect(wait).toBeGreaterThanOrEqual(1)
  expect(wait).toBeLessThanOrEqual(10)
  const error = page.getByTestId('join-error')
  await expect(error).toHaveText(/^Çok fazla deneme yapıldı\. \d+ saniye sonra tekrar dene\.$/)
  await expect(page.getByTestId('join-submit')).toBeDisabled()
  // It counts down, and lets the person try once the server said they could.
  await expect(error).toHaveText('Çok fazla deneme yapılmıştı; şimdi tekrar deneyebilirsin.', { timeout: (wait + 3) * 1000 })
  await expect(page.getByTestId('join-submit')).toBeEnabled()
  const joined = page.waitForResponse((r) => r.url().endsWith('/api/join'))
  await page.getByTestId('join-submit').click()
  expect((await joined).status()).toBe(201)
  await expectConnected(page)
  await context.close()
})

test('too many sockets for one user (4429): told why, and connected once one closes', async ({ browser }) => {
  test.setTimeout(60_000)
  const session = await apiJoin('Ayşe')
  // Ten sockets of hers are open elsewhere (CONTRACT-V3 §6 allows ten).
  const others: WebSocket[] = []
  for (let i = 0; i < 10; i += 1) {
    const ws = new WebSocket(`${baseUrl().replace('http', 'ws')}/ws?token=${encodeURIComponent(session.token)}`)
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('message', () => resolve(), { once: true })
      ws.addEventListener('close', (event) => reject(new Error(`socket ${i} closed ${event.code}`)), { once: true })
    })
    others.push(ws)
  }

  const context = await newContext(browser)
  await context.addInitScript(
    ([token, user]) => {
      if (!sessionStorage.getItem('seeded')) {
        sessionStorage.setItem('seeded', '1')
        localStorage.setItem('trio.token', token)
        localStorage.setItem('trio.user', user)
      }
    },
    [session.token, JSON.stringify(session.user)] as const,
  )
  const page = await context.newPage()
  await page.goto('/')
  await expect(page.getByTestId('connection-banner')).toContainText('Çok fazla sekme ya da cihaz açık', { timeout: 15_000 })
  // Still signed in: a 4429 is a drop, not a sign-out.
  expect(await page.evaluate(() => localStorage.getItem('trio.token'))).toBe(session.token)

  others.pop()?.close()
  await expectConnected(page)
  await expect(page.getByTestId('connection-banner')).toHaveCount(0)
  for (const ws of others) ws.close()
  await context.close()
})

test('the desktop app leads with "Zaten hesabım var" and says it is a separate device', async ({ browser }) => {
  const context = await newContext(browser)
  // What desktop/'s preload exposes (CONTRACT-V2 §5).
  await context.addInitScript(() => {
    ;(window as unknown as { trioDesktop: unknown }).trioDesktop = {
      isDesktop: true,
      setPttKey: () => undefined,
      onPtt: () => () => undefined,
    }
  })
  const page = await context.newPage()
  await page.goto('/')
  await expect(page.getByTestId('join-form')).toHaveAttribute('data-mode', 'link')
  await expect(page.getByTestId('join-desktop-hint')).toContainText('ayrı bir cihaz sayılır')
  await expect(page.getByTestId('join-link-code')).toBeFocused()
  // A new account is still one tap away.
  await page.getByTestId('join-mode-invite').click()
  await expect(page.getByTestId('join-name')).toBeVisible()
  await context.close()

  // In a plain browser the join screen opens on the invite form, as before.
  const plain = await newContext(browser)
  const other = await plain.newPage()
  await other.goto('/')
  await expect(other.getByTestId('join-form')).toHaveAttribute('data-mode', 'invite')
  await expect(other.getByTestId('join-desktop-hint')).toHaveCount(0)
  await plain.close()
})
