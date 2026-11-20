/**
 * CONTRACT-V10-UPDATE §4–5: the web half of the desktop app's self-update,
 * against a stand-in `window.trioDesktop` that has the V10 update members and
 * whose state the test sets. (The real updater: desktop's unit tests with a
 * fake electron-updater; a real update on a real machine:
 * docs/guncelleme-kontrol.md.)
 *
 * - ready: "Güncelleme hazır: X — Yeniden başlat ve güncelle" with "Sonra";
 *   during a voice call no restart is offered.
 * - Ayarlar › Hakkında: Güncel / İndiriliyor %40 / Hazır / Güncelleme
 *   denetlenemedi (neden), the check button, the automatic-download switch.
 * - available (automatic download off): "İndir" asks the shell.
 * - a shell that cannot update here (unsigned macOS): the reason and a direct
 *   download for its own processor.
 * - a failed self-update falls back to the direct download.
 * - a release published while the page is open: the page asks the shell to
 *   look (`checkForUpdates`, once), and the band follows downloading → ready
 *   without opening settings; in a voice room it says "odadan çıkınca".
 */
import type { BrowserContext, Page } from '@playwright/test'
import { freshServer } from '../lib/server'
import { expect, personViaApi, test } from '../lib/trio'
import { settingsTab } from '../lib/v7phone'

test.beforeEach(async () => {
  await freshServer()
})

const SHOTS = 'screenshots'

async function withRelease(context: BrowserContext, version: string | (() => string)): Promise<void> {
  await context.route('**/api/downloads', (route) => {
    const v = typeof version === 'function' ? version() : version
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        version: v,
        published_at: '2026-11-20T00:00:00Z',
        signed: { windows: false, mac: false },
        files: ['windows', 'mac-arm64', 'mac-x64', 'linux'].map((platform) => ({
          platform,
          name: `Trio-${v}-${platform}`,
          size: 1,
          sha256: null,
          url: `/indir/dosya/${platform}`,
        })),
      }),
    })
  })
}

/**
 * The stand-in: `window.__update.set(patch)` changes the state and tells the
 * page; `window.__update.calls` records what the page asked for.
 */
function updatingDesktop(initial: Record<string, unknown>): string {
  return `(() => {
    const listeners = new Set()
    let state = Object.assign({
      capability: 'auto', reason: null, platform: 'windows', currentVersion: '0.8.0', autoDownload: true,
      status: 'up-to-date', version: null, percent: null, error: null, checkedAt: Date.now(), inVoice: false,
    }, ${JSON.stringify(initial)})
    const calls = []
    const set = (patch) => { state = Object.assign({}, state, patch); for (const cb of listeners) cb(state) }
    window.__update = { set, calls, get state() { return state } }
    window.trioDesktop = {
      isDesktop: true, appVersion: state.currentVersion,
      setPttKey() {}, onPtt() { return () => {} }, setVoiceState() {},
      getUpdateState: async () => state,
      onUpdateState(cb) { listeners.add(cb); return () => listeners.delete(cb) },
      checkForUpdates: async () => { calls.push('check'); set({ status: 'checking' }); return state },
      downloadUpdate: async () => { calls.push('download'); set({ status: 'downloading', percent: 0 }); return state },
      installUpdate: async () => { calls.push('install'); return { ok: !state.inVoice } },
      setAutoUpdate(on) { calls.push('auto:' + on); set({ autoDownload: on === true }) },
    }
  })()`
}

const setState = (page: Page, patch: Record<string, unknown>) =>
  page.evaluate((p) => (window as unknown as { __update: { set: (x: unknown) => void } }).__update.set(p), patch)
const calls = (page: Page) => page.evaluate(() => (window as unknown as { __update: { calls: string[] } }).__update.calls)

