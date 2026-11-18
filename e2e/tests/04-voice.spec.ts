import { freshServer } from '../lib/server'
import { expect, expectHearing, joinVoice, SOHBET, test, threePeople, type Person } from '../lib/trio'

test.beforeEach(async () => {
  await freshServer()
})

const row = (viewer: Person, subject: Person) => viewer.page.getByTestId(`voice-user-${subject.user.id}`)

async function expectRoom(viewers: Person[], members: Person[]): Promise<void> {
  for (const viewer of viewers) {
    await expect(viewer.page.locator(`[data-testid^="voice-user-"]`)).toHaveCount(members.length)
    for (const member of members) await expect(row(viewer, member)).toBeVisible()
  }
}

test('voice: three people hear each other; mute, deafen and hang-up propagate', async ({ browser, trio }) => {
  test.setTimeout(150_000)
  const people = await threePeople(browser, trio)
  const [ayse, mehmet, zeynep] = people

  for (const person of people) await joinVoice(person)
  await expectRoom(people, people)

  // Every page really receives audio from both others.
  for (const listener of people) {
    await expect(listener.page.locator('audio[data-testid^="remote-audio-"]')).toHaveCount(2)
    for (const speaker of people) if (speaker !== listener) await expectHearing(listener, speaker)
  }

  // Mute: shown to the others, and the track is really disabled.
  await mehmet.page.getByTestId('btn-mute').click()
  await expect(mehmet.page.getByTestId('btn-mute')).toHaveAttribute('aria-pressed', 'true')
  for (const viewer of people) {
    await expect(row(viewer, mehmet)).toHaveAttribute('data-muted', 'true')
    await expect(row(viewer, mehmet)).toHaveAttribute('data-deafened', 'false')
  }
  await mehmet.page.getByTestId('btn-mute').click()
  for (const viewer of people) await expect(row(viewer, mehmet)).toHaveAttribute('data-muted', 'false')

  // Deafen implies muted, and silences the remote audio elements.
  await zeynep.page.getByTestId('btn-deafen').click()
  for (const viewer of people) {
    await expect(row(viewer, zeynep)).toHaveAttribute('data-deafened', 'true')
    await expect(row(viewer, zeynep)).toHaveAttribute('data-muted', 'true')
  }
  const elementsMuted = () =>
    zeynep.page.evaluate(() =>
      [...document.querySelectorAll<HTMLAudioElement>('audio[data-testid^="remote-audio-"]')].map((a) => a.muted),
    )
  expect(await elementsMuted()).toEqual([true, true])
  await zeynep.page.getByTestId('btn-deafen').click()
  for (const viewer of people) {
    await expect(row(viewer, zeynep)).toHaveAttribute('data-deafened', 'false')
    await expect(row(viewer, zeynep)).toHaveAttribute('data-muted', 'false')
  }
  expect(await elementsMuted()).toEqual([false, false])

  // Hang-up removes Ayşe for the others; the two left still hear each other.
  await ayse.page.getByTestId('btn-hangup').click()
  await expectRoom([ayse, mehmet, zeynep], [mehmet, zeynep])
  await expect(mehmet.page.getByTestId(`remote-audio-${ayse.user.id}`)).toHaveCount(0)
  await expect(zeynep.page.getByTestId(`remote-audio-${ayse.user.id}`)).toHaveCount(0)
  await expect(ayse.page.locator('audio[data-testid^="remote-audio-"]')).toHaveCount(0)
  await expect(ayse.page.getByTestId('btn-hangup')).toHaveCount(0)
  await expectHearing(mehmet, zeynep)

  // She comes back; everyone hears her again.
  await joinVoice(ayse)
  await expectRoom(people, people)
  await expectHearing(mehmet, ayse)
  await expectHearing(ayse, zeynep)

  // Closing a tab mid-call removes that user for the others.
  await zeynep.context.close()
  await expectRoom([ayse, mehmet], [ayse, mehmet])
  await expect(ayse.page.getByTestId(`remote-audio-${zeynep.user.id}`)).toHaveCount(0)
  await expectHearing(ayse, mehmet)
  await expectHearing(mehmet, ayse)
})

test('voice: a user joining with mute already on is shown muted', async ({ browser, trio }) => {
  const [ayse, mehmet] = await threePeople(browser, trio)
  await mehmet.page.getByTestId('btn-mute').click()
  await joinVoice(ayse)
  await joinVoice(mehmet)
  await expect(row(ayse, mehmet)).toHaveAttribute('data-muted', 'true')
  await expect(row(ayse, ayse)).toHaveAttribute('data-muted', 'false')
  // Joining the same voice channel twice is a no-op, not a rejoin.
  await mehmet.page.getByTestId(`channel-${SOHBET}`).click()
  await expect(row(ayse, mehmet)).toHaveCount(1)
})
