/**
 * CONTRACT-V6-OPS §1: the owner (the first user here) sees Ayarlar › Yönetim;
 * the others do not, and the API answers them 403.
 */
import { freshServer } from '../lib/server'
import { expect, test } from '../lib/trio'
import { DESKTOP, expectNoSideScroll, openSettings, people, PHONE, status } from '../lib/ops'

test.beforeEach(async () => {
  await freshServer()
})

test('only the owner sees Yönetim, at desktop and at 390 px; the others get 403', async ({ browser, trio }) => {
  const [ayse, mehmet, zeynep] = await people(browser, trio, [DESKTOP, DESKTOP, PHONE])

  await openSettings(ayse.page)
  const owner = ayse.page.getByTestId('owner-section')
  await expect(owner).toBeVisible()
  await expect(owner.getByTestId('owner-user')).toHaveCount(3)
  await expect(owner.getByTestId('owner-user').filter({ hasText: 'Ayşe' })).toContainText('sahip')
  await expect(owner.getByTestId('owner-turn-provider')).toHaveText('Yok (yalnızca STUN)')
  await expect(ayse.page.getByTestId('storage-per-user')).toBeVisible()

  for (const person of [mehmet, zeynep]) {
    await openSettings(person.page)
    await expect(person.page.getByTestId('storage-section')).toBeVisible()
    await expect(person.page.getByTestId('storage-usage')).toHaveText('0 / 1024 MB')
    await expect(person.page.getByTestId('owner-section')).toHaveCount(0)
    await expect(person.page.getByTestId('storage-per-user')).toHaveCount(0)
    expect(await person.page.evaluate(async (token) => (await fetch('/api/me', { headers: { Authorization: `Bearer ${token}` } })).json(), person.token)).toEqual({
      user: person.user.id === mehmet.user.id ? { id: mehmet.user.id, name: 'Mehmet', avatar_url: null } : { id: zeynep.user.id, name: 'Zeynep', avatar_url: null },
    })
    for (const [method, path] of [
      ['GET', '/api/owner/overview'],
      ['GET', '/api/owner/errors'],
      ['POST', '/api/owner/backup-tickets'],
      ['GET', '/api/owner/backup'],
      ['POST', `/api/owner/users/${ayse.user.id}/revoke-tokens`],
    ] as const) {
      expect(await status(person.token, method, path, method === 'POST' ? { confirm_code: 'trio-e2e-davet' } : undefined)).toBe(403)
    }
  }
  expect(await status(null, 'GET', '/api/owner/overview')).toBe(401)
  await expectNoSideScroll(zeynep.page)
  // The owner's settings button carries the red dot: no backup yet.
  await ayse.page.getByTestId('settings-close').click()
  await expect(ayse.page.getByTestId('backup-dot').filter({ visible: true })).toHaveCount(1)
  await expect(mehmet.page.getByTestId('backup-dot')).toHaveCount(0)
})
