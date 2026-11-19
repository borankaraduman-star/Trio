/**
 * CONTRACT-V5: game status. Ayşe's page gets a fake desktop bridge
 * (`window.trioDesktop.onGameStatus`, what desktop/'s preload exposes); the
 * test pushes statuses through it the way the main process would, and checks
 * what the other two see under her name.
 */
import path from 'node:path'
import type { BrowserContext, Page } from '@playwright/test'
import { E2E_DIR, freshServer, restartServer } from '../lib/server'
import { expect, expectConnected, joinVoice, personViaApi, test, type ContextOptions, type Person } from '../lib/trio'

test.beforeEach(async () => {
  await freshServer()
})

/** The desktop preload's bridge, with a handle for the test to push statuses. */
async function fakeDesktop(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const w = window as unknown as {
      trioDesktop: unknown
      __game: { cb: ((s: unknown) => void) | null; last: unknown; subscriptions: number }
    }
    w.__game = { cb: null, last: undefined, subscriptions: 0 }
    w.trioDesktop = {
      isDesktop: true,
      setPttKey: () => undefined,
      onPtt: () => () => undefined,
      gameStatus: { supported: true },
      onGameStatus(cb: (s: unknown) => void) {
        w.__game.cb = cb
        w.__game.subscriptions++
        // The main process answers a subscription with the current status.
        if (w.__game.last !== undefined) setTimeout(() => cb(w.__game.last), 0)
        return () => {
          if (w.__game.cb === cb) w.__game.cb = null
        }
      },
    }
  })
}

async function push(page: Page, status: unknown): Promise<void> {
  await page.evaluate((s) => {
    const g = (window as unknown as { __game: { cb: ((s: unknown) => void) | null; last: unknown } }).__game
    g.last = s
    g.cb?.(s)
  }, status)
}

function wow(zone: string, level = 37) {
  return {
    game: 'WoW Forever',
    since: Math.floor(Date.now() / 1000) - 80 * 60,
    detail: { character: 'Kahve Kokusu', realm: '', level, class: 'ROGUE', zone, subzone: 'Valley of Strength', source: 'log' },
  }
}

async function people(browser: import('@playwright/test').Browser, trio: { add: (p: Person) => Person }, options: ContextOptions = {}) {
  const ayse = trio.add(await personViaApi(browser, 'Ayşe', { ...options, prepare: fakeDesktop }))
  const mehmet = trio.add(await personViaApi(browser, 'Mehmet', options))
  const zeynep = trio.add(await personViaApi(browser, 'Zeynep', options))
  return [ayse, mehmet, zeynep] as const
}

const line = (viewer: Person, subject: Person) => viewer.page.getByTestId(`member-activity-${subject.user.id}`)

test('game status: appears, changes and clears for everyone; shows on the voice row', async ({ browser, trio }) => {
  const [ayse, mehmet, zeynep] = await people(browser, trio)
  for (const viewer of [ayse, mehmet, zeynep]) await expect(line(viewer, ayse)).toHaveCount(0)

  await push(ayse.page, wow('Orgrimmar'))
  for (const viewer of [ayse, mehmet, zeynep]) {
    await expect(line(viewer, ayse)).toHaveText('WoW Forever · 37 · Orgrimmar')
  }
  const tip = await line(mehmet, ayse).getAttribute('title')
  expect(tip).toContain('Kahve Kokusu · 37. seviye · Haydut')
  expect(tip).toContain('Orgrimmar › Valley of Strength')
  expect(tip).toContain('1 sa 20 dk oynuyor')

  await push(ayse.page, wow('Durotar', 38))
  for (const viewer of [mehmet, zeynep]) await expect(line(viewer, ayse)).toHaveText('WoW Forever · 38 · Durotar')

  // A process-only status (no addon): just the game.
  await push(ayse.page, { game: 'Counter-Strike 2', since: Math.floor(Date.now() / 1000) })
  await expect(line(zeynep, ayse)).toHaveText('Counter-Strike 2')

  // In a voice room the line is on the participant row too.
  await push(ayse.page, wow('Orgrimmar'))
  await joinVoice(ayse)
  await expect(mehmet.page.getByTestId(`voice-activity-${ayse.user.id}`)).toHaveText('WoW Forever · 37 · Orgrimmar')

  // Out of the game: nothing.
  await push(ayse.page, null)
  for (const viewer of [ayse, mehmet, zeynep]) await expect(line(viewer, ayse)).toHaveCount(0)
  await expect(mehmet.page.getByTestId(`voice-activity-${ayse.user.id}`)).toHaveCount(0)
})

