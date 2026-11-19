/**
 * CONTRACT-V6-VOICE §5–6 and the screenshots.
 *
 * - Browser shortcuts (Ctrl+Shift+M / Ctrl+Shift+D, rebindable) toggle mute
 *   and deafen with their cue sounds.
 * - The desktop bridge's web half, against a stand-in `window.trioDesktop`:
 *   the settings bind single global keys, refuse the PTT key, register them
 *   through `setHotkeys`, a hotkey from `onHotkey` toggles (cue included) and
 *   the tray hears `setVoiceState`. (The real hook and tray: desktop's unit
 *   tests; a real OS: not verified.)
 * - The people strip under the stage, only while there is a stage.
 * - Screenshots (deviceScaleFactor 2) of the share menu, the volume sheet at
 *   390 px, the sensitivity setting and the strip.
 */
import type { Page } from '@playwright/test'
import { longPress } from '../lib/messages'
import { baseUrl, freshServer } from '../lib/server'
import { expect, expectScreensDecoding, joinVoice, personViaApi, test, threePeople } from '../lib/trio'
import { CUE_PROBE, cuesPlayed } from '../lib/voiceProbe'

test.beforeEach(async () => {
  await freshServer()
})

const SHOTS = 'screenshots'
const DESKTOP = { deviceScaleFactor: 2, viewport: { width: 1280, height: 800 } }
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }

async function noOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth))
}

test('browser shortcuts toggle mute and deafen with their cues, and can be rebound', async ({ browser, trio }) => {
  const ayse = trio.add(await personViaApi(browser, 'Ayşe', { prepare: async (c) => void (await c.addInitScript(CUE_PROBE)) }))
  const mehmet = trio.add(await personViaApi(browser, 'Mehmet'))
  await joinVoice(ayse)
  await joinVoice(mehmet)
  const row = mehmet.page.getByTestId(`voice-user-${ayse.user.id}`)

  await ayse.page.keyboard.press('Control+Shift+KeyM')
  await expect(ayse.page.getByTestId('btn-mute')).toHaveAttribute('aria-pressed', 'true')
  await expect(row).toHaveAttribute('data-muted', 'true')
  await ayse.page.keyboard.press('Control+Shift+KeyD')
  await expect(ayse.page.getByTestId('btn-deafen')).toHaveAttribute('aria-pressed', 'true')
  await expect(row).toHaveAttribute('data-deafened', 'true')
  await ayse.page.keyboard.press('Control+Shift+KeyD')
  await expect(row).toHaveAttribute('data-deafened', 'false')
  await ayse.page.keyboard.press('Control+Shift+KeyM')
  await expect(row).toHaveAttribute('data-muted', 'false')
  await expect.poll(() => cuesPlayed(ayse.page)).toEqual(expect.arrayContaining(['mute', 'unmute', 'deafen', 'undeafen']))

  // Rebind mute to Alt+K; the old chord does nothing now.
  await ayse.page.getByTestId('btn-settings').click()
  await expect(ayse.page.getByTestId('settings-shortcuts')).toHaveAttribute('data-desktop', 'false')
  await expect(ayse.page.getByTestId('shortcut-mute')).toHaveText('Ctrl + Shift + M')
  await ayse.page.getByTestId('shortcut-mute-bind').click()
  await ayse.page.keyboard.press('KeyQ') // no Ctrl/Alt: not a page chord, still listening
  await ayse.page.keyboard.press('Alt+KeyK')
  await expect(ayse.page.getByTestId('shortcut-mute')).toHaveText('Alt + K')
  // The deafen chord cannot also be Alt+K.
  await ayse.page.getByTestId('shortcut-deafen-bind').click()
  await ayse.page.keyboard.press('Alt+KeyK')
  await expect(ayse.page.getByTestId('shortcut-conflict')).toBeVisible()
  await expect(ayse.page.getByTestId('shortcut-deafen')).toHaveText('Ctrl + Shift + D')
  await ayse.page.getByTestId('settings-close').click()
  await ayse.page.keyboard.press('Control+Shift+KeyM')
  await ayse.page.keyboard.press('Alt+KeyK')
  await expect(row).toHaveAttribute('data-muted', 'true')
})

