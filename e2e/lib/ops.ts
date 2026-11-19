/** Helpers of the owner / operations specs (40–44, CONTRACT-V6-OPS). */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import type { Browser, Page } from '@playwright/test'
import { baseUrl, readState, python } from './server'
import { expect, personViaApi, type ContextOptions, type Person } from './trio'
import { submitComposer } from './messages'

export const PHONE: ContextOptions = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
export const DESKTOP: ContextOptions = { viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 }
export const SCREENSHOTS = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'screenshots')

export function isPhone(page: Page): boolean {
  return (page.viewportSize()?.width ?? 1280) <= 480
}

/** Ayşe (the owner: she joins first), Mehmet and Zeynep, each with their own viewport. */
export async function people(
  browser: Browser,
  trio: { add: (p: Person) => Person },
  options: [ContextOptions, ContextOptions, ContextOptions] = [DESKTOP, DESKTOP, DESKTOP],
): Promise<[Person, Person, Person]> {
  const ayse = trio.add(await personViaApi(browser, 'Ayşe', options[0]))
  const mehmet = trio.add(await personViaApi(browser, 'Mehmet', options[1]))
  const zeynep = trio.add(await personViaApi(browser, 'Zeynep', options[2]))
  return [ayse, mehmet, zeynep]
}

export async function openSettings(page: Page): Promise<void> {
  if (isPhone(page)) await page.getByTestId('btn-drawer').tap()
  const button = page.getByTestId('btn-settings')
  if (isPhone(page)) await button.tap()
  else await button.click()
  await expect(page.getByTestId('settings-dialog')).toBeVisible()
  await expect(page.getByTestId('storage-section')).toBeVisible()
}

export async function closeSettings(page: Page): Promise<void> {
  await page.getByTestId('settings-close').click()
  await expect(page.getByTestId('settings-dialog')).toHaveCount(0)
}

/** Upload files through the composer and send them with a caption. */
export async function sendFiles(person: Person, caption: string, files: { name: string; mimeType: string; buffer: Buffer }[]): Promise<void> {
  const page = person.page
  await page.getByTestId('file-input').setInputFiles(files)
  await expect(page.getByTestId('pending-attachment')).toHaveCount(files.length)
  for (let i = 0; i < files.length; i += 1) {
    await expect(page.getByTestId('pending-attachment').nth(i)).toHaveAttribute('data-status', 'done')
  }
  await page.getByTestId('composer').fill(caption)
  await submitComposer(page)
  await expect(page.getByTestId('pending-attachment')).toHaveCount(0)
  await expect(page.getByTestId('message').filter({ hasText: caption }).last()).toHaveAttribute('data-status', 'sent')
}

export async function status(token: string | null, method: string, urlPath: string, body?: unknown): Promise<number> {
  const response = await fetch(`${baseUrl()}${urlPath}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return response.status
}

/** `python -m trio_server.backup verify <archive>`; its stdout (throws on a failed check). */
export function verifyArchive(archive: string): string {
  const state = readState()
  return execFileSync(python(), ['-m', 'trio_server.backup', 'verify', archive], {
    cwd: state.serverDir,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    encoding: 'utf8',
  })
}

/** No horizontal scroll at phone width. */
export async function expectNoSideScroll(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()?.width ?? 390)
  const dialog = page.getByTestId('settings-dialog')
  if (await dialog.count()) {
    expect(await dialog.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0)
  }
}
