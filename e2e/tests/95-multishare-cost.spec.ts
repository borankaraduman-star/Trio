/**
 * CONTRACT-V12-WATCHING §2/§3: what "only pay for what you watch" saves when
 * four people share in a room of five (the room cap's default), measured on
 * this machine like spec 91: every sharer's upload, frames and encoder time,
 * every viewer's received bitrate and decode time, in "Yan yana" and in
 * "Odak" (one large, the rest thumbnails), and with everybody on "Hafif".
 * Printed as `[95] …`; the assertions: the encoder time per frame of a
 * four-screen grid stays far under spec 91's baseline, Hafif costs less than
 * Odak, and every screen keeps decoding.
 */
import { freshServer } from '../lib/server'
import { crowd, expectFullMesh, joinAllAtOnce, round } from '../lib/groups'
import { expect, test, type Person } from '../lib/trio'
import { expectDecodingFrom, screenSend } from '../lib/v12multishare'

test.beforeEach(async () => {
  await freshServer()
})

async function decodeCost(viewer: Person, ms = 3000): Promise<{ kbps: number; fps: number; decodeMs: number }> {
  return viewer.page.evaluate(async (window_) => {
    const pcs = (window as unknown as { __trioPcs: RTCPeerConnection[] }).__trioPcs.filter((pc) => pc.connectionState === 'connected')
    const read = async () => {
      let bytes = 0
      let frames = 0
      let decode = 0
      for (const pc of pcs) {
        ;(await pc.getStats()).forEach((s) => {
          if (s.type === 'inbound-rtp' && s.kind === 'video') {
            bytes += s.bytesReceived ?? 0
            frames += s.framesDecoded ?? 0
            decode += s.totalDecodeTime ?? 0
          }
        })
      }
      return { bytes, frames, decode }
    }
    const a = await read()
    const t0 = performance.now()
    await new Promise((r) => setTimeout(r, window_))
    const b = await read()
    const s = (performance.now() - t0) / 1000
    const frames = b.frames - a.frames
    return { kbps: ((b.bytes - a.bytes) * 8) / s / 1000, fps: frames / s, decodeMs: frames > 0 ? ((b.decode - a.decode) / frames) * 1000 : 0 }
  }, ms)
}

async function sample(label: string, people: Person[], sharers: Person[]) {
  await people[0].page.waitForTimeout(8000)
  const sends = await Promise.all(sharers.map((s) => screenSend(s, 3000)))
  const viewers = await Promise.all(people.map((p) => decodeCost(p)))
  const up = sends.map((list) => list.reduce((a, s) => a + s.kbps, 0))
  const enc = sends.map((list) => Math.max(...list.map((s) => s.encodeMsPerFrame)))
  const fps = sends.flatMap((list) => list.map((s) => s.fps))
  const qlr = [...new Set(sends.flatMap((list) => list.map((s) => s.qualityLimitationReason)))].join('/')
  console.log(
    `[95] ${label}: upload per sharer ${up.map((u) => round(u)).join('/')} kbit/s (sum ${round(up.reduce((a, b) => a + b, 0))}); ` +
      `fps to viewers min ${round(Math.min(...fps))} median ${round(fps.sort((a, b) => a - b)[Math.floor(fps.length / 2)])}; ` +
      `encoder ms/frame max ${enc.map((e) => round(e, 1)).join('/')}; qlr ${qlr}; ` +
      `viewer in ${viewers.map((v) => round(v.kbps)).join('/')} kbit/s, decode ${viewers.map((v) => round(v.decodeMs, 1)).join('/')} ms/frame`,
  )
  return { sum: up.reduce((a, b) => a + b, 0), encMax: Math.max(...enc) }
}

test('four shares in a room of five: Yan yana, Odak, Hafif', async ({ browser, trio }) => {
  test.setTimeout(600_000)
  const people = await crowd(browser, trio, 5)
  await joinAllAtOnce(people)
  await expectFullMesh(people)
  const sharers = people.slice(0, 4)
  for (const sharer of sharers) {
    await sharer.page.getByTestId('btn-screen').click()
    await expect(sharer.page.getByTestId('btn-screen')).toHaveAttribute('aria-pressed', 'true')
  }
  for (const viewer of people) await expectDecodingFrom(viewer, sharers.filter((s) => s !== viewer).map((s) => s.user.id), 90_000)

  const side = await sample('Yan yana', people, sharers)
  for (const person of people) await person.page.getByTestId('stage-mode-focus').click()
  const focus = await sample('Odak', people, sharers)
  // Hafif on every share, chosen from the ⋯ menu (on the large tiles of Yan yana).
  for (const person of people) await person.page.getByTestId('stage-mode-side').click()
  for (const viewer of people) {
    for (const sharer of sharers) {
      if (sharer === viewer) continue
      await viewer.page.getByTestId(`tile-menu-${sharer.user.id}`).click()
      await viewer.page.getByTestId(`tile-light-${sharer.user.id}`).click()
    }
  }
  const light = await sample('Hafif (everybody, everything)', people, sharers)
  for (const viewer of people) await expectDecodingFrom(viewer, sharers.filter((s) => s !== viewer).map((s) => s.user.id), 60_000)
  // Before V12 the same room spent 230–490 ms of encoder time per frame (spec 91, the
  // contract's §2): every viewer got every share at 1080p. Now a grid of four sends
  // small pictures, and Odak sends one large one per viewer.
  expect(side.encMax).toBeLessThan(60)
  expect(light.sum).toBeLessThan(focus.sum)
})
