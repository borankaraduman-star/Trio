/**
 * CONTRACT-V6-OPS §1: the owner (the first user here) sees Ayarlar › Yönetim;
 * the others do not, and the API answers them 403.
 */
import { baseUrl, freshServer } from '../lib/server'
import { expect, newContext, test } from '../lib/trio'
import { DESKTOP, expectNoSideScroll, openSettings, people, PHONE, SCREENSHOTS, status } from '../lib/ops'

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

test('on Railway without a volume: a red band for everybody, the join screen included, and the steps in Yönetim', async ({
  browser,
  trio,
}) => {
  // RAILWAY_ENVIRONMENT says "on Railway"; TRIO_PERSISTENT_OVERRIDE (test only,
  // CONTRACT-V6-OPS §7) stands in for "no volume mounted", which a test machine cannot show.
  await freshServer({ RAILWAY_ENVIRONMENT: 'production', TRIO_PERSISTENT_OVERRIDE: 'false' })
  const [ayse, mehmet, zeynep] = await people(browser, trio, [DESKTOP, DESKTOP, PHONE])
  const text = 'Kalıcı disk bağlı değil: bir sonraki güncellemede her şey silinir.'
  for (const person of [ayse, mehmet, zeynep]) {
    await expect(person.page.getByTestId('persistence-band')).toHaveText(text)
    // It cannot be closed: no button inside, and it stays across a reload.
    await expect(person.page.getByTestId('persistence-band').locator('button')).toHaveCount(0)
  }
  await expectNoSideScroll(zeynep.page)
  // The composer is still reachable under the band on the phone.
  await expect(zeynep.page.getByTestId('composer')).toBeInViewport()

  // The join screen, signed out.
  const stranger = await newContext(browser, PHONE)
  const page = await stranger.newPage()
  await page.goto('/')
  await expect(page.getByTestId('join-form')).toBeVisible()
  await expect(page.getByTestId('persistence-band')).toHaveText(text)
  await stranger.close()

  // Yönetim: the steps to attach a volume, the owner rule and the free seats.
  await openSettings(ayse.page)
  await expect(ayse.page.getByTestId('owner-volume-steps')).toContainText('/data')
  await expect(ayse.page.getByTestId('owner-warning-owner')).toContainText('sahip = ilk katılan')
  await expect(ayse.page.getByTestId('owner-warning-seats')).toContainText('2 boş yer var')
  await expect(ayse.page.getByTestId('owner-data-age')).toHaveText('birkaç dakikadır, 1. başlatma')
  await ayse.page.getByTestId('owner-volume-steps').scrollIntoViewIfNeeded()
  await ayse.page.screenshot({ path: `${SCREENSHOTS}/v6-ops-kalici-disk.png`, animations: 'disabled', caret: 'hide' })
  await zeynep.page.screenshot({ path: `${SCREENSHOTS}/v6-ops-kalici-disk-390.png`, animations: 'disabled', caret: 'hide' })

  // The deploy that wipes a volume-less disk: the same server comes back with a new database.
  // Mehmet's open page loses its session to a database that never knew him.
  await expect.poll(() => mehmet.page.evaluate(() => localStorage.getItem('trio.dataSince'))).not.toBeNull()
  await freshServer({ RAILWAY_ENVIRONMENT: 'production', TRIO_PERSISTENT_OVERRIDE: 'false' })
  await expect(mehmet.page.getByTestId('join-notice')).toHaveText('Sunucu sıfırlandı, herkes yeniden katılmalı.', {
    timeout: 30_000,
  })
})

test('a persistent server shows no band', async ({ browser, trio }) => {
  await freshServer({ RAILWAY_ENVIRONMENT: 'production', TRIO_PERSISTENT_OVERRIDE: 'true' })
  const [ayse] = await people(browser, trio)
  await expect(ayse.page.getByTestId('composer')).toBeVisible()
  await expect(ayse.page.getByTestId('persistence-band')).toHaveCount(0)
  expect(((await (await fetch(`${baseUrl()}/api/health`)).json()) as { persistent: boolean }).persistent).toBe(true)
})