/** A stand-in for the desktop preload's bridge, recording what the page tells it. */
const FAKE_DESKTOP = `
(() => {
  window.__desk = { hotkeys: [], voice: [], ptt: [] }
  let hotkey = null
  window.trioDesktop = {
    isDesktop: true,
    setPttKey: (code) => window.__desk.ptt.push(code),
    onPtt: () => () => undefined,
    setHotkeys: (keys) => window.__desk.hotkeys.push(keys),
    onHotkey: (cb) => { hotkey = cb; return () => { hotkey = null } },
    setVoiceState: (state) => window.__desk.voice.push(state),
    getSystemIdleTime: async () => 999,
  }
  window.__deskFire = (action) => hotkey && hotkey(action)
})()
`

test('desktop bridge (web half): global keys bound in settings, PTT key refused, a hotkey toggles with its cue, the tray hears it', async ({ browser, trio }) => {
  const ayse = trio.add(
    await personViaApi(browser, 'Ayşe', {
      prepare: async (c) => {
        await c.addInitScript(FAKE_DESKTOP)
        await c.addInitScript(CUE_PROBE)
      },
    }),
  )
  const mehmet = trio.add(await personViaApi(browser, 'Mehmet'))
  await joinVoice(ayse)
  await joinVoice(mehmet)
  const desk = () => ayse.page.evaluate(() => (window as unknown as { __desk: { hotkeys: unknown[]; voice: unknown[] } }).__desk)

  await ayse.page.getByTestId('btn-settings').click()
  await expect(ayse.page.getByTestId('settings-shortcuts')).toHaveAttribute('data-desktop', 'true')
  await expect(ayse.page.getByTestId('shortcut-mute')).toHaveText('Yok')
  // Push-to-talk on the default ` key: that key cannot be a hotkey.
  await ayse.page.getByTestId('settings-mode-ptt').check()
  await ayse.page.getByTestId('shortcut-mute-bind').click()
  await ayse.page.keyboard.press('Backquote')
  await expect(ayse.page.getByTestId('shortcut-conflict')).toHaveText('Bu tuş bas-konuş tuşu; başka bir tuş seç.')
  await expect(ayse.page.getByTestId('shortcut-mute')).toHaveText('Yok')
  await ayse.page.getByTestId('shortcut-mute-bind').click()
  await ayse.page.keyboard.press('F9')
  await ayse.page.getByTestId('shortcut-deafen-bind').click()
  await ayse.page.keyboard.press('F10')
  await expect(ayse.page.getByTestId('shortcut-mute')).toHaveText('F9')
  await expect(ayse.page.getByTestId('shortcut-deafen')).toHaveText('F10')
  await expect.poll(async () => (await desk()).hotkeys.at(-1)).toEqual({ mute: 'F9', deafen: 'F10' })
  await ayse.page.getByTestId('settings-mode-activity').check()
  await ayse.page.getByTestId('settings-close').click()

  // The main process fires "mute" (the window may be in the background): toggled, cue, tray.
  await ayse.page.evaluate(() => (window as unknown as { __deskFire: (a: string) => void }).__deskFire('mute'))
  await expect(mehmet.page.getByTestId(`voice-user-${ayse.user.id}`)).toHaveAttribute('data-muted', 'true')
  await expect.poll(async () => (await desk()).voice.at(-1)).toEqual({ inVoice: true, muted: true, deafened: false })
  await ayse.page.evaluate(() => (window as unknown as { __deskFire: (a: string) => void }).__deskFire('deafen'))
  await expect(mehmet.page.getByTestId(`voice-user-${ayse.user.id}`)).toHaveAttribute('data-deafened', 'true')
  await expect.poll(async () => (await desk()).voice.at(-1)).toEqual({ inVoice: true, muted: true, deafened: true })
  await expect.poll(() => cuesPlayed(ayse.page)).toEqual(expect.arrayContaining(['mute', 'deafen']))
  // In-page chords are not used in the desktop app (the global keys are).
  await ayse.page.keyboard.press('Control+Shift+KeyD')
  await expect(ayse.page.getByTestId('btn-deafen')).toHaveAttribute('aria-pressed', 'true')
  await ayse.page.getByTestId('btn-hangup').click()
  await expect.poll(async () => (await desk()).voice.at(-1)).toMatchObject({ inVoice: false })
})

