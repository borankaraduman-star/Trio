/**
 * CONTRACT-V12-WATCHING §5–§7: the ways of watching somebody's screen while
 * doing something else.
 *
 * What is real and what is faked:
 * - the mini player is the real `/mini.html` child window, opened with
 *   `window.open` from a real click, its stream attached by the opener;
 *   Document Picture-in-Picture is turned off in the browser test (Playwright
 *   cannot drive that window) and only probed;
 * - the desktop shell is a STUB `window.trioDesktop` (its `mini`, watch keys
 *   and window state), recording what the page calls; the real shell's side
 *   is desktop/'s own tests and docs/izleme-kontrol.md;
 * - classic picture-in-picture is asked of the real browser and the answer
 *   printed (headless Chromium may refuse it).
 */
import path from 'node:path'
import type { BrowserContext, Page } from '@playwright/test'
import { freshServer } from '../lib/server'
import { crowd } from '../lib/groups'
import { expect, GENEL, joinVoice, sendThroughUi, test, type Person } from '../lib/trio'
import { SCREENSHOTS, settingsTab } from '../lib/v7phone'
import { expectDecodingFrom, screenSend, SCREEN_WITH_TONE } from '../lib/v12multishare'

test.beforeEach(async () => {
  await freshServer()
})

const NO_DOC_PIP = `try { delete window.documentPictureInPicture } catch {}`

/** The desktop shell, faked at its bridge: every call recorded in window.__shell. */
const DESKTOP_STUB = `
(() => {
  const shell = { calls: [], stateCb: null, hotkeyCb: null, windowCb: null, keys: null }
  window.__shell = shell
  window.trioDesktop = {
    isDesktop: true,
    setPttKey() {},
    onPtt() { return () => {} },
    mini: {
      supported: true,
      setOptions(id, o) { shell.calls.push(['setOptions', id, o]) },
      show(id) { shell.calls.push(['show', id]) },
      hide(id) { shell.calls.push(['hide', id]) },
      close(id) { shell.calls.push(['close', id]); if (shell.stateCb) shell.stateCb({ id, visible: false, clickThrough: false, bounds: { x: 0, y: 0, width: 0, height: 0 }, closed: true }) },
      onState(cb) { shell.stateCb = cb; return () => { shell.stateCb = null } },
    },
    setWatchHotkeys(keys) { shell.keys = keys; shell.calls.push(['keys', keys]) },
    onWatchHotkey(cb) { shell.hotkeyCb = cb; return () => { shell.hotkeyCb = null } },
    onWindowState(cb) { shell.windowCb = cb; cb({ focused: true, minimized: false, hiddenToTray: false }); return () => { shell.windowCb = null } },
  }
})()
`

async function popupOf(viewer: Person, action: () => Promise<void>): Promise<Page> {
  const [popup] = await Promise.all([viewer.context.waitForEvent('page'), action()])
  await popup.waitForLoadState()
  return popup
}

async function miniDecoding(popup: Page): Promise<void> {
  await expect
    .poll(
      () =>
        popup.evaluate(async () => {
          const v = document.querySelector<HTMLVideoElement>('[data-mini-video]')
          if (!v || v.videoWidth === 0) return false
          const a = v.getVideoPlaybackQuality().totalVideoFrames
          await new Promise((r) => setTimeout(r, 600))
          return v.getVideoPlaybackQuality().totalVideoFrames > a
        }),
      { timeout: 20_000, message: 'the mini player decodes' },
    )
    .toBe(true)
}

async function towards(sharer: Person, viewer: Person, check: (bitrate: number | null) => boolean, what: string): Promise<void> {
  await expect
    .poll(async () => check((await screenSend(sharer, 800)).find((s) => s.viewer === viewer.user.id)?.maxBitrate ?? null), { timeout: 20_000, message: what })
    .toBe(true)
}

const sharerPrep = async (context: BrowserContext) => void (await context.addInitScript(SCREEN_WITH_TONE))

