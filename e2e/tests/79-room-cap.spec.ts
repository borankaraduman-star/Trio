/**
 * CONTRACT-V10-GROUPS §2: the voice room cap. With TRIO_VOICE_ROOM_MAX=3 the
 * room shows "n/3", is "Oda dolu (3/3)" and refuses a join for a fourth
 * person (the button explains itself instead of joining), and the server's
 * ROOM_FULL reaches a client whose view was out of date. A resume of a member
 * in the room is never refused (e2e 28 and 74 cover the resume itself).
 */
import type { BrowserContext, WebSocketRoute } from '@playwright/test'
import { freshServer } from '../lib/server'
import { crowd, expectEverybodyHearing } from '../lib/groups'
import { expect, joinVoice, SOHBET, test } from '../lib/trio'

test.beforeEach(async () => {
  await freshServer({ TRIO_VOICE_ROOM_MAX: '3' })
})

/** A websocket in front of one page that can hold back the server's room updates. */
function roomUpdateFilter() {
  const state = { holding: false }
  const prepare = (context: BrowserContext) =>
    context.routeWebSocket(/\/ws/, (ws: WebSocketRoute) => {
      const server = ws.connectToServer()
      server.onMessage((message) => {
        if (state.holding && typeof message === 'string' && /"type":"voice\.joined"/.test(message)) return
        ws.send(message)
      })
      ws.onMessage((message) => server.send(message))
    })
  return { state, prepare }
}

test('a full room: the count, "Oda dolu", the explanation, and ROOM_FULL for a stale view', async ({ browser, trio }) => {
  test.setTimeout(180_000)
  const filter = roomUpdateFilter()
  const [ayse, mehmet, zeynep, ali] = await crowd(browser, trio, 4, (i) => (i === 3 ? { prepare: filter.prepare } : {}))

  await joinVoice(ayse)
  const count = ali.page.getByTestId(`room-count-${SOHBET}`)
  await expect(count).toHaveText('1/3')
  await joinVoice(mehmet)
  await expect(count).toHaveText('2/3')
  await expect(ali.page.getByTestId(`channel-${SOHBET}`)).toHaveAttribute('data-room-full', 'false')

  // Ali's view stops hearing about joins: Zeynep takes the last place unseen.
  filter.state.holding = true
  await joinVoice(zeynep)
  await expect(ayse.page.getByTestId(`room-count-${SOHBET}`)).toHaveText('3/3')
  await expect(count).toHaveText('2/3')
  await ali.page.getByTestId(`channel-${SOHBET}`).click()
  // The server refuses (ROOM_FULL); the engine stops and says why, and nothing joined.
  await expect(ali.page.locator('.voice-error')).toContainText('Oda dolu (3/3)')
  await expect(ali.page.locator('.voice-panel')).toHaveCount(0)
  await expect(ayse.page.locator('[data-testid^="voice-user-"]')).toHaveCount(3)
  await expect
    .poll(() => ali.page.evaluate(() => (window as unknown as { __trioMicTracks: MediaStreamTrack[] }).__trioMicTracks.every((t) => t.readyState === 'ended')))
    .toBe(true)
  await ali.page.locator('.voice-error button').click()

  // A fresh view (reload): the room says it is full and the button explains instead of joining.
  filter.state.holding = false
  await ali.page.reload()
  const room = ali.page.getByTestId(`channel-${SOHBET}`)
  await expect(room).toHaveAttribute('data-room-full', 'true')
  await expect(room).toHaveAttribute('aria-disabled', 'true')
  await expect(ali.page.getByTestId(`room-count-${SOHBET}`)).toHaveText('Oda dolu (3/3)')
  // aria-disabled (Playwright waits for "enabled"), yet clickable: the click explains.
  await room.click({ force: true })
  await expect(ali.page.getByTestId(`room-full-note-${SOHBET}`)).toContainText('en çok 3 kişi')
  await expect(ali.page.locator('.voice-panel')).toHaveCount(0)

  // The three in the room are unaffected and hear each other.
  await expectEverybodyHearing([ayse, mehmet, zeynep])

  // A place frees up: the count follows and Ali can join.
  await zeynep.page.getByTestId('btn-hangup').click()
  await expect(room).toHaveAttribute('data-room-full', 'false')
  await expect(ali.page.getByTestId(`room-count-${SOHBET}`)).toHaveText('2/3')
  await expect(ali.page.getByTestId(`room-full-note-${SOHBET}`)).toHaveCount(0)
  await joinVoice(ali)
  await expectEverybodyHearing([ayse, mehmet, ali])
  // For the members themselves a full room is still theirs: no "full" on it.
  await expect(ali.page.getByTestId(`channel-${SOHBET}`)).toHaveAttribute('data-room-full', 'false')
  await expect(ali.page.getByTestId(`room-count-${SOHBET}`)).toHaveText('3/3')
  // GET /api/server says the cap too.
  const body = await ali.page.evaluate(async () => {
    const response = await fetch('/api/server', { headers: { Authorization: `Bearer ${localStorage.getItem('trio.token')}` } })
    return (await response.json()) as { voice_room_max: number }
  })
  expect(body.voice_room_max).toBe(3)
})
