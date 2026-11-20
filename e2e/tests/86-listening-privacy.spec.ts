/**
 * CONTRACT-V11-ACTIVITY §3, §5: the privacy defaults. Nothing is sent before
 * the first-run notice is answered; "Kapat" turns it off; browsers stay hidden
 * unless the user lets them through; an installed 0.9.x app and a macOS/Linux
 * app send nothing and say why. Screenshots of the notice and of Ayarlar ›
 * Hesap › Durum at 911 px and 150 % (a 1366×768 laptop).
 */
import path from 'node:path'
import type { BrowserContext, Page } from '@playwright/test'
import { freshServer } from '../lib/server'
import { crowd } from '../lib/groups'
import { expect, test } from '../lib/trio'
import { SCREENSHOTS } from '../lib/v7phone'
import { openSettings } from '../lib/ops'
import { fakeDesktop, play, SONG, wishes, type FakeDesktopOptions } from '../lib/v11activity'

const shot = (name: string) => path.join(SCREENSHOTS, `v11-activity-${name}.png`)
const LAPTOP = { viewport: { width: 911, height: 512 }, deviceScaleFactor: 1.5 }
const WIDE = { viewport: { width: 1440, height: 900 } }
const desktop = (options: FakeDesktopOptions) => ({ ...LAPTOP, prepare: (c: BrowserContext) => fakeDesktop(c, options) })

test.beforeEach(async () => {
  await freshServer()
})

const songOf = (page: Page, id: number) => page.getByTestId(`member-listening-${id}`)

test('first run: nothing goes out until “Tamam”; the notice says who sees it', async ({ browser, trio }) => {
  const [ayse, mehmet] = await crowd(browser, trio, 2, (i) => [desktop({}), WIDE][i]!)
  const id = ayse.user.id
  // The watcher runs (the setting is on by default), browsers off.
  await expect.poll(() => wishes(ayse.page)).toEqual([{ on: true, browsers: false }])
  await play(ayse.page, SONG)
  const notice = ayse.page.getByTestId('listen-notice')
  await expect(notice).toHaveText(/Ne dinlediğin sunucudaki herkese görünüyor/)
  await ayse.page.waitForTimeout(1500)
  await expect(songOf(mehmet.page, id)).toHaveCount(0)
  await expect(songOf(ayse.page, id)).toHaveCount(0)
  await ayse.page.screenshot({ path: shot('notice-911') })
  await ayse.page.getByTestId('listen-notice-ok').click()
  await expect(notice).toHaveCount(0)
  await expect(songOf(mehmet.page, id)).toHaveText('mor ve ötesi — Bir Derdim Var')
  // Answered once: a reload does not ask again.
  await ayse.page.reload()
  await expect(ayse.page.getByTestId('composer')).toBeVisible()
  await play(ayse.page, SONG)
  await expect(songOf(mehmet.page, id)).toHaveCount(1)
  await expect(notice).toHaveCount(0)
})

test('“Kapat” on the notice turns the setting off: nothing is ever sent', async ({ browser, trio }) => {
  const [ayse, mehmet] = await crowd(browser, trio, 2, (i) => [desktop({}), WIDE][i]!)
  await play(ayse.page, SONG)
  await ayse.page.getByTestId('listen-notice-off').click()
  await expect(ayse.page.getByTestId('listen-notice')).toHaveCount(0)
  await expect.poll(async () => (await wishes(ayse.page)).at(-1)).toEqual({ on: false, browsers: false })
  await ayse.page.waitForTimeout(1500)
  await expect(songOf(mehmet.page, ayse.user.id)).toHaveCount(0)
  await openSettings(ayse.page, 'hesap')
  await expect(ayse.page.getByTestId('settings-listen-share')).not.toBeChecked()
})

test('browsers are hidden by default; the option lets them through and back', async ({ browser, trio }) => {
  const [ayse, mehmet] = await crowd(browser, trio, 2, (i) => [desktop({ acked: true }), WIDE][i]!)
  const id = ayse.user.id
  await play(ayse.page, { title: 'Kedi videosu', app: 'Chrome' })
  await ayse.page.waitForTimeout(1500)
  await expect(songOf(mehmet.page, id)).toHaveCount(0)
  await openSettings(ayse.page, 'hesap')
  await expect(ayse.page.getByTestId('settings-listen-browsers')).not.toBeChecked()
  await expect(ayse.page.getByTestId('settings-listen-last-app')).toHaveText('Windows’un bildirdiği son oynatıcı: Chrome — gösterilmiyor')
  await ayse.page.getByTestId('settings-listen-last-app').scrollIntoViewIfNeeded()
  await ayse.page.screenshot({ path: shot('settings-911') })
  await ayse.page.getByTestId('settings-listen-browsers').check()
  await expect(songOf(mehmet.page, id)).toHaveText('Kedi videosu')
  await ayse.page.getByTestId('settings-listen-browsers').uncheck()
  await expect(songOf(mehmet.page, id)).toHaveCount(0, { timeout: 1000 })
  // Off for the whole setting disables the sub-option.
  await ayse.page.getByTestId('settings-listen-share').uncheck()
  await expect(ayse.page.getByTestId('settings-listen-browsers')).toBeDisabled()
})

test('an installed 0.9.x app and a macOS/Linux app: nothing is read, Ayarlar says why', async ({ browser, trio }) => {
  const [old, mac, plain] = await crowd(browser, trio, 3, (i) => [desktop({ acked: true, oldApp: true }), desktop({ acked: true, unsupported: true }), WIDE][i]!)
  await openSettings(old.page, 'hesap')
  await expect(old.page.getByTestId('settings-listen-health')).toHaveText('Bu masaüstü sürümü müzik durumunu göstermiyor; uygulamayı güncelle.')
  await expect(old.page.getByTestId('settings-listen-share')).toBeDisabled()
  await openSettings(mac.page, 'hesap')
  await expect(mac.page.getByTestId('settings-listen-health')).toHaveText('Bu sistemde otomatik algılanamıyor.')
  await expect.poll(() => wishes(mac.page)).toEqual([])
  await openSettings(plain.page, 'hesap')
  await expect(plain.page.getByTestId('settings-listen-health')).toContainText('Yalnızca Trio masaüstü uygulamasında')
})
