/**
 * CONTRACT-V11-ADDRESS in the browser. The suite serves ONE server; two
 * ORIGINS of it are http://127.0.0.1:<port> and http://localhost:<port>
 * (localStorage, the token and every preference are per origin). The server
 * accepts an http canonical address only with TRIO_TEST_HTTP_PUBLIC_URL=1.
 */
import type { BrowserContext, Page } from '@playwright/test'
import { readState } from './server'
import { expect, type User } from './trio'

export function loopback(): string {
  return `http://127.0.0.1:${readState().port}`
}

export function localhost(): string {
  return `http://localhost:${readState().port}`
}

/** Sign a context in on `origin` by writing the stored session there, then open it. */
export async function signInOn(
  context: BrowserContext,
  origin: string,
  session: { token: string; user: User },
  extra: Record<string, string> = {},
): Promise<Page> {
  const page = await context.newPage()
  await page.goto(`${origin}/indir`)
  await page.evaluate(
    ([token, user, more]) => {
      localStorage.setItem('trio.token', token)
      localStorage.setItem('trio.user', user)
      for (const [k, v] of Object.entries(JSON.parse(more) as Record<string, string>)) localStorage.setItem(k, v)
    },
    [session.token, JSON.stringify(session.user), JSON.stringify(extra)] as const,
  )
  await page.goto(`${origin}/`)
  await expect(page.getByTestId('composer')).toBeVisible()
  return page
}

export async function storage(page: Page, key: string): Promise<string | null> {
  return page.evaluate((k) => localStorage.getItem(k), key)
}

export async function meStatus(origin: string, token: string): Promise<number> {
  const response = await fetch(`${origin}/api/me`, { headers: { Authorization: `Bearer ${token}` } })
  return response.status
}