test('browser: the mini player window, its controls, re-attach, the end of a share; picture-in-picture probed', async ({ browser, trio }) => {
  test.setTimeout(300_000)
  const [ayse, mehmet, zeynep] = await crowd(browser, trio, 3, (i) =>
    i === 2
      ? { viewport: { width: 1440, height: 900 }, prepare: async (c) => void (await c.addInitScript(NO_DOC_PIP)) }
      : { prepare: sharerPrep },
  )
  for (const person of [ayse, mehmet, zeynep]) await joinVoice(person)
  await ayse.page.getByTestId('btn-screen').click()
  await mehmet.page.getByTestId('btn-screen').click()
  await expectDecodingFrom(zeynep, [ayse.user.id, mehmet.user.id])

  // Odak on Mehmet: Ayşe is a thumbnail on the stage...
  await zeynep.page.getByTestId('stage-mode-focus').click()
  await zeynep.page.getByTestId('stage').focus()
  await zeynep.page.keyboard.press('2')
  await towards(ayse, zeynep, (b) => b === 300_000, 'Ayşe is a thumbnail for Zeynep')

  // ...and opened in the mini player she is sent at the mini's size.
  const popup = await popupOf(zeynep, () => zeynep.page.getByTestId(`tile-mini-button-${ayse.user.id}`).click())
  expect(new URL(popup.url()).pathname + new URL(popup.url()).search).toBe(`/mini.html?m=share-${ayse.user.id}`)
  await expect(popup.getByTestId('mini-name')).toHaveText('Ayşe')
  await miniDecoding(popup)
  await expect(zeynep.page.getByTestId(`tile-mini-button-${ayse.user.id}`)).toHaveAttribute('aria-pressed', 'true')
  await towards(ayse, zeynep, (b) => b !== null && b > 300_000, 'the mini player is watched: more than a thumbnail')
  // Its video is muted: the share's sound stays in the Trio window (never heard twice).
  expect(await popup.evaluate(() => document.querySelector<HTMLVideoElement>('[data-mini-video]')!.muted)).toBe(true)
  await popup.screenshot({ path: path.join(SCREENSHOTS, 'v12-multishare-mini.png') })

  // The share's sound from the mini player: mute, then back.
  await popup.getByTestId('mini-mute').click()
  await expect
    .poll(() => zeynep.page.locator(`figure.call-tile.screen[data-user-id="${ayse.user.id}"] video`).getAttribute('data-volume'))
    .toBe('0')
  await popup.getByTestId('mini-mute').click()
  await expect
    .poll(() => zeynep.page.locator(`figure.call-tile.screen[data-user-id="${ayse.user.id}"] video`).getAttribute('data-volume'))
    .toBe('1')

  // A renegotiation on Ayşe's connections (her camera on): the mini keeps playing.
  await ayse.page.getByTestId('btn-camera').click()
  await expect(zeynep.page.getByTestId(`remote-camera-${ayse.user.id}`)).toHaveCount(1, { timeout: 20_000 })
  await miniDecoding(popup)

  // "Next" moves the mini to Mehmet's screen.
  await popup.getByTestId('mini-next').click()
  await expect(popup.getByTestId('mini')).toHaveAttribute('data-sharer', String(mehmet.user.id))
  await miniDecoding(popup)
  await popup.getByTestId('mini-next').click()
  await expect(popup.getByTestId('mini')).toHaveAttribute('data-sharer', String(ayse.user.id))

  // The share ends: the mini says so and closes itself.
  await ayse.page.getByTestId('btn-screen').click()
  await expect(popup.getByTestId('mini-ended')).toBeVisible()
  await popup.waitForEvent('close', { timeout: 10_000 })
  await expect(zeynep.page.getByTestId(`tile-mini-button-${ayse.user.id}`)).toHaveCount(0)

  // Classic picture-in-picture of a stage tile: what this browser says.
  const pip = await zeynep.page.evaluate(async () => {
    const video = document.querySelector<HTMLVideoElement>('figure.call-tile.screen video')
    if (!document.pictureInPictureEnabled || !video) return 'not enabled'
    try {
      await video.requestPictureInPicture()
      const ok = document.pictureInPictureElement === video
      await document.exitPictureInPicture()
      return ok ? 'opened' : 'no element'
    } catch (error) {
      return `refused: ${(error as Error).name}`
    }
  })
  console.log(`[94] classic picture-in-picture here: ${pip}`)
  const docPip = await ayse.page.evaluate(() => typeof (window as unknown as { documentPictureInPicture?: unknown }).documentPictureInPicture)
  console.log(`[94] Document Picture-in-Picture API here: ${docPip}`)
})

