/**
 * CONTRACT-V6-OPS §4: a member deletes one of their own files in Ayarlar ›
 * Depolama; every open client shows "dosya silindi" in its place, and the
 * usage drops. Nobody can delete somebody else's file.
 */
import { freshServer } from '../lib/server'
import { api, expect, test } from '../lib/trio'
import { DESKTOP, expectNoSideScroll, openSettings, people, PHONE, sendFiles, status } from '../lib/ops'
import { settingsTab } from '../lib/v7phone'

test.beforeEach(async () => {
  await freshServer()
})

const KB = 1024

test('a member deletes their own file: everybody sees the tombstone, the usage drops', async ({ browser, trio }) => {
  const [ayse, mehmet, zeynep] = await people(browser, trio, [DESKTOP, DESKTOP, PHONE])
  const caption = 'Tatil dosyaları'
  await sendFiles(mehmet, caption, [
    { name: 'buyuk-rapor.pdf', mimeType: 'application/pdf', buffer: Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(3000 * KB, 7)]) },
    { name: 'kucuk-not.txt', mimeType: 'text/plain', buffer: Buffer.from('küçük not\n') },
  ])
  await sendFiles(zeynep, 'Benim dosyam', [{ name: 'zeynep.txt', mimeType: 'text/plain', buffer: Buffer.from('z\n') }])
  for (const person of [ayse, mehmet, zeynep]) {
    await expect(person.page.getByTestId('message').filter({ hasText: caption }).getByTestId('attachment-file')).toHaveCount(2)
  }

  // Somebody else's file: 403, for the API and therefore for any client.
  const theirs = await api<{ attachments: { id: string }[] }>(zeynep.token, '/api/me/storage')
  expect(await status(mehmet.token, 'DELETE', `/api/attachments/${theirs.attachments[0].id}`)).toBe(403)

  await openSettings(mehmet.page)
  const section = mehmet.page.getByTestId('storage-section')
  await expect(section.getByTestId('storage-usage')).toHaveText('2,9 / 1024 MB')
  const before = Number(await section.getByTestId('storage-bar').getAttribute('data-used'))
  // Largest first: the report is on top. Mehmet sees only his own files.
  await expect(section.getByTestId('storage-file')).toHaveCount(2)
  const big = section.getByTestId('storage-file').first()
  await expect(big).toContainText('buyuk-rapor.pdf')
  await expect(big).toContainText(caption)
  await big.getByTestId('storage-delete').click()
  await big.getByTestId('storage-delete-confirm').click()
  await expect(section.getByTestId('storage-file')).toHaveCount(1)
  await expect(section.getByTestId('storage-usage')).toHaveText('0 / 1024 MB')
  const after = Number(await section.getByTestId('storage-bar').getAttribute('data-used'))
  expect(after).toBeLessThan(before)
  expect(after).toBe(Buffer.from('küçük not\n').length)
  await mehmet.page.getByTestId('settings-close').click()

  // All three: the message keeps the small file and shows a tombstone for the big one.
  for (const person of [ayse, mehmet, zeynep]) {
    const message = person.page.getByTestId('message').filter({ hasText: caption })
    await expect(message.getByTestId('attachment-deleted')).toHaveText(/dosya silindi/)
    await expect(message.getByTestId('attachment-deleted')).toContainText('buyuk-rapor.pdf')
    await expect(message.getByTestId('attachment-file')).toHaveCount(1)
    await expect(message.getByTestId('attachment-file')).toContainText('kucuk-not.txt')
  }
  await expectNoSideScroll(zeynep.page)
  // After a reload (history from REST) it is still a tombstone.
  await ayse.page.reload()
  await expect(ayse.page.getByTestId('message').filter({ hasText: caption }).getByTestId('attachment-deleted')).toHaveCount(1)
  // The owner's per-user totals follow.
  await openSettings(ayse.page)
  await expect(ayse.page.getByTestId('storage-per-user')).toContainText('Mehmet')
  await settingsTab(ayse.page, 'yonetim')
  await expect(ayse.page.getByTestId('owner-user').filter({ hasText: 'Mehmet' })).toContainText('1 dosya')
})
