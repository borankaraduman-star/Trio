/**
 * CONTRACT-V6-OPS §3: the owner downloads a backup from the UI (a plain
 * browser download through a single-use ticket), the archive verifies, and
 * the "Son yedek" line shows the counts the archive holds.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { freshServer } from '../lib/server'
import { expect, sendThroughUi, test } from '../lib/trio'
import { DESKTOP, expectNoSideScroll, openSettings, people, PHONE, sendFiles, verifyArchive } from '../lib/ops'

test.beforeEach(async () => {
  await freshServer()
})

for (const [label, viewport] of [
  ['desktop', DESKTOP],
  ['390 px', PHONE],
] as const) {
  test(`the owner downloads a backup that verifies (${label})`, async ({ browser, trio }) => {
    const [ayse, mehmet] = await people(browser, trio, [viewport, DESKTOP, DESKTOP])
    await sendThroughUi(mehmet, 'Yedekten önce bir mesaj')
    await sendFiles(mehmet, 'İki dosya', [
      { name: 'notlar.txt', mimeType: 'text/plain', buffer: Buffer.from('not\n'.repeat(500)) },
      { name: 'liste.csv', mimeType: 'text/csv', buffer: Buffer.from('a,b\n1,2\n') },
    ])
    await sendThroughUi(ayse, 'Ben de buradayım')
    await expect(ayse.page.getByTestId('backup-dot').filter({ visible: true })).toHaveCount(1)

    await openSettings(ayse.page)
    const card = ayse.page.getByTestId('owner-backup')
    await expect(card.getByTestId('owner-last-backup')).toHaveText('Henüz yedek alınmadı.')
    const download = ayse.page.waitForEvent('download')
    await card.getByTestId('owner-backup-download').click()
    const file = await download
    expect(file.suggestedFilename()).toMatch(/^trio-yedek-\d{4}-\d{2}-\d{2}-\d{4}\.tar$/)
    const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'trio-e2e-backup-')), file.suggestedFilename())
    await file.saveAs(target)

    const verified = verifyArchive(target)
    expect(verified).toContain('ok: integrity_check passed')
    const messages = Number(/(\d+) messages/.exec(verified)?.[1])
    const files = Number(/(\d+) files/.exec(verified)?.[1])
    expect(messages).toBe(3)
    expect(files).toBe(2)

    await expect(card.getByTestId('owner-backup-done')).toBeVisible()
    await expect(card.getByTestId('owner-last-backup')).toHaveText(`Son yedek: az önce · ${messages} mesaj, ${files} dosya`)
    await expect(card).not.toHaveClass(/stale/)
    if (label === '390 px') await expectNoSideScroll(ayse.page)
    await ayse.page.getByTestId('settings-close').click()
    await expect(ayse.page.getByTestId('backup-dot')).toHaveCount(0)
    fs.rmSync(path.dirname(target), { recursive: true, force: true })
  })
}
