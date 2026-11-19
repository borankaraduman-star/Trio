/**
 * CONTRACT-V6-OPS §5 and §6: a client error reaches the owner's list; the
 * screenshots of Yönetim and Depolama at desktop and 390 px.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { freshServer } from '../lib/server'
import { expect, sendThroughUi, test } from '../lib/trio'
import { DESKTOP, openSettings, people, PHONE, SCREENSHOTS, sendFiles } from '../lib/ops'
import { settingsTab } from '../lib/v7phone'

test.beforeEach(async () => {
  await freshServer()
})

async function shot(page: Page, name: string, testId: string): Promise<void> {
  fs.mkdirSync(SCREENSHOTS, { recursive: true })
  const section = page.getByTestId(testId)
  await section.scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(SCREENSHOTS, name), animations: 'disabled', caret: 'hide' })
}

test('a forced client error shows up in the owner’s list, with its count', async ({ browser, trio }) => {
  const [ayse, mehmet] = await people(browser, trio)
  const reported = mehmet.page.waitForResponse((r) => r.url().endsWith('/api/client-errors'))
  await mehmet.page.evaluate(() => {
    setTimeout(() => {
      throw new Error('e2e zorlanmış hata')
    })
  })
  expect((await reported).status()).toBe(204)
  // A rejection is reported too.
  const rejected = mehmet.page.waitForResponse((r) => r.url().endsWith('/api/client-errors'))
  await mehmet.page.evaluate(() => {
    void Promise.reject(new TypeError('e2e reddedilen söz'))
  })
  expect((await rejected).status()).toBe(204)

  await openSettings(ayse.page, 'yonetim')
  const list = ayse.page.getByTestId('owner-errors')
  const row = list.getByTestId('owner-error').filter({ hasText: 'e2e zorlanmış hata' })
  await expect(row).toHaveCount(1)
  await expect(row).toContainText('×1')
  await expect(row).toContainText('Mehmet')
  await expect(list.getByTestId('owner-error').filter({ hasText: 'TypeError: e2e reddedilen söz' })).toHaveCount(1)
  await list.getByTestId('owner-errors-clear').click()
  await expect(list.getByTestId('owner-error')).toHaveCount(0)
})

for (const [suffix, viewport] of [
  ['', DESKTOP],
  ['-390', PHONE],
] as const) {
  test(`screenshots: Yönetim and Depolama${suffix || ' (desktop)'}`, async ({ browser, trio }) => {
    const [ayse, mehmet] = await people(browser, trio, [viewport, DESKTOP, DESKTOP])
    await sendThroughUi(mehmet, 'Hafta sonu planı')
    await sendFiles(mehmet, 'Fotoğraflar', [
      { name: 'kapadokya-balon.pdf', mimeType: 'application/pdf', buffer: Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(1800 * 1024, 3)]) },
    ])
    await sendFiles(ayse, 'Benim notlarım', [
      { name: 'yol-haritasi.pdf', mimeType: 'application/pdf', buffer: Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(4200 * 1024, 1)]) },
      { name: 'alisveris-listesi.txt', mimeType: 'text/plain', buffer: Buffer.from('ekmek\nsu\n') },
    ])
    const reported = mehmet.page.waitForResponse((r) => r.url().endsWith('/api/client-errors'))
    await mehmet.page.evaluate(() => {
      setTimeout(() => {
        throw new TypeError("Cannot read properties of undefined (reading 'id')")
      })
    })
    await reported

    await openSettings(ayse.page, 'yonetim')
    await expect(ayse.page.getByTestId('owner-errors').getByTestId('owner-error')).toHaveCount(1)
    await settingsTab(ayse.page, 'depolama')
    await expect(ayse.page.getByTestId('storage-file')).toHaveCount(2)
    await shot(ayse.page, `v6-ops-depolama${suffix}.png`, 'storage-section')
    await settingsTab(ayse.page, 'yonetim')
    await ayse.page.getByTestId('owner-section').scrollIntoViewIfNeeded()
    await shot(ayse.page, `v6-ops-yonetim${suffix}.png`, 'owner-section')
    await shot(ayse.page, `v6-ops-yonetim-hatalar${suffix}.png`, 'owner-errors')
    await ayse.page.getByTestId('owner-user').filter({ hasText: 'Mehmet' }).getByTestId('owner-remove').click()
    await expect(ayse.page.getByTestId('ops-confirm')).toBeVisible()
    await ayse.page.screenshot({ path: path.join(SCREENSHOTS, `v6-ops-onay${suffix}.png`), animations: 'disabled', caret: 'hide' })
  })
}