test('theatre: one share fills the window, switch with keys, two side by side, the chat line, Esc', async ({ browser, trio }) => {
  test.setTimeout(240_000)
  const [ayse, mehmet, zeynep] = await crowd(browser, trio, 3, (i) => (i === 2 ? { viewport: { width: 1440, height: 900 } } : {}))
  for (const person of [ayse, mehmet, zeynep]) await joinVoice(person)
  await ayse.page.getByTestId('btn-screen').click()
  await mehmet.page.getByTestId('btn-screen').click()
  await expectDecodingFrom(zeynep, [ayse.user.id, mehmet.user.id])

  await zeynep.page.getByTestId(`tile-menu-${ayse.user.id}`).click()
  await zeynep.page.getByTestId(`tile-theatre-${ayse.user.id}`).click()
  const theatre = zeynep.page.getByTestId('theatre')
  await expect(theatre).toHaveAttribute('data-sharer', String(ayse.user.id))
  const box = await theatre.boundingBox()
  expect(box?.width).toBe(1440)
  expect(box?.height).toBe(900)
  await towards(ayse, zeynep, (b) => b === 3_000_000, 'the theatre is full size')
  await expect
    .poll(() => zeynep.page.evaluate((id) => document.querySelector<HTMLVideoElement>(`[data-testid="theatre-video-${id}"]`)?.videoWidth ?? 0, ayse.user.id))
    .toBeGreaterThan(0)

  // The latest chat line fades in at the bottom.
  await sendThroughUi(mehmet, 'gördün mü şu boss')
  await expect(zeynep.page.getByTestId('theatre-chat')).toContainText('gördün mü şu boss')
  await zeynep.page.screenshot({ path: path.join(SCREENSHOTS, 'v12-multishare-theatre-1440.png') })

  // Controls go after a few seconds without the pointer.
  await expect(theatre).toHaveAttribute('data-controls', 'hidden', { timeout: 6000 })
  await zeynep.page.mouse.move(400, 300)
  await zeynep.page.mouse.move(420, 320)
  await expect(theatre).toHaveAttribute('data-controls', 'shown')

  // → and 1–9 switch; "Yan yana" shows two.
  await zeynep.page.keyboard.press('ArrowRight')
  await expect(theatre).toHaveAttribute('data-sharer', String(mehmet.user.id))
  await zeynep.page.keyboard.press('1')
  await expect(theatre).toHaveAttribute('data-sharer', String(ayse.user.id))
  await zeynep.page.getByTestId('theatre-pair').click()
  await expect(zeynep.page.locator('.v12-theatre-video')).toHaveCount(2)
  await zeynep.page.screenshot({ path: path.join(SCREENSHOTS, 'v12-multishare-theatre-pair-1440.png') })

  await zeynep.page.keyboard.press('Escape')
  await expect(theatre).toHaveCount(0)
  await expectDecodingFrom(zeynep, [ayse.user.id, mehmet.user.id])
  void GENEL
})