test('a ready update: restart offered, never during a call, "Sonra" hides it', async ({ browser, trio }) => {
  const ayse = trio.add(
    await personViaApi(browser, 'Ayşe', {
      prepare: async (c) => {
        await c.addInitScript(updatingDesktop({ status: 'ready', version: '0.9.0', percent: 100 }))
        await withRelease(c, '0.9.0')
      },
      viewport: { width: 1280, height: 800 },
    }),
  )
  const band = ayse.page.getByTestId('desktop-update')
  await expect(band).toHaveAttribute('data-kind', 'ready')
  await expect(band).toContainText('Güncelleme hazır: 0.9.0')
  await expect(ayse.page.getByTestId('desktop-update-install')).toHaveText('Yeniden başlat ve güncelle')
  // The newer release exists, but the shell owns it: no manual download alongside.
  await expect(ayse.page.getByTestId('desktop-update-download')).toHaveCount(0)
  await ayse.page.screenshot({ path: `${SHOTS}/v10-update-ready.png` })

  // In a voice room: no restart, a calm sentence instead.
  await setState(ayse.page, { inVoice: true })
  await expect(band).toHaveAttribute('data-in-voice', 'true')
  await expect(band).toContainText('Güncelleme hazır: 0.9.0 — sesli odadan çıkınca kurulabilir')
  await expect(ayse.page.getByTestId('desktop-update-install')).toHaveCount(0)
  await ayse.page.getByTestId('btn-settings').click()
  await settingsTab(ayse.page, 'hakkinda')
  await expect(ayse.page.getByTestId('desktop-update-status')).toHaveAttribute('data-status', 'ready')
  await expect(ayse.page.getByTestId('desktop-update-install-settings')).toBeDisabled()
  await expect(ayse.page.getByTestId('desktop-update-in-voice')).toBeVisible()
  await ayse.page.getByTestId('settings-close').click()

  await setState(ayse.page, { inVoice: false })
  await ayse.page.getByTestId('desktop-update-install').click()
  await expect.poll(() => calls(ayse.page)).toEqual(['install'])

  await ayse.page.getByTestId('desktop-update-later').click()
  await expect(band).toHaveCount(0)
})

test('Ayarlar › Hakkında shows the states, checks on demand, and turns automatic download off', async ({ browser, trio }) => {
  const ayse = trio.add(
    await personViaApi(browser, 'Ayşe', {
      prepare: async (c) => {
        await c.addInitScript(updatingDesktop({ status: 'up-to-date' }))
        await withRelease(c, '0.8.0')
      },
    }),
  )
  await expect(ayse.page.getByTestId('composer')).toBeVisible()
  await expect(ayse.page.getByTestId('desktop-update')).toHaveCount(0)
  await ayse.page.getByTestId('btn-settings').click()
  await settingsTab(ayse.page, 'hakkinda')
  const status = ayse.page.getByTestId('desktop-update-status')
  await expect(ayse.page.getByTestId('desktop-version')).toHaveText('Masaüstü uygulaması 0.8.0')
  await expect(status).toHaveText('Güncel')

  await ayse.page.getByTestId('desktop-update-check').click()
  await expect(status).toHaveText('Güncellemeler denetleniyor…')
  await expect(ayse.page.getByTestId('desktop-update-check')).toBeDisabled()

  await setState(ayse.page, { status: 'downloading', version: '0.9.0', percent: 40 })
  await expect(status).toHaveText('İndiriliyor %40')
  await ayse.page.screenshot({ path: `${SHOTS}/v10-update-settings-downloading.png` })

  await setState(ayse.page, { status: 'error', version: null, percent: null, error: 'internet bağlantısı yok' })
  await expect(status).toHaveText('Güncelleme denetlenemedi (internet bağlantısı yok)')
  await expect(ayse.page.getByTestId('desktop-update-check')).toBeEnabled()

  await setState(ayse.page, { status: 'ready', version: '0.9.0', error: null, percent: 100 })
  await expect(status).toContainText('Hazır: 0.9.0')
  await expect(ayse.page.getByTestId('desktop-update-install-settings')).toBeEnabled()

  const auto = ayse.page.getByTestId('desktop-update-auto')
  await expect(auto).toBeChecked()
  await auto.uncheck()
  await expect(auto).not.toBeChecked()
  expect(await calls(ayse.page)).toEqual(['check', 'auto:false'])
})

test('automatic download off: "İndir" asks the shell; a failed self-update offers the direct download', async ({ browser, trio }) => {
  const ayse = trio.add(
    await personViaApi(browser, 'Ayşe', {
      prepare: async (c) => {
        await c.addInitScript(updatingDesktop({ status: 'available', version: '0.9.0', autoDownload: false }))
        await withRelease(c, '0.9.0')
      },
    }),
  )
  const band = ayse.page.getByTestId('desktop-update')
  await expect(band).toHaveAttribute('data-kind', 'available')
  await ayse.page.getByTestId('desktop-update-fetch').click()
  await expect.poll(() => calls(ayse.page)).toEqual(['download'])
  // Downloading: one line with the progress.
  await expect(band).toHaveAttribute('data-kind', 'downloading')
  await expect(band).toContainText('Güncelleme indiriliyor: 0.9.0 (%0)')

  await setState(ayse.page, { status: 'error', error: 'indirilen dosya doğrulanamadı' })
  await expect(band).toHaveAttribute('data-kind', 'manual')
  await expect(ayse.page.getByTestId('desktop-update-download')).toHaveAttribute('href', '/indir/dosya/windows')
  // The app has the updater: no "last manual install" sentence.
  await expect(ayse.page.getByTestId('desktop-update-last')).toHaveCount(0)
})