test('the people strip: only with a stage, everyone without a camera tile, with their marks; screenshots', async ({ browser, trio }) => {
  test.setTimeout(180_000)
  const people = await threePeople(browser, trio, DESKTOP)
  const [ayse, mehmet, zeynep] = people
  for (const person of people) await joinVoice(person)
  for (const person of people) await expect(person.page.locator('[data-testid^="voice-user-"]')).toHaveCount(3)

  // Audio only: no stage, no strip.
  await expect(mehmet.page.getByTestId('stage-people')).toHaveCount(0)

  await ayse.page.getByTestId('btn-screen').click()
  await expectScreensDecoding(mehmet.page, 1)
  const strip = mehmet.page.getByTestId('stage-people')
  await expect(strip.locator('figure')).toHaveCount(3)
  await expect(strip.getByTestId(`stage-person-${mehmet.user.id}`).locator('figcaption')).toHaveText('Sen')
  // Zeynep mutes: the mark is on her strip tile; her camera replaces her avatar tile.
  await zeynep.page.getByTestId('btn-mute').click()
  await expect(strip.getByTestId(`stage-person-${zeynep.user.id}`)).toHaveAttribute('data-muted', 'true')
  await expect(strip.getByTestId(`stage-person-${ayse.user.id}`)).toHaveAttribute('data-speaking', 'true', { timeout: 15_000 })
  await zeynep.page.getByTestId('btn-camera').click()
  await expect(mehmet.page.getByTestId(`remote-camera-${zeynep.user.id}`)).toHaveCount(1, { timeout: 20_000 })
  await expect(strip.locator('figure')).toHaveCount(2)
  await zeynep.page.getByTestId('btn-camera').click()
  await expect(strip.locator('figure')).toHaveCount(3)
  await noOverflow(mehmet.page)
  // The strip (the stage with the people under it), at a moment Ayşe's ring is lit.
  await expect(strip.getByTestId(`stage-person-${ayse.user.id}`)).toHaveAttribute('data-speaking', 'true', { timeout: 15_000 })
  await mehmet.page.screenshot({ path: `${SHOTS}/v6-voice-stage-people.png` })

  // The share menu, from the caret beside the share button.
  await ayse.page.getByTestId('btn-share-menu').click()
  await ayse.page.getByTestId('share-profile-game').click()
  await expect(ayse.page.getByTestId('share-watchers')).toHaveText('İzleyenler: Mehmet, Zeynep')
  await noOverflow(ayse.page)
  await ayse.page.screenshot({ path: `${SHOTS}/v6-voice-share-menu.png` })
  await ayse.page.keyboard.press('Escape')

  // The sensitivity setting, with the gate on and the live bar.
  await zeynep.page.getByTestId('btn-mute').click()
  await mehmet.page.getByTestId('btn-settings').click()
  await mehmet.page.getByTestId('gate-auto').uncheck()
  await mehmet.page.getByTestId('gate-threshold').fill('-45')
  await expect(mehmet.page.getByTestId('gate-meter')).toHaveAttribute('data-gate-state', 'active')
  await mehmet.page.getByTestId('gate-meter').scrollIntoViewIfNeeded()
  await expect(mehmet.page.getByTestId('gate-meter')).toHaveAttribute('data-above', 'true', { timeout: 15_000 })
  await mehmet.page.getByRole('heading', { name: 'Giriş hassasiyeti' }).evaluate((h) => h.scrollIntoView({ block: 'start' }))
  await mehmet.page.screenshot({ path: `${SHOTS}/v6-voice-sensitivity.png` })
})