test('game status: "Oyun durumumu paylaş" off clears it and sends nothing; on again resumes', async ({ browser, trio }) => {
  const [ayse, mehmet] = await people(browser, trio)
  await push(ayse.page, wow('Orgrimmar'))
  await expect(line(mehmet, ayse)).toHaveText('WoW Forever · 37 · Orgrimmar')

  await ayse.page.getByTestId('btn-settings').click()
  const share = ayse.page.getByTestId('settings-game-share')
  await expect(share).toBeChecked()
  await share.uncheck()
  await expect(line(mehmet, ayse)).toHaveCount(0)
  // The desktop keeps reporting; nothing reaches the others.
  await push(ayse.page, wow('Durotar'))
  await ayse.page.waitForTimeout(1500)
  await expect(line(mehmet, ayse)).toHaveCount(0)
  // It survives a reload (stored on this device).
  await ayse.page.reload()
  await expectConnected(ayse.page)
  await push(ayse.page, wow('Mulgore'))
  await ayse.page.waitForTimeout(1500)
  await expect(line(mehmet, ayse)).toHaveCount(0)

  await ayse.page.getByTestId('btn-settings').click()
  await ayse.page.getByTestId('settings-game-share').check()
  await expect(line(mehmet, ayse)).toHaveText('WoW Forever · 37 · Mulgore')
})

test('game status survives a server restart (the page sends it again)', async ({ browser, trio }) => {
  const [ayse, mehmet, zeynep] = await people(browser, trio)
  await push(ayse.page, wow('Orgrimmar'))
  await expect(line(zeynep, ayse)).toHaveText('WoW Forever · 37 · Orgrimmar')

  await restartServer('SIGKILL')
  for (const person of [ayse, mehmet, zeynep]) await expectConnected(person.page)
  for (const viewer of [mehmet, zeynep]) await expect(line(viewer, ayse)).toHaveText('WoW Forever · 37 · Orgrimmar')

  // A change while the socket is down arrives after the reconnect.
  await restartServer('SIGKILL')
  await push(ayse.page, wow('Thunder Bluff', 40))
  for (const person of [ayse, mehmet]) await expectConnected(person.page)
  await expect(line(mehmet, ayse)).toHaveText('WoW Forever · 40 · Thunder Bluff')
})

test('game status screenshot (deviceScaleFactor 2)', async ({ browser, trio }) => {
  const options = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 }
  const ayse = trio.add(await personViaApi(browser, 'Ayşe', { ...options, prepare: fakeDesktop }))
  const mehmet = trio.add(await personViaApi(browser, 'Mehmet', options))
  const zeynep = trio.add(await personViaApi(browser, 'Zeynep', { ...options, prepare: fakeDesktop }))
  await push(ayse.page, wow('Orgrimmar'))
  // Zeynep plays something the addon knows nothing about: process detection only.
  await push(zeynep.page, { game: 'Counter-Strike 2', since: Math.floor(Date.now() / 1000) - 25 * 60 })
  await joinVoice(ayse)
  await expect(mehmet.page.getByTestId(`voice-activity-${ayse.user.id}`)).toBeVisible()
  await expect(line(mehmet, ayse)).toBeVisible()
  await expect(line(mehmet, zeynep)).toHaveText('Counter-Strike 2')
  await mehmet.page.screenshot({
    path: path.join(E2E_DIR, 'screenshots', '24-game-status.png'),
    animations: 'disabled',
    caret: 'hide',
  })
})