test('an unsigned Mac app: the reason, and a direct download for its own processor', async ({ browser, trio }) => {
  const ayse = trio.add(
    await personViaApi(browser, 'Ayşe', {
      prepare: async (c) => {
        await c.addInitScript(
          updatingDesktop({ capability: 'manual', reason: 'unsigned-mac', status: 'manual', platform: 'mac-arm64' }),
        )
        await withRelease(c, '0.9.0')
      },
    }),
  )
  const download = ayse.page.getByTestId('desktop-update-download')
  await expect(ayse.page.getByTestId('desktop-update')).toHaveAttribute('data-kind', 'manual')
  await expect(download).toHaveCount(1)
  await expect(download).toHaveAttribute('href', '/indir/dosya/mac-arm64')
  await expect(download).toHaveText('İndir (Apple Silicon)')
  await ayse.page.getByTestId('btn-settings').click()
  await settingsTab(ayse.page, 'hakkinda')
  await expect(ayse.page.getByTestId('desktop-update-reason')).toContainText('imzasız')
  await expect(ayse.page.getByTestId('desktop-update-status')).toHaveCount(0)
  await expect(ayse.page.getByTestId('desktop-update-check')).toHaveCount(0)
  await expect(ayse.page.getByTestId('desktop-update-line-download')).toHaveAttribute('href', '/indir/dosya/mac-arm64')
})

test('a desktop release published while the app is open: the page asks the shell once, the band follows, in a call "odadan çıkınca"', async ({
  browser,
  trio,
}) => {
  let published = '0.9.0'
  const ayse = trio.add(
    await personViaApi(browser, 'Ayşe', {
      prepare: async (c) => {
        await c.addInitScript(updatingDesktop({ status: 'up-to-date', currentVersion: '0.9.0' }))
        await withRelease(c, () => published)
        // The page polls /api/downloads every 5 minutes: the test moves the clock instead of waiting.
        await c.clock.install()
      },
      viewport: { width: 1280, height: 800 },
    }),
  )
  const page = ayse.page
  const band = page.getByTestId('desktop-update')
  await expect(page.getByTestId('composer')).toBeVisible()
  await expect(band).toHaveCount(0)
  await expect(page.getByTestId('desktop-update-dot')).toHaveCount(0)
  expect(await calls(page)).toEqual([])

  // GitHub gets 0.9.1; nobody opens Ayarlar.
  published = '0.9.1'
  await page.clock.fastForward('05:30')
  await expect.poll(() => calls(page)).toEqual(['check'])

  // The shell found it and downloads (during a call too).
  await setState(page, { status: 'downloading', version: '0.9.1', percent: 30 })
  await expect(band).toHaveAttribute('data-kind', 'downloading')
  await expect(band).toContainText('Güncelleme indiriliyor: 0.9.1 (%30)')
  await expect(page.getByTestId('btn-settings').getByTestId('desktop-update-dot')).toBeVisible()
  await setState(page, { inVoice: true })
  await expect(band).toContainText('sesli odadan çıkınca kurulabilir')
  await setState(page, { status: 'ready', percent: 100 })
  await expect(band).toHaveAttribute('data-kind', 'ready')
  await expect(band).toContainText('Güncelleme hazır: 0.9.1 — sesli odadan çıkınca kurulabilir')
  await expect(page.getByTestId('desktop-update-install')).toHaveCount(0)
  await page.screenshot({ path: `${SHOTS}/v10-update-ready-in-voice.png` })

  // Out of the call: the restart is offered.
  await setState(page, { inVoice: false })
  await expect(page.getByTestId('desktop-update-install')).toBeVisible()

  // The shell was asked once, not on every poll.
  await page.clock.fastForward('05:30')
  await page.waitForTimeout(200)
  expect(await calls(page)).toEqual(['check'])
})

test('an app without the update members keeps the manual notice and is never asked to check', async ({ browser, trio }) => {
  const ayse = trio.add(
    await personViaApi(browser, 'Ayşe', {
      prepare: async (c) => {
        await c.addInitScript(`window.trioDesktop = { isDesktop: true, appVersion: '0.7.1', setPttKey() {}, onPtt() { return () => {} }, setVoiceState() {} }`)
        await withRelease(c, '0.9.1')
      },
    }),
  )
  const band = ayse.page.getByTestId('desktop-update')
  await expect(band).toHaveAttribute('data-kind', 'manual')
  await expect(band).toContainText('Masaüstü uygulamasının yeni sürümü var (0.9.1).')
  await expect(ayse.page.getByTestId('desktop-update-dot')).toHaveCount(0)
})
