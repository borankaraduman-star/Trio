import { freshServer } from '../lib/server'
import { expect, expectConnected, joinThroughUi, NAMES, newContext, personViaUi, test } from '../lib/trio'

test.beforeEach(async () => {
  await freshServer()
})

test('join: wrong code, three users, duplicate name refused, reload keeps the session', async ({ browser, trio }) => {
  // A wrong invite code is refused with a message, and nothing is stored.
  const stranger = await newContext(browser)
  const page = await stranger.newPage()
  await page.goto('/')
  await joinThroughUi(page, 'Yabancı', 'yanlis-kod')
  await expect(page.getByRole('alert')).toHaveText('Davet kodu yanlış.')
  await expect(page.getByTestId('join-name')).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('trio.token'))).toBeNull()

  // Three people join, each in their own browser context.
  const people = []
  for (const name of NAMES) people.push(trio.add(await personViaUi(browser, name)))
  const [ayse, mehmet, zeynep] = people
  for (const person of people) {
    await expect(person.page.locator('.user-panel-name strong')).toHaveText(person.name)
    for (const other of people) {
      await expect(person.page.getByTestId(`member-${other.user.id}`)).toHaveAttribute('data-online', 'true')
    }
  }

  // The same name again, in any case, is refused.
  await page.getByTestId('join-name').fill('ayşe')
  await page.getByTestId('join-code').fill('trio-e2e-davet')
  await page.getByTestId('join-submit').click()
  await expect(page.getByRole('alert')).toHaveText('Bu isim alınmış, başka bir isim dene.')
  await page.getByTestId('join-name').fill('MEHMET')
  await page.getByTestId('join-submit').click()
  await expect(page.getByRole('alert')).toHaveText('Bu isim alınmış, başka bir isim dene.')
  await stranger.close()

  // Reload keeps the session: no join screen, the same user.
  for (const person of [ayse, zeynep]) {
    await person.page.reload()
    await expectConnected(person.page)
    await expect(person.page.getByTestId('join-name')).toHaveCount(0)
    await expect(person.page.locator('.user-panel-name strong')).toHaveText(person.name)
  }
  await expect(mehmet.page.getByTestId(`member-${ayse.user.id}`)).toHaveAttribute('data-online', 'true')
})

test('join: a token the server does not know clears the session', async ({ browser }) => {
  const context = await newContext(browser)
  await context.addInitScript(() => {
    if (!sessionStorage.getItem('seeded')) {
      sessionStorage.setItem('seeded', '1')
      localStorage.setItem('trio.token', 'not-a-real-token')
      localStorage.setItem('trio.user', JSON.stringify({ id: 99, name: 'Hayalet' }))
    }
  })
  const page = await context.newPage()
  await page.goto('/')
  await expect(page.getByTestId('join-name')).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('trio.token'))).toBeNull()
  await context.close()
})
