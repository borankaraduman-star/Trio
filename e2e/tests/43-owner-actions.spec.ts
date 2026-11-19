/**
 * CONTRACT-V6-OPS §2: the owner signs a friend out everywhere from the
 * phone. The invite code is asked again; a wrong one is refused and changes
 * nothing; the right one lands the friend on the join screen at once.
 */
import { freshServer, INVITE_CODE } from '../lib/server'
import { expect, meStatus, test } from '../lib/trio'
import { DESKTOP, expectNoSideScroll, openSettings, people, PHONE } from '../lib/ops'

test.beforeEach(async () => {
  await freshServer()
})

test('the owner revokes a friend’s sessions with the invite code (390 px)', async ({ browser, trio }) => {
  const [ayse, mehmet, zeynep] = await people(browser, trio, [PHONE, DESKTOP, DESKTOP])
  await openSettings(ayse.page, 'yonetim')
  const row = ayse.page.getByTestId('owner-user').filter({ hasText: 'Zeynep' })
  await row.getByTestId('owner-revoke').click()
  const dialog = ayse.page.getByTestId('ops-confirm')
  await expect(dialog).toBeVisible()
  await expectNoSideScroll(ayse.page)

  // A wrong code: refused, Zeynep still in.
  await dialog.getByTestId('ops-confirm-code').fill('yanlis-kod')
  await dialog.getByTestId('ops-confirm-submit').click()
  await expect(dialog.getByTestId('ops-confirm-error')).toHaveText('Davet kodu yanlış.')
  expect(await meStatus(zeynep.token)).toBe(200)
  await expect(zeynep.page.getByTestId('composer')).toBeVisible()

  await dialog.getByTestId('ops-confirm-code').fill(INVITE_CODE)
  await dialog.getByTestId('ops-confirm-submit').click()
  await expect(dialog).toHaveCount(0)
  await expect(ayse.page.getByTestId('owner-notice')).toHaveText('Zeynep: 1 oturum kapatıldı.')
  // At once (no 30-second recheck): the server closed her socket with 4401.
  await expect(zeynep.page.getByTestId('join-notice')).toContainText('Bu cihazdaki oturum kapatıldı', { timeout: 10_000 })
  expect(await meStatus(zeynep.token)).toBe(401)
  expect(await meStatus(mehmet.token)).toBe(200)
  // The account stays: the owner can bring her back with a device code.
  await row.getByTestId('owner-link').click()
  await ayse.page.getByTestId('ops-confirm-code').fill(INVITE_CODE)
  await ayse.page.getByTestId('ops-confirm-submit').click()
  const code = (await ayse.page.getByTestId('owner-link-code').locator('code').textContent()) ?? ''
  expect(code).toMatch(/^\w{5}-\w{5}$/)
  await zeynep.page.getByTestId('join-link-code').fill(code)
  await zeynep.page.getByTestId('join-submit').click()
  await expect(zeynep.page.getByTestId('composer')).toBeVisible()
})
