import { freshServer } from '../lib/server'
import { expect, personWithSession, test, threePeople } from '../lib/trio'
import type { Person } from '../lib/trio'

test.beforeEach(async () => {
  await freshServer()
})

test('presence: online dots follow contexts opening and closing', async ({ browser, trio }) => {
  const people = await threePeople(browser, trio)
  const [ayse, mehmet, zeynep] = people

  const dot = (viewer: Person, subject: Person) => viewer.page.getByTestId(`member-${subject.user.id}`)
  for (const viewer of people) for (const subject of people) {
    await expect(dot(viewer, subject)).toHaveAttribute('data-online', 'true')
  }

  // Zeynep has a second tab: closing ONE of hers keeps her online.
  const second = await zeynep.context.newPage()
  await second.goto('/')
  await expect(second.getByTestId('composer')).toBeVisible()
  await second.close()
  // A message sent after the close arrives after any presence frame the close caused.
  await zeynep.page.getByTestId('composer').fill('hâlâ buradayım')
  await zeynep.page.getByTestId('composer').press('Enter')
  await expect(ayse.page.getByTestId('message').last()).toContainText('hâlâ buradayım')
  await expect(dot(ayse, zeynep)).toHaveAttribute('data-online', 'true')

  // Closing her whole browser context takes her offline for both others.
  await zeynep.context.close()
  for (const viewer of [ayse, mehmet]) {
    await expect(dot(viewer, zeynep)).toHaveAttribute('data-online', 'false')
    await expect(dot(viewer, zeynep).locator('.dot')).not.toHaveClass(/online/)
    await expect(viewer.page.locator('.members')).toContainText('Çevrimdışı — 1')
  }

  // Mehmet goes too; Ayşe sees both offline.
  await mehmet.context.close()
  await expect(dot(ayse, mehmet)).toHaveAttribute('data-online', 'false')
  await expect(ayse.page.locator('.members')).toContainText('Çevrimiçi — 1')

  // Mehmet comes back with his stored session.
  const again = trio.add(await personWithSession(browser, mehmet.name, mehmet))
  await expect(dot(ayse, again)).toHaveAttribute('data-online', 'true')
  await expect(dot(again, ayse)).toHaveAttribute('data-online', 'true')
  await expect(dot(again, zeynep)).toHaveAttribute('data-online', 'false')
})