test('the volume sheet at 390 px opens on a long-press and fits', async ({ browser, trio }) => {
  test.setTimeout(120_000)
  const ayse = trio.add(await personViaApi(browser, 'Ayşe', PHONE))
  const mehmet = trio.add(await personViaApi(browser, 'Mehmet'))
  await mehmet.page.getByTestId('channel-2').click()
  await expect(mehmet.page.locator('.voice-status strong')).toHaveText('Ses bağlı')
  await mehmet.page.getByTestId('btn-screen').click()
  await ayse.page.getByTestId('btn-drawer').click()
  await ayse.page.getByTestId('channel-2').click()
  await expect(ayse.page.locator('.voice-status strong')).toHaveText('Ses bağlı')
  await expectScreensDecoding(ayse.page, 1)
  const row = ayse.page.getByTestId(`voice-user-${mehmet.user.id}`)
  if (!(await row.isVisible())) await ayse.page.getByTestId('btn-drawer').click()
  await longPress(ayse.page, row, ayse.page.getByTestId('volume-sheet'))
  // The press that opened it did not land on the sheet (CLAUDE.md, lib/pressEnd).
  await expect(ayse.page.getByTestId('volume-voice-value')).toHaveText('%100')
  await ayse.page.getByTestId('volume-voice').fill('140')
  await expect(ayse.page.getByTestId('volume-voice-value')).toHaveText('%140')
  const box = await ayse.page.getByTestId('volume-sheet').boundingBox()
  expect(box?.width).toBeLessThanOrEqual(390)
  expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(844 + 1)
  await noOverflow(ayse.page)
  await ayse.page.screenshot({ path: `${SHOTS}/v6-voice-volume-sheet-390.png` })
})

/** A desktop bridge stand-in with (or without) `appVersion`. */
function desktopWithVersion(version: string | null): string {
  return `window.trioDesktop = { isDesktop: true, setPttKey() {}, onPtt() { return () => {} }${
    version === null ? '' : `, appVersion: ${JSON.stringify(version)}`
  } }`
}

test('desktop version: an older app gets the update notice (dismissable per version), the same version none, an old build says so; never in a browser', async ({ browser, trio }) => {
  const health = (await (await fetch(`${baseUrl()}/api/health`)).json()) as { version: string }
  const serverVersion = health.version
  expect(serverVersion).toMatch(/^\d+\.\d+\.\d+/)

  const older = trio.add(
    await personViaApi(browser, 'Ayşe', { prepare: async (c) => void (await c.addInitScript(desktopWithVersion('0.0.1'))) }),
  )
  const band = older.page.getByTestId('desktop-update')
  await expect(band).toContainText(`Masaüstü uygulamasının yeni sürümü var (${serverVersion}).`)
  await expect(older.page.getByTestId('desktop-update-download')).toHaveAttribute(
    'href',
    'https://github.com/borankaraduman-star/Trio/releases/latest',
  )
  await expect(older.page.getByTestId('desktop-update-download')).toHaveAttribute('target', '_blank')
  await older.page.getByTestId('btn-settings').click()
  await expect(older.page.getByTestId('desktop-version')).toHaveText('Masaüstü uygulaması 0.0.1')
  await expect(older.page.getByTestId('desktop-update-line')).toContainText(`(${serverVersion})`)
  await older.page.getByTestId('settings-close').click()
  await older.page.getByTestId('desktop-update-dismiss').click()
  await expect(band).toHaveCount(0)
  await older.page.reload()
  await expect(older.page.getByTestId('composer')).toBeVisible()
  await expect(band).toHaveCount(0)
  // The settings line stays (only the band is dismissed).
  await older.page.getByTestId('btn-settings').click()
  await expect(older.page.getByTestId('desktop-update-line')).toBeVisible()

  const same = trio.add(
    await personViaApi(browser, 'Mehmet', { prepare: async (c) => void (await c.addInitScript(desktopWithVersion(serverVersion))) }),
  )
  await same.page.getByTestId('btn-settings').click()
  await expect(same.page.getByTestId('desktop-version')).toHaveText(`Masaüstü uygulaması ${serverVersion}`)
  await expect(same.page.getByTestId('desktop-update-line')).toHaveCount(0)
  await expect(same.page.getByTestId('desktop-update')).toHaveCount(0)

  const oldBuild = trio.add(
    await personViaApi(browser, 'Zeynep', { prepare: async (c) => void (await c.addInitScript(desktopWithVersion(null))) }),
  )
  await expect(oldBuild.page.getByTestId('desktop-update')).toBeVisible()
  await oldBuild.page.getByTestId('btn-settings').click()
  await expect(oldBuild.page.getByTestId('desktop-version')).toHaveText('Masaüstü uygulaması (eski sürüm)')

  const plain = trio.add(await personViaApi(browser, 'Ece'))
  await plain.page.getByTestId('btn-settings').click()
  await expect(plain.page.getByTestId('settings-versions')).toBeVisible()
  await expect(plain.page.getByTestId('desktop-version')).toHaveCount(0)
  await expect(plain.page.getByTestId('desktop-update')).toHaveCount(0)
})
