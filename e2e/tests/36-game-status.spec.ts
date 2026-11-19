/**
 * CONTRACT-V5: game status. Ayşe's page gets a fake desktop bridge
 * (`window.trioDesktop.onGameStatus`, what desktop/'s preload exposes); the
 * test pushes statuses through it the way the main process would, and checks
 * what the other two see under her name.
 */
import path from 'node:path'
import type { BrowserContext, Page } from '@playwright/test'
import { E2E_DIR, freshServer, restartServer } from '../lib/server'
import { apiAvatar, drawPicture } from '../lib/identity'
import { apiJoin, expect, expectConnected, expectHearing, joinVoice, personViaApi, personWithSession, test, type ContextOptions, type Person } from '../lib/trio'
import { socketSwitch } from '../lib/voiceProbe'

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
    path: path.join(E2E_DIR, 'screenshots', '17-game-status.png'),
    animations: 'disabled',
    caret: 'hide',
  })
  // Its setting, between Bağlantı testi and Hesap, as the desktop app shows it.
  await ayse.page.getByTestId('btn-settings').click()
  const section = ayse.page.locator('section[aria-labelledby="settings-game"]')
  await section.scrollIntoViewIfNeeded()
  await expect(section).toContainText('Oyun durumumu paylaş')
  await expect(section).toContainText('Trio masaüstü › Oyun durumu')
  await ayse.page.screenshot({ path: path.join(E2E_DIR, 'screenshots', '17c-game-status-setting.png'), animations: 'disabled', caret: 'hide' })
})

test('390 px: the activity line in a voice row sits with the avatar, the health state, a long name and "bağlanıyor…" without overflowing', async ({ browser, trio }) => {
  test.setTimeout(150_000)
  const sw = socketSwitch()
  const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
  const ayse = trio.add(await personViaApi(browser, 'Ayşe', { prepare: fakeDesktop }))
  const mehmet = trio.add(await personViaApi(browser, 'Mehmet', phone))
  const zeynep = trio.add(
    await personWithSession(browser, 'Zeynep Karaosmanoğlu', await apiJoin('Zeynep Karaosmanoğlu'), {
      prepare: async (context) => {
        await fakeDesktop(context)
        await sw.prepare(context)
      },
    }),
  )
  // Ayşe has a picture; the zone is long enough to be cut.
  const picture = await drawPicture(ayse.page, { width: 400, height: 400, background: '#3e6e85', disc: '#ee997f', band: '#f2f1ed' })
  await apiAvatar(ayse.token, { name: 'ayse.png', mimeType: 'image/png', buffer: picture })
  await push(ayse.page, wow('Hellfire Peninsula — Thrallmar, Kalabalık Han'))
  await push(zeynep.page, { game: 'Counter-Strike 2', since: Math.floor(Date.now() / 1000) - 25 * 60 })
  await joinVoice(ayse)
  await joinVoice(zeynep)
  await mehmet.page.getByTestId('btn-drawer').click()
  await joinVoice(mehmet)
  await expectHearing(mehmet, zeynep)
  await sw.cut()

  const voiceRow = (subject: Person) => mehmet.page.getByTestId(`voice-user-${subject.user.id}`)
  await expect(voiceRow(zeynep)).toHaveAttribute('data-reconnecting', 'true')
  await expect(voiceRow(ayse)).toHaveAttribute('data-peer-health', /.+/)
  await expect(voiceRow(ayse).locator('.avatar img')).toBeVisible()
  await expect(mehmet.page.getByTestId(`voice-activity-${ayse.user.id}`)).toBeVisible()
  await expect(mehmet.page.getByTestId(`voice-activity-${zeynep.user.id}`)).toHaveText('Counter-Strike 2')

  for (const subject of [ayse, zeynep]) {
    const layout = await voiceRow(subject).evaluate((li) => {
      const box = (selector: string) => {
        const element = li.querySelector(selector)
        return element ? element.getBoundingClientRect().toJSON() : null
      }
      const text = li.querySelector('.game-activity-text') as HTMLElement
      return {
        row: li.getBoundingClientRect().toJSON(),
        overflow: li.scrollWidth - li.clientWidth,
        name: box('.voice-user-name'),
        icons: box('.voice-user-icons'),
        avatar: box('.avatar'),
        line: box('.game-activity'),
        lineStart: box('.game-activity > :first-child'),
        textFits: text.scrollWidth <= text.clientWidth,
        ellipsis: getComputedStyle(text).textOverflow,
        state: getComputedStyle(li.querySelector('.voice-user-icons')!, '::before').content,
      }
    })
    const { row, name, icons, avatar, line, lineStart } = layout
    expect(layout.overflow, `${subject.name}: the row does not scroll sideways`).toBeLessThanOrEqual(0)
    for (const part of [name!, icons!, avatar!, line!]) {
      expect(part.left).toBeGreaterThanOrEqual(row.left - 0.5)
      expect(part.right).toBeLessThanOrEqual(row.right + 0.5)
    }
    // Name, avatar and icons on the first line; the activity under the name, after the avatar.
    expect(Math.abs(name!.top + name!.height / 2 - (icons!.top + icons!.height / 2))).toBeLessThan(6)
    expect(line!.top).toBeGreaterThanOrEqual(name!.bottom - 3)
    expect(lineStart!.left).toBeGreaterThanOrEqual(avatar!.right - 1)
    expect(layout.ellipsis).toBe('ellipsis')
    // "bağlanıyor…" is said in words even when the name is long enough to be cut.
    expect(layout.state).toBe(subject === zeynep ? '"bağlanıyor…"' : 'none')
  }
  // The long zone is cut with "…", not wrapped or pushed out.
  expect(await voiceRow(ayse).locator('.game-activity-text').evaluate((t) => t.scrollWidth > t.clientWidth)).toBe(true)
  expect(await mehmet.page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await mehmet.page.screenshot({ path: path.join(E2E_DIR, 'screenshots', '17b-game-status-voice-390.png'), animations: 'disabled', caret: 'hide' })
  sw.online = true
  await expectConnected(zeynep.page)
})