test('desktop app (stubbed shell): global watch keys, the mini window options, click-through shown, the automatic mini player', async ({ browser, trio }) => {
  test.setTimeout(300_000)
  const [ayse, mehmet, zeynep] = await crowd(browser, trio, 3, (i) =>
    i === 2 ? { viewport: { width: 1440, height: 900 }, prepare: async (c) => void (await c.addInitScript(DESKTOP_STUB)) } : {},
  )
  for (const person of [ayse, mehmet, zeynep]) await joinVoice(person)
  await ayse.page.getByTestId('btn-screen').click()
  await mehmet.page.getByTestId('btn-screen').click()
  await expectDecodingFrom(zeynep, [ayse.user.id, mehmet.user.id])

  // Bind a chord in Ayarlar › Kısayollar › İzlerken; a clash with mute is refused with the shell's words.
  await zeynep.page.getByTestId('btn-settings').click()
  await settingsTab(zeynep.page, 'ses')
  await zeynep.page.getByTestId('watch-key-toggleMini-bind').click()
  await zeynep.page.keyboard.press('Control+Shift+F9')
  await expect(zeynep.page.getByTestId('watch-key-toggleMini')).toHaveText('Ctrl + Shift + F9')
  await zeynep.page.getByTestId('watch-key-theatre-bind').click()
  await zeynep.page.keyboard.press('Control+Shift+F9')
  await expect(zeynep.page.getByTestId('watch-key-conflict')).toHaveText('Bu tuş başka bir izleme kısayolunda; başka bir tuş seç.')
  await zeynep.page.keyboard.press('Escape')
  await zeynep.page.keyboard.press('Escape')
  await expect.poll(() => zeynep.page.evaluate(() => (window as unknown as { __shell: { keys: Record<string, string | null> } }).__shell.keys?.toggleMini)).toBe('Ctrl+Shift+F9')

  const fire = (action: string) =>
    zeynep.page.evaluate((a) => (window as unknown as { __shell: { hotkeyCb: (a: string) => void } }).__shell.hotkeyCb(a), action)

  // toggleMini: the mini window opens (from a key, no click: the shell allows it).
  const popup = await popupOf(zeynep, () => fire('toggleMini'))
  await miniDecoding(popup)
  const calls = await zeynep.page.evaluate(() => (window as unknown as { __shell: { calls: unknown[][] } }).__shell.calls)
  const options = calls.find((c) => c[0] === 'setOptions' && (c[2] as { alwaysOnTop?: boolean }).alwaysOnTop === true)
  expect(options?.[1]).toBe(`share-${ayse.user.id}`)
  expect(options?.[2]).toMatchObject({ opacity: 1, alwaysOnTop: true, contentProtection: false })
  await expect(popup.getByTestId('mini-click-through')).toBeVisible()
  await expect(popup.getByTestId('mini-opacity')).toBeVisible()

  // clickThrough: the SHELL toggles it; the page only shows what onState says.
  await fire('clickThrough')
  expect(
    (await zeynep.page.evaluate(() => (window as unknown as { __shell: { calls: unknown[][] } }).__shell.calls)).filter(
      (c) => c[0] === 'setOptions' && (c[2] as { clickThrough?: boolean }).clickThrough !== undefined,
    ),
  ).toEqual([])
  await zeynep.page.evaluate((id) => {
    ;(window as unknown as { __shell: { stateCb: (s: unknown) => void } }).__shell.stateCb({ id, visible: true, clickThrough: true, bounds: { x: 0, y: 0, width: 480, height: 270 } })
  }, `share-${ayse.user.id}`)
  await expect(popup.getByTestId('mini-click-through')).toHaveAttribute('aria-pressed', 'true')

  // Opacity from the mini goes to the shell.
  await popup.getByTestId('mini-opacity').fill('60')
  await expect
    .poll(async () =>
      (await zeynep.page.evaluate(() => (window as unknown as { __shell: { calls: unknown[][] } }).__shell.calls)).some(
        (c) => c[0] === 'setOptions' && (c[2] as { opacity?: number }).opacity === 0.6,
      ),
    )
    .toBe(true)

  // muteShare / volume keys act on the share in the mini.
  await fire('muteShare')
  await expect.poll(() => zeynep.page.locator(`figure.call-tile.screen[data-user-id="${ayse.user.id}"] video`).getAttribute('data-volume')).toBe('0')
  await fire('muteShare')
  await fire('shareVolumeDown')
  await expect.poll(() => zeynep.page.locator(`figure.call-tile.screen[data-user-id="${ayse.user.id}"] video`).getAttribute('data-volume')).toBe('0.9')

  // The shell says the window is gone: the page forgets it.
  await zeynep.page.evaluate((id) => {
    ;(window as unknown as { __shell: { stateCb: (s: unknown) => void } }).__shell.stateCb({ id, visible: false, clickThrough: false, bounds: { x: 0, y: 0, width: 0, height: 0 }, closed: true })
  }, `share-${ayse.user.id}`)
  await expect(zeynep.page.getByTestId(`tile-mini-button-${ayse.user.id}`)).toHaveAttribute('aria-pressed', 'false')
  await popup.close().catch(() => undefined)

  // theatre and nextShare keys.
  await fire('theatre')
  await expect(zeynep.page.getByTestId('theatre')).toHaveAttribute('data-sharer', String(ayse.user.id))
  await fire('nextShare')
  await expect(zeynep.page.getByTestId('theatre')).toHaveAttribute('data-sharer', String(mehmet.user.id))
  await fire('theatre')
  await expect(zeynep.page.getByTestId('theatre')).toHaveCount(0)

  // The automatic mini player: Trio goes to the tray → it opens; Trio comes back → it closes.
  await zeynep.page.getByTestId('btn-settings').click()
  await settingsTab(zeynep.page, 'goruntu')
  await zeynep.page.getByTestId('watch-setting-autoMini').check()
  await zeynep.page.keyboard.press('Escape')
  const auto = await popupOf(zeynep, () =>
    zeynep.page.evaluate(() =>
      (window as unknown as { __shell: { windowCb: (s: unknown) => void } }).__shell.windowCb({ focused: false, minimized: false, hiddenToTray: true }),
    ),
  )
  await miniDecoding(auto)
  await zeynep.page.evaluate(() =>
    (window as unknown as { __shell: { windowCb: (s: unknown) => void } }).__shell.windowCb({ focused: true, minimized: false, hiddenToTray: false }),
  )
  await auto.waitForEvent('close', { timeout: 10_000 })
})
