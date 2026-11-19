/**
 * Review finding 10a: a pair whose ICE cannot connect (no TURN, strict NATs)
 * used to stay silent with nothing shown. Simulated here by dropping, in the
 * signalling of Mehmet and Zeynep, every ICE candidate they send each other
 * (trickled candidates and `a=candidate` lines alike): their connection can
 * never find a path, while both of them reach Ayşe normally.
 */
import type { Page } from '@playwright/test'
import { freshServer } from '../lib/server'
import { expect, expectHearing, joinVoice, test, threePeople, type Person } from '../lib/trio'

test.beforeEach(async () => {
  await freshServer()
})

/** Drop (or stop dropping) every ICE candidate this page signals to `to`. */
async function blockCandidates(page: Page, to: number, blocked: boolean): Promise<void> {
  await page.evaluate(
    ([target, on]) => {
      const w = window as unknown as { __trioBlockIce?: Set<number>; __trioDropped?: number }
      if (!w.__trioBlockIce) {
        w.__trioBlockIce = new Set()
        w.__trioDropped = 0
        const send = WebSocket.prototype.send
        WebSocket.prototype.send = function (this: WebSocket, data: string | ArrayBufferLike | Blob | ArrayBufferView) {
          if (typeof data === 'string') {
            const frame = JSON.parse(data) as {
              type?: string
              to?: number
              data?: { candidate?: unknown; description?: { sdp?: string } }
            }
            if (frame.type === 'signal' && typeof frame.to === 'number' && w.__trioBlockIce!.has(frame.to) && frame.data) {
              if ('candidate' in frame.data) {
                w.__trioDropped! += 1
                return
              }
              const sdp = frame.data.description?.sdp
              if (typeof sdp === 'string' && sdp.includes('a=candidate')) {
                frame.data.description!.sdp = sdp
                  .split('\r\n')
                  .filter((line) => !line.startsWith('a=candidate'))
                  .join('\r\n')
                return send.call(this, JSON.stringify(frame))
              }
            }
          }
          return send.call(this, data)
        }
      }
      if (on) w.__trioBlockIce.add(target)
      else w.__trioBlockIce.delete(target)
    },
    [to, blocked] as const,
  )
}

const health = (viewer: Person, subject: Person) => viewer.page.getByTestId(`voice-user-${subject.user.id}`)

test('a pair that cannot connect shows reconnecting, then failed with a TURN hint, and heals when the path opens', async ({ browser, trio }) => {
  test.setTimeout(180_000)
  const people = await threePeople(browser, trio)
  const [ayse, mehmet, zeynep] = people
  await blockCandidates(mehmet.page, zeynep.user.id, true)
  await blockCandidates(zeynep.page, mehmet.user.id, true)
  for (const person of people) await joinVoice(person)
  for (const person of people) await expect(person.page.locator('[data-testid^="voice-user-"]')).toHaveCount(3)

  // Ayşe's pairs are fine, and say so.
  for (const [viewer, subject] of [[ayse, mehmet], [ayse, zeynep], [mehmet, ayse], [zeynep, ayse]] as const) {
    await expect(health(viewer, subject)).toHaveAttribute('data-peer-health', 'connected', { timeout: 15_000 })
    await expect(health(viewer, subject).getByTestId('peer-health')).toHaveCount(0)
    await expectHearing(viewer, subject)
  }

  // The broken pair: connecting, then ICE restarts, then failed with the hint.
  for (const [viewer, subject] of [[mehmet, zeynep], [zeynep, mehmet]] as const) {
    await expect(health(viewer, subject)).toHaveAttribute('data-peer-health', /connecting|reconnecting/)
  }
  await expect(health(mehmet, zeynep)).toHaveAttribute('data-peer-health', 'reconnecting', { timeout: 20_000 })
  await expect(health(mehmet, zeynep).getByTestId('peer-health')).toHaveAttribute('title', /yeniden bağlanılıyor/)
  for (const [viewer, subject] of [[mehmet, zeynep], [zeynep, mehmet]] as const) {
    await expect(health(viewer, subject)).toHaveAttribute('data-peer-health', 'failed', { timeout: 60_000 })
    await expect(health(viewer, subject).getByTestId('peer-health')).toHaveAttribute('title', /Bağlanılamadı.*TURN/)
  }
  const dropped = await mehmet.page.evaluate(() => (window as unknown as { __trioDropped: number }).__trioDropped)
  expect(dropped).toBeGreaterThan(0)
  // Nobody else is affected meanwhile.
  await expectHearing(mehmet, ayse)
  await expectHearing(zeynep, ayse)

  // The path opens: the slow retry finds it, and the pair hears each other.
  await blockCandidates(mehmet.page, zeynep.user.id, false)
  await blockCandidates(zeynep.page, mehmet.user.id, false)
  for (const [viewer, subject] of [[mehmet, zeynep], [zeynep, mehmet]] as const) {
    await expect(health(viewer, subject)).toHaveAttribute('data-peer-health', 'connected', { timeout: 40_000 })
    await expect(health(viewer, subject).getByTestId('peer-health')).toHaveCount(0)
  }
  for (const listener of people) for (const speaker of people) {
    if (listener !== speaker) await expectHearing(listener, speaker)
  }
})
