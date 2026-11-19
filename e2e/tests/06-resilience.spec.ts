import type { Page } from '@playwright/test'
import { freshServer, restartServer, stopServer, startServer, readState } from '../lib/server'
import type { WebSocketRoute } from '@playwright/test'
import { apiJoin, expect, expectConnected, expectHearing, joinVoice, personViaApi, personWithSession, test, threePeople, type Person } from '../lib/trio'
import { expectAudioGrew, pairs, pcCount, sampleAll } from '../lib/voiceProbe'

test.beforeEach(async () => {
  await freshServer()
})

async function send(page: Page, text: string): Promise<void> {
  await page.getByTestId('composer').fill(text)
  await page.getByTestId('composer').press('Enter')
}

const row = (viewer: Person, subject: Person) => viewer.page.getByTestId(`voice-user-${subject.user.id}`)

test('resilience: the server is killed and restarted mid-session', async ({ browser, trio }) => {
  test.setTimeout(180_000)
  const people = await threePeople(browser, trio)
  const [ayse, mehmet, zeynep] = people

  await send(ayse.page, 'çökmeden önceki mesaj')
  await expect(zeynep.page.getByTestId('message').last()).toContainText('çökmeden önceki mesaj')
  await joinVoice(ayse)
  await joinVoice(mehmet)
  await mehmet.page.getByTestId('btn-mute').click()
  await expect(row(ayse, mehmet)).toHaveAttribute('data-muted', 'true')
  await expectHearing(mehmet, ayse)

  // Crash: SIGKILL, no goodbye. Every page says it lost the connection; the
  // two in voice say their call goes on (CONTRACT-V4 A1).
  const callers = pairs([ayse, mehmet])
  const made = await Promise.all([ayse, mehmet].map((p) => pcCount(p.page)))
  const before = await sampleAll(callers)
  const state = readState()
  await stopServer('SIGKILL')
  await expect(zeynep.page.locator('.banner')).toHaveText('Bağlantı koptu, yeniden bağlanılıyor…')
  for (const person of [ayse, mehmet]) {
    await expect(person.page.locator('.banner')).toHaveText('Sunucuya yeniden bağlanılıyor… ses sürüyor')
  }
  const during = await expectAudioGrew(callers, before, 200, 'the call goes on without the server')
  // A message typed while the server is down is not lost silently.
  await send(zeynep.page, 'sunucu yokken yazdım')
  await expect(zeynep.page.getByTestId('message').last()).toHaveAttribute('data-status', 'failed')

  await startServer({ port: state.port, dataDir: state.dataDir })

  // Everyone reconnects by themselves and sees the history.
  for (const person of people) {
    await expectConnected(person.page)
    await expect(person.page.getByTestId('message').first()).toContainText('çökmeden önceki mesaj')
    for (const other of people) {
      await expect(person.page.getByTestId(`member-${other.user.id}`)).toHaveAttribute('data-online', 'true')
    }
  }

  // The two who were in voice resume: the restarted server knew nothing about
  // them, and they are back on the connections they never closed. Mehmet is
  // still muted.
  await expectAudioGrew(callers, during, 200, 'the call goes on after the resume, on the same connections')
  expect(await Promise.all([ayse, mehmet].map((p) => pcCount(p.page)))).toEqual(made)
  for (const viewer of people) {
    await expect(viewer.page.locator('[data-testid^="voice-user-"]')).toHaveCount(2)
    await expect(row(viewer, ayse)).toBeVisible()
    await expect(row(viewer, mehmet)).toHaveAttribute('data-muted', 'true')
  }
  await expect(ayse.page.locator('.voice-status strong')).toHaveText('Ses bağlı')
  await expect(zeynep.page.getByTestId('btn-hangup')).toHaveCount(0)
  await mehmet.page.getByTestId('btn-mute').click()
  await expectHearing(mehmet, ayse)
  await expectHearing(ayse, mehmet)

  // The failed message can be sent again; live delivery works on the new server.
  await zeynep.page.getByRole('button', { name: 'Tekrar dene' }).click()
  for (const person of people) {
    await expect(person.page.getByTestId('message').last()).toContainText('sunucu yokken yazdım')
  }
  await expect(zeynep.page.getByTestId('message').last()).toHaveAttribute('data-status', 'sent')

  // And a second crash, straight through restartServer, with Zeynep in too.
  await joinVoice(zeynep)
  for (const listener of people) for (const speaker of people) {
    if (listener !== speaker) await expectHearing(listener, speaker)
  }
  const all = pairs(people)
  const made3 = await Promise.all(people.map((p) => pcCount(p.page)))
  const before3 = await sampleAll(all)
  await restartServer('SIGKILL')
  for (const viewer of people) {
    await expectConnected(viewer.page)
    await expect(viewer.page.locator('[data-testid^="voice-user-"]')).toHaveCount(3)
  }
  await expectAudioGrew(all, before3, 4_000, 'no pair stopped across the second crash')
  expect(await Promise.all(people.map((p) => pcCount(p.page)))).toEqual(made3)
  for (const listener of people) for (const speaker of people) {
    if (listener !== speaker) await expectHearing(listener, speaker)
  }
})

test('resilience: one client loses its connection and catches up on what it missed', async ({ browser, trio }) => {
  const ayse = trio.add(await personViaApi(browser, 'Ayşe'))
  // Zeynep's websocket goes through a switch the test controls.
  let online = true
  let socket: { page: WebSocketRoute; server: WebSocketRoute } | null = null
  const zeynep = trio.add(
    await personWithSession(browser, 'Zeynep', await apiJoin('Zeynep'), {
      prepare: (context) =>
        context.routeWebSocket(/\/ws/, (ws) => {
          if (!online) {
            void ws.close({ code: 1011, reason: 'offline' })
            return
          }
          socket = { page: ws, server: ws.connectToServer() }
        }),
    }),
  )
  await send(ayse.page, 'birinci')
  await expect(zeynep.page.getByTestId('message').last()).toContainText('birinci')

  online = false
  // Both halves go: the page sees a drop, the server sees the client leave.
  await socket!.server.close({ code: 1000, reason: 'cut' })
  await socket!.page.close({ code: 1011, reason: 'cut' })
  await expect(zeynep.page.locator('.banner')).toHaveText('Bağlantı koptu, yeniden bağlanılıyor…')
  await expect(ayse.page.getByTestId(`member-${zeynep.user.id}`)).toHaveAttribute('data-online', 'false')
  await send(ayse.page, 'sen yokken iki')
  await send(ayse.page, 'sen yokken üç')
  await expect(ayse.page.getByTestId('message').last()).toHaveAttribute('data-status', 'sent')

  online = true
  await expectConnected(zeynep.page)
  await expect(zeynep.page.getByTestId('message').locator('.message-content')).toHaveText([
    'birinci',
    'sen yokken iki',
    'sen yokken üç',
  ])
  await expect(ayse.page.getByTestId(`member-${zeynep.user.id}`)).toHaveAttribute('data-online', 'true')
  await send(ayse.page, 'tekrar hoş geldin')
  await expect(zeynep.page.getByTestId('message').last()).toContainText('tekrar hoş geldin')
})
