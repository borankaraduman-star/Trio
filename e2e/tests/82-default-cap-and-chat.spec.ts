/**
 * CONTRACT-V10-GROUPS §2, §5 with the server's defaults (15 accounts, 8 per
 * voice room): fifteen people sign up, eight storm into the room at once and
 * all connect, the ninth sees "Oda dolu (8/8)", and text keeps up with nine
 * open tabs (every message to every tab, in order; several typing at once).
 */
import { freshServer } from '../lib/server'
import { crowd, expectEverybodyHearing, expectFullMesh, GROUP_NAMES, joinAllAtOnce, seedAccounts } from '../lib/groups'
import { expect, GENEL, SOHBET, test } from '../lib/trio'

test.beforeEach(async () => {
  await freshServer()
})

test('defaults: eight in a room at once, the ninth is told it is full; nine tabs keep up with the chat', async ({ browser, trio }) => {
  test.setTimeout(360_000)
  const people = await crowd(browser, trio, 9)
  await seedAccounts(GROUP_NAMES.slice(9))
  // The sixteenth account is refused: the default is fifteen.
  const response = await fetch(`${new URL(people[0].page.url()).origin}/api/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.251' },
    body: JSON.stringify({ invite_code: 'trio-e2e-davet', name: 'Nur' }),
  })
  expect(response.status).toBe(409)
  expect(((await response.json()) as { error: { code: string } }).error.code).toBe('SERVER_FULL')

  const room = people.slice(0, 8)
  const ninth = people[8]
  await joinAllAtOnce(room)
  const meshMs = await expectFullMesh(room, 120_000)
  console.log(`[82] eight joined at once: 28 pairs connected after ${meshMs} ms`)
  await expectEverybodyHearing(room, 90_000)

  const channel = ninth.page.getByTestId(`channel-${SOHBET}`)
  await expect(channel).toHaveAttribute('data-room-full', 'true')
  await expect(ninth.page.getByTestId(`room-count-${SOHBET}`)).toHaveText('Oda dolu (8/8)')
  await channel.click({ force: true })
  await expect(ninth.page.getByTestId(`room-full-note-${SOHBET}`)).toContainText('en çok 8 kişi')
  await expect(ninth.page.locator('.voice-panel')).toHaveCount(0)
  // The members see their own count, not "full".
  await expect(room[3].page.getByTestId(`room-count-${SOHBET}`)).toHaveText('8/8')

  // Text: each of the nine sends three messages at the same time; every tab gets all 27, in order.
  await Promise.all(
    people.map(async (person) => {
      for (let i = 1; i <= 3; i += 1) {
        await person.page.getByTestId('composer').fill(`${person.name} ${i}`)
        await person.page.getByTestId('composer').press('Enter')
      }
    }),
  )
  for (const person of people) {
    await expect(person.page.getByTestId('message')).toHaveCount(27, { timeout: 30_000 })
    const ids = await person.page.getByTestId('message').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-status')))
    expect(ids.every((status) => status === 'sent')).toBe(true)
  }
  // The order is the server's (ids), the same in every tab.
  const order = await people[0].page.getByTestId('message').allTextContents()
  for (const person of people.slice(1)) expect(await person.page.getByTestId('message').allTextContents()).toEqual(order)

  // Four typing at once: the ninth reads one short line, not four names.
  await Promise.all(people.slice(0, 4).map((person) => person.page.getByTestId('composer').pressSequentially('yazıyorum', { delay: 30 })))
  await expect(ninth.page.getByTestId('typing')).toContainText('Birkaç kişi yazıyor')
})
