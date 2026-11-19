/**
 * Mentions in the message list (CONTRACT-V6-PUSH §4): a row that names me — by
 * my name in any case, with Turkish İ/ı folded, or @herkes — has a subtle
 * highlight, and every `@ad` is emphasised (mine more strongly). My own rows
 * and an e-mail address are not mentions. Three people, 390 px; the screenshot
 * `v6-push-mention.png`.
 */
import path from 'node:path'
import { E2E_DIR, freshServer } from '../lib/server'
import { apiJoin, expect, personWithSession, test, type Person } from '../lib/trio'
import { send } from '../lib/messages'

const OUT = path.join(E2E_DIR, 'screenshots')
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 }

test.beforeEach(async () => {
  await freshServer()
})

const row = (person: Person, text: string) => person.page.getByTestId('message').filter({ hasText: text }).last()

test('mention highlight for the three, at 390 px', async ({ browser, trio }) => {
  const people: Person[] = []
  for (const name of ['Ayşe', 'Mehmet', 'Işıl'] as const) people.push(trio.add(await personWithSession(browser, name, await apiJoin(name), PHONE)))
  const [ayse, mehmet, isil] = people

  await send(mehmet.page, '@AYŞE yarın kampa geliyor musun?')
  await send(isil.page, 'ben de geliyorum, @mehmet arabayı sen mi alıyorsun?')
  await send(mehmet.page, '@herkes sabah 7’de çıkıyoruz')
  await send(ayse.page, 'tamam @IŞIL, mail at: isil@example.com')
  for (const person of people) await expect(row(person, 'mail at')).toHaveAttribute('data-status', 'sent')

  const highlighted = async (person: Person) =>
    person.page.getByTestId('message').evaluateAll((rows) =>
      rows.filter((r) => r.classList.contains('mentions-me')).map((r) => r.querySelector('.message-content')?.textContent ?? ''),
    )
  expect(await highlighted(ayse)).toEqual(['@AYŞE yarın kampa geliyor musun?', '@herkes sabah 7’de çıkıyoruz'])
  expect(await highlighted(mehmet)).toEqual(['ben de geliyorum, @mehmet arabayı sen mi alıyorsun?'])
  expect(await highlighted(isil)).toEqual(['@herkes sabah 7’de çıkıyoruz', 'tamam @IŞIL, mail at: isil@example.com'])

  // The emphasis: every mention, "mine" in the accent; the e-mail is plain text.
  const mentions = row(ayse, 'mail at').getByTestId('mention')
  await expect(mentions).toHaveText(['@IŞIL'])
  await expect(mentions).not.toHaveClass(/mention-me/)
  await expect(row(isil, 'mail at').getByTestId('mention')).toHaveClass(/mention-me/)
  await expect(row(ayse, 'yarın kampa').getByTestId('mention')).toHaveClass(/mention-me/)
  // My own message is not "about me" even when it names me.
  await send(ayse.page, 'not: @ayşe ben')
  await expect(row(ayse, 'not: @ayşe')).not.toHaveClass(/mentions-me/)
  await expect(row(mehmet, 'not: @ayşe')).not.toHaveClass(/mentions-me/)

  // No horizontal overflow at phone width.
  expect(await ayse.page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await ayse.page.screenshot({ path: path.join(OUT, 'v6-push-mention.png') })
})
