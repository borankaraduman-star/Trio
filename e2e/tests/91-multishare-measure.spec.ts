/**
 * CONTRACT-V12-MULTISHARE §2: several people share their screens at once, in
 * rooms of 3, 5 and 8. Measured with Chromium's fake screen capture on this
 * machine (every person a context of ONE browser, loopback, host candidates).
 *
 * For each extra share: every viewer decodes it (frames, not elements), the
 * time to its first decoded frame, what the first share does meanwhile, the
 * negotiations, rollbacks (explicit and implicit: none allowed, CLAUDE.md),
 * fresh connections, the largest description and the video m-lines. Then all
 * the sharers stop and start again within the same second (a storm).
 *
 * Every number is printed as `[91] …` and copied into the contract.
 */
import { freshServer } from '../lib/server'
import { crowd, expectFullMesh, joinAllAtOnce, round } from '../lib/groups'
import { expect, test, type Person } from '../lib/trio'
import { NEGOTIATION_PROBE, negotiationLog } from '../lib/v8music'
import { connectionCounts, descriptionFacts, expectDecodingFrom, firstFrameAt, median, screenSend, screenTileSelector } from '../lib/v12multishare'

test.beforeEach(async () => {
  await freshServer()
})

async function shareOn(person: Person): Promise<number> {
  const at = Date.now()
  await person.page.getByTestId('btn-screen').click()
  await expect(person.page.getByTestId('btn-screen')).toHaveAttribute('aria-pressed', 'true')
  return at
}

async function facts(people: Person[]) {
  const logs = await Promise.all(people.map((p) => negotiationLog(p.page)))
  const conns = await Promise.all(people.map((p) => connectionCounts(p.page)))
  const sdp = await Promise.all(people.map((p) => descriptionFacts(p.page)))
  return {
    rollbacks: logs.reduce((a, l) => a + l.rollbacks, 0),
    offers: logs.reduce((a, l) => a + l.offers, 0),
    fresh: conns.reduce((a, c) => a + (c.made - (people.length - 1)), 0),
    maxBytes: Math.max(...logs.map((l) => l.maxLocal), ...sdp.map((s) => s.maxBytes)),
    videoMLines: Math.max(...sdp.map((s) => s.maxVideoMLines)),
  }
}

async function measureRoom(people: Person[], shares: number): Promise<void> {
  const n = people.length
  await joinAllAtOnce(people)
  await expectFullMesh(people)
  const sharers: Person[] = []
  let firstBefore: number | null = null
  for (let k = 1; k <= shares; k += 1) {
    const sharer = people[k - 1]
    const before = await facts(people)
    const at = await shareOn(sharer)
    const viewers = people.filter((p) => p !== sharer)
    const times = await Promise.all(viewers.map((v) => firstFrameAt(v, sharer.user.id, 45_000)))
    const ttff = times.map((t) => t - at)
    sharers.push(sharer)
    // Every viewer decodes EVERY current share, not only the new one.
    for (const viewer of people) {
      await expectDecodingFrom(
        viewer,
        sharers.filter((s) => s !== viewer).map((s) => s.user.id),
      )
    }
    await people[0].page.waitForTimeout(6000)
    const after = await facts(people)
    const sends = await Promise.all(sharers.map((s) => screenSend(s, 3000)))
    const first = sends[0]
    const firstAvg = first.reduce((a, s) => a + s.kbps, 0) / Math.max(1, first.length)
    if (k === 1) firstBefore = firstAvg
    const lines = sends.map((list, i) => {
      const total = list.reduce((a, s) => a + s.kbps, 0)
      const fps = list.map((s) => round(s.fps)).join('/')
      const h = [...new Set(list.map((s) => s.height))].join('/')
      const qlr = [...new Set(list.map((s) => s.qualityLimitationReason))].join('/')
      const enc = round(Math.max(...list.map((s) => s.encodeMsPerFrame)), 1)
      const bwe = list.map((s) => round(s.availableKbps)).join('/')
      return `${sharers[i].name}: up ${round(total)} kbit/s to ${list.length} (${list.map((s) => round(s.kbps)).join('/')}), fps ${fps}, h ${h}, qlr ${qlr}, enc ${enc} ms/frame, bwe ${bwe}`
    })
    console.log(
      `[91] room ${n}, share ${k}: ttff median ${median(ttff)} ms max ${Math.max(...ttff)} ms; ` +
        `offers +${after.offers - before.offers}, rollbacks ${after.rollbacks}, fresh ${after.fresh}, ` +
        `max description ${after.maxBytes} B, video m-lines ${after.videoMLines}; first share avg/viewer ${round(firstBefore ?? 0)} → ${round(firstAvg)} kbit/s`,
    )
    for (const line of lines) console.log(`[91]   ${line}`)
    expect(after.rollbacks, 'no rollback').toBe(0)
    expect(after.fresh, 'no fresh connection').toBe(0)
    expect(after.maxBytes).toBeLessThan(64 * 1024)
  }

  // Everybody stops; then all of them start again within the same second.
  for (const sharer of sharers) await sharer.page.getByTestId('btn-screen').click()
  for (const viewer of people) await expect(viewer.page.locator('figure.call-tile.screen')).toHaveCount(0, { timeout: 20_000 })
  const before = await facts(people)
  const at = Date.now()
  await Promise.all(sharers.map((s) => s.page.getByTestId('btn-screen').click()))
  const ttffs: number[] = []
  await Promise.all(
    people.map(async (viewer) => {
      for (const sharer of sharers) {
        if (sharer === viewer) continue
        ttffs.push((await firstFrameAt(viewer, sharer.user.id, 60_000)) - at)
      }
    }),
  )
  for (const viewer of people) await expectDecodingFrom(viewer, sharers.filter((s) => s !== viewer).map((s) => s.user.id))
  const after = await facts(people)
  console.log(
    `[91] room ${n}, ${shares} start within the same second: ttff median ${median(ttffs)} ms max ${Math.max(...ttffs)} ms; ` +
      `offers +${after.offers - before.offers}, rollbacks ${after.rollbacks}, fresh ${after.fresh}, max description ${after.maxBytes} B`,
  )
  expect(after.rollbacks).toBe(0)
  expect(after.fresh).toBe(0)
  void screenTileSelector
}

const probe = { prepare: async (context: import('@playwright/test').BrowserContext) => void (await context.addInitScript(NEGOTIATION_PROBE)) }

test('room of 3: two, then three people share at once', async ({ browser, trio }) => {
  test.setTimeout(240_000)
  await measureRoom(await crowd(browser, trio, 3, probe), 3)
})

test('room of 5: two, three, four people share at once', async ({ browser, trio }) => {
  test.setTimeout(360_000)
  await measureRoom(await crowd(browser, trio, 5, probe), 4)
})

test('room of 8: two, three, four people share at once', async ({ browser, trio }) => {
  test.setTimeout(600_000)
  await measureRoom(await crowd(browser, trio, 8, probe), 4)
})
