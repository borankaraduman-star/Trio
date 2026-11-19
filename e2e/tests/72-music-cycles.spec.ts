/**
 * CONTRACT-V8-MUSIC §2 and CLAUDE.md's two expensive lessons: starting and
 * stopping music renegotiates only through the turn-taking (no SDP rollback,
 * ever) and stopping stops the transceiver, so 15 on/off cycles — some of
 * them by both people at the same moment — leave the offer the size it was,
 * far under the server's 64 KiB signal cap, and the microphones are heard
 * on the SAME connection throughout.
 */
import { freshServer } from '../lib/server'
import { expect, expectHearing, joinVoice, personViaApi, test, type Person } from '../lib/trio'
import { expectAudioGrew, pairs, sampleAll } from '../lib/voiceProbe'
import { expectMusicFlowing, FAKE_MUSIC_CAPTURE, negotiationLog, NEGOTIATION_PROBE } from '../lib/v8music'

test.beforeEach(async () => {
  await freshServer()
})

const CYCLES = 15
const SIGNAL_CAP = 64 * 1024

async function person(browser: Parameters<typeof personViaApi>[0], name: string): Promise<Person> {
  return personViaApi(browser, name, {
    prepare: async (context) => {
      await context.addInitScript(FAKE_MUSIC_CAPTURE)
      await context.addInitScript(NEGOTIATION_PROBE)
    },
  })
}

async function setMusic(sharer: Person, listener: Person, on: boolean): Promise<void> {
  const button = sharer.page.getByTestId('btn-music')
  await expect(button).toBeEnabled({ timeout: 20_000 })
  if ((await button.getAttribute('aria-pressed')) !== String(on)) await button.click()
  await expect(button).toHaveAttribute('aria-pressed', String(on), { timeout: 20_000 })
  await expect(listener.page.getByTestId(`remote-music-${sharer.user.id}`)).toHaveCount(on ? 1 : 0, { timeout: 30_000 })
}

test('music on and off 15 times: no rollback, the offer stays small, the microphones never stop', async ({ browser, trio }) => {
  test.setTimeout(480_000)
  // Ayşe has the lower id (she offers when she likes); Mehmet the higher (he asks for a turn).
  const ayse = trio.add(await person(browser, 'Ayşe'))
  const mehmet = trio.add(await person(browser, 'Mehmet'))
  await joinVoice(ayse)
  await joinVoice(mehmet)
  await expectHearing(ayse, mehmet)
  await expectHearing(mehmet, ayse)
  const both = pairs([ayse, mehmet])
  let since = await sampleAll(both)
  const sizes: number[] = []

  for (let cycle = 1; cycle <= CYCLES; cycle++) {
    const together = cycle % 5 === 0
    if (together) {
      // Both start at the same moment, then both stop at the same moment.
      await Promise.all([mehmet.page.getByTestId('btn-music').click(), ayse.page.getByTestId('btn-music').click()])
      await Promise.all([setMusic(mehmet, ayse, true), setMusic(ayse, mehmet, true)])
      await expectMusicFlowing(ayse, mehmet, `cycle ${cycle}: Ayşe hears Mehmet's music`)
      await expectMusicFlowing(mehmet, ayse, `cycle ${cycle}: Mehmet hears Ayşe's music`)
      await Promise.all([mehmet.page.getByTestId('btn-music').click(), ayse.page.getByTestId('btn-music').click()])
      await Promise.all([setMusic(mehmet, ayse, false), setMusic(ayse, mehmet, false)])
    } else {
      await setMusic(mehmet, ayse, true)
      await expectMusicFlowing(ayse, mehmet, `cycle ${cycle}: Ayşe hears Mehmet's music`)
      await setMusic(mehmet, ayse, false)
    }
    // The microphones keep arriving, on the same connection objects.
    since = await expectAudioGrew(both, since, 2_000, `cycle ${cycle}: both microphones still arrive`)
    const logs = [await negotiationLog(ayse.page), await negotiationLog(mehmet.page)]
    sizes.push(Math.max(...logs.map((log) => log.maxLocal)))
    for (const log of logs) expect(log.rollbacks, `cycle ${cycle}: no rollback`).toBe(0)
  }

  const logs = [await negotiationLog(ayse.page), await negotiationLog(mehmet.page)]
  console.log(`music cycles: largest description per cycle ${JSON.stringify(sizes)}; offers ${logs.map((l) => l.offers)}`)
  for (const log of logs) {
    expect(log.rollbacks).toBe(0)
    expect(log.maxLocal).toBeLessThan(SIGNAL_CAP)
    // Only the states of a turn-taking negotiation: never a pranswer, never closed mid-call.
    for (const state of log.states) expect(['have-local-offer', 'have-remote-offer', 'stable']).toContain(state)
  }
  // The description of cycle 15 is the size of cycle 1's: transceivers were stopped and recycled.
  expect(sizes[CYCLES - 1]).toBeLessThan(sizes[0] + 2_000)
  // And the microphones are heard both ways at the end.
  await expectHearing(ayse, mehmet)
  await expectHearing(mehmet, ayse)
  const finalSenders = await mehmet.page.evaluate(() =>
    (window as unknown as { __trioPcs: RTCPeerConnection[] }).__trioPcs
      .filter((pc) => pc.connectionState !== 'closed')
      .map((pc) => pc.getTransceivers().filter((t) => t.currentDirection !== 'stopped').length),
  )
  console.log(`live transceivers after ${CYCLES} cycles: ${JSON.stringify(finalSenders)}`)
})
