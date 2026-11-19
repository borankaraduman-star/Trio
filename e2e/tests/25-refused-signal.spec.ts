/**
 * Review finding 1, second half: a description the server refuses (`error
 * TOO_LARGE`, over its 64 KiB signal cap) used to leave the pair in
 * `have-local-offer` for good. Now the pair starts again on fresh peer
 * connections, at most a few times. The refusal is forced by inflating one
 * outgoing description frame in the page (the real server refuses it).
 */
import type { Page } from '@playwright/test'
import { expectTileDecoding } from '../lib/media'
import { freshServer } from '../lib/server'
import { expect, expectHearing, joinVoice, test, threePeople, type Person } from '../lib/trio'

test.beforeEach(async () => {
  await freshServer()
})

/** Make the next `count` description frames this page sends to `to` too big for the server. */
async function inflateDescriptions(page: Page, to: number, count: number): Promise<void> {
  await page.evaluate(
    ([target, left]) => {
      const w = window as unknown as {
        __trioInflate?: { to: number; left: number; done: number }
        __trioInflateInstalled?: boolean
      }
      w.__trioInflate = { to: target, left, done: 0 }
      if (w.__trioInflateInstalled) return
      w.__trioInflateInstalled = true
      const send = WebSocket.prototype.send
      WebSocket.prototype.send = function (this: WebSocket, data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        const plan = w.__trioInflate
        if (plan && plan.left > 0 && typeof data === 'string') {
          const frame = JSON.parse(data) as { type?: string; to?: number; data?: Record<string, unknown> }
          if (frame.type === 'signal' && frame.to === plan.to && frame.data && 'description' in frame.data) {
            plan.left -= 1
            plan.done += 1
            frame.data.pad = 'x'.repeat(70_000)
            return send.call(this, JSON.stringify(frame))
          }
        }
        return send.call(this, data)
      }
    },
    [to, count] as const,
  )
}

async function inflated(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __trioInflate?: { done: number } }).__trioInflate?.done ?? 0)
}

async function peerConnectionCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __trioPcs: RTCPeerConnection[] }).__trioPcs.length)
}

const row = (viewer: Person, subject: Person) => viewer.page.getByTestId(`voice-user-${subject.user.id}`)

async function expectEveryoneHears(people: Person[]): Promise<void> {
  for (const listener of people) for (const speaker of people) {
    if (listener !== speaker) await expectHearing(listener, speaker)
  }
}

async function callOfThree(browser: Parameters<typeof threePeople>[0], trio: Parameters<typeof threePeople>[1]) {
  const people = await threePeople(browser, trio)
  for (const person of people) await joinVoice(person)
  for (const person of people) await expect(person.page.locator('[data-testid^="voice-user-"]')).toHaveCount(3)
  await expectEveryoneHears(people)
  for (const viewer of people) for (const other of people) {
    if (viewer !== other) await expect(row(viewer, other)).toHaveAttribute('data-peer-health', 'connected', { timeout: 15_000 })
  }
  return people
}

test('a refused offer from the impolite side: the pair starts again and the camera arrives', async ({ browser, trio }) => {
  test.setTimeout(150_000)
  const people = await callOfThree(browser, trio)
  const [ayse, mehmet, zeynep] = people
  const before = await peerConnectionCount(ayse.page)

  await inflateDescriptions(ayse.page, mehmet.user.id, 1)
  await ayse.page.getByTestId('btn-camera').click()
  await expect.poll(() => inflated(ayse.page)).toBe(1)

  await expectTileDecoding(mehmet.page, `remote-camera-${ayse.user.id}`, 'camera', 'Ayşe')
  await expectTileDecoding(zeynep.page, `remote-camera-${ayse.user.id}`, 'camera', 'Ayşe')
  // Exactly one fresh connection, on each side of that pair only.
  expect(await peerConnectionCount(ayse.page)).toBe(before + 1)
  await expect(row(ayse, mehmet)).toHaveAttribute('data-peer-health', 'connected', { timeout: 15_000 })
  await expectEveryoneHears(people)

  // And it renegotiates normally afterwards.
  await ayse.page.getByTestId('btn-camera').click()
  await expect(mehmet.page.getByTestId(`remote-camera-${ayse.user.id}`)).toHaveCount(0)
  await mehmet.page.getByTestId('btn-camera').click()
  await expectTileDecoding(ayse.page, `remote-camera-${mehmet.user.id}`, 'camera', 'Mehmet')
})

test('a refused offer from the polite side: it asks for a fresh start, and gets it', async ({ browser, trio }) => {
  test.setTimeout(150_000)
  const people = await callOfThree(browser, trio)
  const [ayse, mehmet, zeynep] = people

  // Mehmet is polite towards Ayşe (higher id): he offers after a granted turn.
  await inflateDescriptions(mehmet.page, ayse.user.id, 1)
  await mehmet.page.getByTestId('btn-camera').click()
  await expect.poll(() => inflated(mehmet.page)).toBe(1)

  await expectTileDecoding(ayse.page, `remote-camera-${mehmet.user.id}`, 'camera', 'Mehmet')
  await expectTileDecoding(zeynep.page, `remote-camera-${mehmet.user.id}`, 'camera', 'Mehmet')
  await expectEveryoneHears(people)
})

test('a description that is always refused gives up after a few fresh starts and says so', async ({ browser, trio }) => {
  test.setTimeout(150_000)
  const people = await callOfThree(browser, trio)
  const [ayse, mehmet, zeynep] = people
  const before = await peerConnectionCount(ayse.page)

  await inflateDescriptions(ayse.page, mehmet.user.id, 1_000)
  await ayse.page.getByTestId('btn-camera').click()

  await expect(row(ayse, mehmet)).toHaveAttribute('data-peer-health', 'failed', { timeout: 30_000 })
  await expect(row(ayse, mehmet).getByTestId('peer-health')).toHaveAttribute('title', /Bağlanılamadı.*TURN/)
  // Bounded: three fresh starts, then no more.
  const after = await peerConnectionCount(ayse.page)
  expect(after - before).toBe(3)
  const refused = await inflated(ayse.page)

  // The other pairs are not touched.
  await expectTileDecoding(zeynep.page, `remote-camera-${ayse.user.id}`, 'camera', 'Ayşe')
  await expectHearing(zeynep, ayse)
  await expectHearing(ayse, zeynep)
  await expectHearing(zeynep, mehmet)
  await expectHearing(mehmet, zeynep)
  // Nothing kept going in the background meanwhile (the checks above take seconds).
  expect([await peerConnectionCount(ayse.page), await inflated(ayse.page)]).toEqual([after, refused])
  await expect(row(ayse, mehmet)).toHaveAttribute('data-peer-health', 'failed')
})
