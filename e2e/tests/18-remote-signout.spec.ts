/**
 * CONTRACT-V3 §3: the admin tool, run against the live database while
 * everybody is connected. REST notices at once; open sockets within the
 * server's 30-second re-check, which closes them with 4401 and broadcasts
 * `user.removed`.
 */
import { admin, freshServer } from '../lib/server'
import { expect, expectConnected, joinVoice, meStatus, sendThroughUi, test, threePeople } from '../lib/trio'

/** The server re-checks open sockets every 30 s (TOKEN_RECHECK_SECONDS); a margin for the round trip. */
const RECHECK = { timeout: 40_000 }

test.beforeEach(async () => {
  await freshServer()
})

test('revoke-tokens and remove-user end the open sessions; the removed user leaves the lists, not the history', async ({
  browser,
  trio,
}) => {
  test.setTimeout(120_000)
  const [ayse, mehmet, zeynep] = await threePeople(browser, trio)
  await sendThroughUi(zeynep, 'Ben bu akşam yokum, kusura bakmayın')
  await sendThroughUi(mehmet, 'Tamam, sonra görüşürüz')
  await joinVoice(ayse)
  await joinVoice(zeynep)
  await expect(ayse.page.getByTestId(`voice-user-${zeynep.user.id}`)).toHaveCount(1)
  await expect(ayse.page.getByTestId(`remote-audio-${zeynep.user.id}`)).toHaveCount(1, { timeout: 20_000 })

  expect(admin('revoke-tokens', 'Mehmet')).toContain('Mehmet')
  expect(admin('remove-user', 'zeynep')).toContain('Zeynep')
  // Every REST request reads the database: at once.
  expect(await meStatus(mehmet.token)).toBe(401)
  expect(await meStatus(zeynep.token)).toBe(401)
  expect(await meStatus(ayse.token)).toBe(200)

  // The open pages land on the join screen with the notice, within the re-check.
  for (const person of [mehmet, zeynep]) {
    await expect(person.page.getByTestId('join-notice')).toContainText('Bu cihazdaki oturum kapatıldı', RECHECK)
    await expect(person.page.getByTestId('join-form')).toHaveAttribute('data-mode', 'link')
    expect(await person.page.evaluate(() => localStorage.getItem('trio.token'))).toBeNull()
  }

  // Zeynep is gone from Ayşe's member list and voice room; her message stays, under her name.
  await expect(ayse.page.getByTestId(`member-${zeynep.user.id}`)).toHaveCount(0, RECHECK)
  await expect(ayse.page.getByTestId(`member-${mehmet.user.id}`)).toHaveCount(1)
  await expect(ayse.page.getByTestId(`voice-user-${zeynep.user.id}`)).toHaveCount(0)
  await expect(ayse.page.getByTestId(`remote-audio-${zeynep.user.id}`)).toHaveCount(0)
  const hers = ayse.page.getByTestId('message').filter({ hasText: 'Ben bu akşam yokum' })
  await expect(hers).toHaveAttribute('data-author-id', String(zeynep.user.id))
  await expect(hers.locator('.message-header strong')).toHaveText('Zeynep')
  await expect(hers.getByTestId('author-former')).toHaveText('eski üye')
  // A reload (history from REST) still shows it, still under her name.
  await ayse.page.reload()
  await expectConnected(ayse.page)
  await expect(ayse.page.getByTestId('message').filter({ hasText: 'Ben bu akşam yokum' }).locator('.message-header strong')).toHaveText('Zeynep')
  await expect(ayse.page.getByTestId(`member-${zeynep.user.id}`)).toHaveCount(0)

  // Mehmet's account stayed: a code from the admin tool brings him back as himself.
  const printed = admin('new-link-code', 'Mehmet')
  const code = /link code for Mehmet: ([2-9A-Z]{10})/.exec(printed)?.[1]
  expect(code).toBeTruthy()
  await mehmet.page.getByTestId('join-link-code').fill(code!)
  const back = mehmet.page.waitForResponse((r) => r.url().endsWith('/api/join'))
  await mehmet.page.getByTestId('join-submit').click()
  expect(((await (await back).json()) as { user: unknown }).user).toEqual(mehmet.user)
  await expectConnected(mehmet.page)
  await expect(mehmet.page.getByTestId('message').filter({ hasText: 'Ben bu akşam yokum' }).getByTestId('author-former')).toHaveCount(1)
})
