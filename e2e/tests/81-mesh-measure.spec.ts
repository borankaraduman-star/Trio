/**
 * CONTRACT-V10-GROUPS §3: what a full mesh of eight costs, measured on this
 * machine with Chromium's fake devices, and the camera encoding that follows
 * the room size (`cameraEncodingFor`, sender parameters only).
 *
 * Every number is printed as `[81] …` and copied into the contract. The
 * assertions are the properties, not the numbers: everybody hears everybody,
 * a camera in a room of eight is sent at most ~350 kbit/s and half size per
 * viewer, and back in a small room it is the browser's own choice again.
 */
import { freshServer } from '../lib/server'
import { crowd, expectEverybodyHearing, expectFullMesh, joinAllAtOnce, meshStats, round, type MeshStats } from '../lib/groups'
import { expect, joinVoice, test, type Person } from '../lib/trio'

test.beforeEach(async () => {
  await freshServer()
})

function summary(label: string, stats: MeshStats[]): void {
  const avg = (pick: (s: MeshStats) => number) => stats.reduce((sum, s) => sum + pick(s), 0) / stats.length
  const max = (pick: (s: MeshStats) => number) => Math.max(...stats.map(pick))
  console.log(
    `[81] ${label}: n=${stats.length} pcs/client=${round(avg((s) => s.connected), 1)} ` +
      `out audio avg ${round(avg((s) => s.outAudioBps) / 1000)} kbit/s (max ${round(max((s) => s.outAudioBps) / 1000)}), ` +
      `in audio avg ${round(avg((s) => s.inAudioBps) / 1000)} kbit/s, out video max ${round(max((s) => s.outVideoBps) / 1000)} kbit/s, ` +
      `frames encoded/s max ${round(max((s) => s.framesEncodedPerSecond))}, encode load max ${round(max((s) => s.encodeLoad), 3)}, ` +
      `sent height max ${max((s) => s.maxSentHeight)}, concealed avg ${round(avg((s) => s.concealedShare) * 100, 2)} %`,
  )
}

/** One camera's outgoing video to each of its peers: bits per second and the frame height sent. */
async function cameraOut(person: Person): Promise<{ perViewerBps: number[]; heights: number[] }> {
  return person.page.evaluate(async () => {
    const pcs = (window as unknown as { __trioPcs: RTCPeerConnection[] }).__trioPcs.filter((pc) => pc.connectionState === 'connected')
    const read = async () =>
      Promise.all(
        pcs.map(async (pc) => {
          let bytes = 0
          let height = 0
          ;(await pc.getStats()).forEach((s) => {
            if (s.type === 'outbound-rtp' && s.kind === 'video') {
              bytes += s.bytesSent
              height = Math.max(height, s.frameHeight ?? 0)
            }
          })
          return { bytes, height }
        }),
      )
    const a = await read()
    const t0 = performance.now()
    await new Promise((resolve) => setTimeout(resolve, 3000))
    const b = await read()
    const seconds = (performance.now() - t0) / 1000
    return { perViewerBps: b.map((x, i) => ((x.bytes - a[i].bytes) * 8) / seconds), heights: b.map((x) => x.height) }
  })
}

async function cameraOn(person: Person): Promise<void> {
  await person.page.getByTestId('btn-camera').click()
  await expect(person.page.getByTestId('btn-camera')).toHaveAttribute('aria-pressed', 'true')
}

test('a mesh of eight: audio for everybody, and the camera sent smaller as the room grows', async ({ browser, trio }) => {
  test.setTimeout(420_000)
  const people = await crowd(browser, trio, 8)
  const [first] = people

  // Four people (no camera encoding of our own: the browser's choice).
  const four = people.slice(0, 4)
  for (const person of four) await joinVoice(person)
  await expectFullMesh(four)
  await expectEverybodyHearing(four)
  summary('4 people, audio only', await Promise.all(four.map((p) => meshStats(p.page, 3000))))
  await cameraOn(first)
  await expect.poll(async () => (await cameraOut(first)).perViewerBps.every((bps) => bps > 50_000), { timeout: 30_000 }).toBe(true)
  // The bandwidth estimate ramps up over the first seconds: read after it settles.
  await first.page.waitForTimeout(8000)
  const small = await cameraOut(first)
  console.log(`[81] camera in a room of 4: per viewer ${small.perViewerBps.map((b) => round(b / 1000)).join('/')} kbit/s, height ${small.heights.join('/')}`)

  // Four more join at once: a room of eight, 28 connections.
  const started = Date.now()
  await joinAllAtOnce(people.slice(4))
  const meshMs = await expectFullMesh(people, 120_000)
  console.log(`[81] four more joined at once: all 28 pairs connected after ${Date.now() - started} ms (poll ${meshMs} ms)`)
  await expectEverybodyHearing(people, 90_000)
  for (const person of people) expect(await person.page.locator('[data-testid^="voice-user-"]').count()).toBe(8)

  await first.page.waitForTimeout(8000)
  const big = await cameraOut(first)
  console.log(`[81] camera in a room of 8: per viewer ${big.perViewerBps.map((b) => round(b / 1000)).join('/')} kbit/s, height ${big.heights.join('/')}`)
  expect(big.perViewerBps).toHaveLength(7)
  for (const bps of big.perViewerBps) expect(bps).toBeLessThan(350_000 * 1.25)
  for (const height of big.heights) expect(height).toBeLessThanOrEqual(Math.ceil(Math.max(...small.heights) / 2) + 2)
  // Never a renegotiation: the encoding is a sender parameter (one m-line per kind, as before).
  const params = await first.page.evaluate(() =>
    (window as unknown as { __trioPcs: RTCPeerConnection[] }).__trioPcs
      .filter((pc) => pc.connectionState === 'connected')
      .flatMap((pc) => pc.getSenders().filter((s) => s.track?.kind === 'video').map((s) => s.getParameters().encodings[0])),
  )
  for (const encoding of params) {
    expect(encoding.maxBitrate).toBe(350_000)
    expect(encoding.scaleResolutionDownBy).toBe(2)
  }

  summary('8 people, audio + 1 camera', await Promise.all(people.map((p) => meshStats(p.page, 3000))))

  // Two more cameras.
  await cameraOn(people[1])
  await cameraOn(people[2])
  await first.page.waitForTimeout(8000)
  summary('8 people, audio + 3 cameras', await Promise.all(people.map((p) => meshStats(p.page, 3000))))
  await expectEverybodyHearing(people, 90_000)

  // Back to four: the camera goes back to the browser's own choice.
  await Promise.all(people.slice(4).map((person) => person.page.getByTestId('btn-hangup').click()))
  await expectFullMesh(four)
  await expect
    .poll(
      () =>
        first.page.evaluate(() =>
          (window as unknown as { __trioPcs: RTCPeerConnection[] }).__trioPcs
            .filter((pc) => pc.connectionState === 'connected')
            .flatMap((pc) => pc.getSenders().filter((s) => s.track?.kind === 'video').map((s) => s.getParameters().encodings[0]?.maxBitrate ?? null)),
        ),
      { timeout: 15_000 },
    )
    .toEqual([null, null, null])
})
