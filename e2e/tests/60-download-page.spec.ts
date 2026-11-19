/**
 * CONTRACT-V6-DOWNLOAD: /indir against a fake GitHub release. The visitor's
 * system is the primary button; the others, sizes, dates and SHA-256 follow;
 * a phone is told Trio runs in its browser.
 */
import { test, expect } from '@playwright/test'
import { FakeGitHub, NAMES, SHA, UA, VERSION, serverWithFake, visit } from '../lib/downloads'

const fake = new FakeGitHub()

test.beforeAll(async () => {
  await fake.start()
})
test.afterAll(async () => {
  await fake.stop()
})
test.beforeEach(async () => {
  fake.mode = 'ok'
  fake.signing = null
  await serverWithFake(fake)
})

test('Windows: the .exe is the primary button, with version, date, size and SHA-256', async ({ browser }) => {
  const v = await visit(browser, { userAgent: UA.windows })
  const { page } = v
  await expect(page).toHaveTitle("Trio'yu indir")
  const primary = page.getByTestId('indir-primary')
  await expect(primary).toHaveText('Windows için indir')
  await expect(primary).toHaveAttribute('href', '/indir/dosya/windows')
  await expect(page.getByTestId('indir-primary-meta')).toHaveText(`Sürüm ${VERSION} · 18 Kasım 2026 · 92 MB`)
  const rows = page.getByTestId('indir-file')
  await expect(rows).toHaveCount(4)
  await expect(rows.first()).toHaveAttribute('data-platform', 'windows')
  await expect(rows.first().getByTestId('indir-sha')).toHaveText(SHA.windows)
  await expect(page.locator('[data-platform="mac-x64"]')).toContainText('bu dosya için yayımlanmadı')
  await expect(page.getByTestId('indir-browser')).toHaveAttribute('href', '/')

  // The warning help for an unsigned build: Windows open, the drawing, the hash check.
  await expect(page.getByTestId('indir-why')).toBeVisible()
  await expect(page.getByTestId('indir-help-windows')).toHaveAttribute('open', '')
  await expect(page.getByTestId('indir-help-mac')).not.toHaveAttribute('open', '')
  await expect(page.getByTestId('indir-smartscreen')).toContainText('Daha fazla bilgi')
  await expect(page.getByTestId('indir-smartscreen')).toContainText('Yine de çalıştır')
  await expect(page.getByTestId('indir-powershell')).toHaveText(
    `(Get-FileHash "$env:USERPROFILE\\Downloads\\${NAMES.windows}" -Algorithm SHA256).Hash -eq "${SHA.windows.toUpperCase()}"`,
  )
  await v.context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.getByTestId('indir-help-windows').getByTestId('indir-copy').click()
  await expect(page.getByTestId('indir-help-windows').getByTestId('indir-copy')).toHaveText('Kopyalandı')
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('Get-FileHash')
  await v.close()
})

test('macOS: Apple Silicon first unless the browser says Intel; Linux gets the AppImage', async ({ browser }) => {
  const mac = await visit(browser, { userAgent: UA.mac })
  // Headless Chromium reports its real (x86) architecture through the client hint, so read what it chose.
  const chosen = await mac.page.getByTestId('indir-primary').getAttribute('data-platform')
  expect(['mac-arm64', 'mac-x64']).toContain(chosen)
  await expect(mac.page.getByTestId('indir-primary')).toHaveText(
    chosen === 'mac-arm64' ? 'Mac (Apple Silicon) için indir' : 'Mac (Intel) için indir',
  )
  await expect(mac.page.getByTestId('indir-help-mac')).toHaveAttribute('open', '')
  await expect(mac.page.getByTestId('indir-help-mac')).toContainText('Yine de Aç')
  await mac.close()

  const linux = await visit(browser, { userAgent: UA.linux })
  await expect(linux.page.getByTestId('indir-primary')).toHaveAttribute('data-platform', 'linux')
  await expect(linux.page.getByTestId('indir-chmod')).toHaveText(`chmod +x "$(xdg-user-dir DOWNLOAD)/${NAMES.linux}"`)
  await linux.close()
})

test('a phone is told Trio runs in its browser', async ({ browser }) => {
  for (const userAgent of [UA.android, UA.iphone]) {
    const v = await visit(browser, { userAgent, width: 390, height: 844, isMobile: true })
    await expect(v.page.getByTestId('indir')).toHaveAttribute('data-visitor', 'phone')
    await expect(v.page.getByTestId('indir-phone')).toContainText('Trio telefonda tarayıcıdan çalışır.')
    await expect(v.page.getByTestId('indir-phone')).toContainText('Ana ekrana ekle')
    await expect(v.page.getByTestId('indir-open-app')).toHaveAttribute('href', '/')
    await expect(v.page.getByTestId('indir-primary')).toHaveCount(0)
    await expect(v.page.getByTestId('indir-help')).toHaveCount(0)
    // The desktop files are still listed, for somebody reading on a phone.
    await expect(v.page.getByTestId('indir-file')).toHaveCount(4)
    await v.close()
  }
})

test('the join screen links the page, except inside the desktop app; /download leads there', async ({ browser }) => {
  const web = await visit(browser, { userAgent: UA.windows, path: '/' })
  const link = web.page.getByTestId('download-link')
  await expect(link).toHaveText('Masaüstü uygulamasını indir')
  await expect(link).toHaveAttribute('href', '/indir')
  await web.close()

  const app = await visit(browser, { userAgent: UA.windows, path: '/', desktop: true })
  await expect(app.page.getByTestId('join-form')).toBeVisible()
  await expect(app.page.getByTestId('download-link')).toHaveCount(0)
  await app.close()

  const old = await visit(browser, { userAgent: UA.windows, path: '/download' })
  await expect(old.page).toHaveURL(/\/indir$/)
  await expect(old.page.getByTestId('indir-primary')).toBeVisible()
  await old.close()
})
