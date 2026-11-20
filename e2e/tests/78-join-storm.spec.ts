/**
 * CONTRACT-V10-GROUPS §4: six people click the same voice room within a
 * second. Every pair must end up connected through the turn-taking
 * negotiation (the higher id asks, the lower grants; never a rollback) and
 * everybody must hear everybody: 15 pairs, 30 directions, read from receiver
 * stats. Until V10 the negotiation had only ever met three people.
 */
import { freshServer } from '../lib/server'
import { crowd, expectEverybodyHearing, expectFullMesh, joinAllAtOnce } from '../lib/groups'
import { expect, test } from '../lib/trio'

test.beforeEach(async () => {
  await freshServer()
})

/** Records every signalling state the page's connections go through and every rollback. */
const ROLLBACK_PROBE = `
(() => {
  window.__trioRollbacks = 0
  const set = RTCPeerConnection.prototype.setLocalDescription
  RTCPeerConnection.prototype.setLocalDescription = function (description) {
    if (description && description.type === 'rollback') window.__trioRollbacks += 1
    return set.apply(this, arguments)
  }
  const setRemote = RTCPeerConnection.prototype.setRemoteDescription
  RTCPeerConnection.prototype.setRemoteDescription = function (description) {
    // An offer applied in have-local-offer is an implicit rollback.
    if (description && (description.type === 'rollback' || (description.type === 'offer' && this.signalingState === 'have-local-offer'))) window.__trioRollbacks += 1
    return setRemote.apply(this, arguments)
  }
})()
`

test('a join storm: six people in one room within a second all connect and hear each other', async ({ browser, trio }) => {
  test.setTimeout(240_000)
  const people = await crowd(browser, trio, 6, { prepare: (context) => context.addInitScript(ROLLBACK_PROBE) })

  const spread = await joinAllAtOnce(people)
  console.log(`[78] six clicks landed within ${spread} ms`)
  expect(spread).toBeLessThan(1500)

  for (const person of people) {
    await expect(person.page.locator('.voice-status strong')).toHaveText('Ses bağlı', { timeout: 30_000 })
    await expect(person.page.locator('[data-testid^="voice-user-"]')).toHaveCount(6)
  }
  const meshMs = await expectFullMesh(people)
  console.log(`[78] full mesh (15 pairs) connected ${meshMs} ms after the last click returned`)
  await expectEverybodyHearing(people)

  // No rollback anywhere, explicit or implicit (CLAUDE.md), and one connection per pair.
  for (const person of people) {
    const facts = await person.page.evaluate(() => {
      const w = window as unknown as { __trioRollbacks: number; __trioPcs: RTCPeerConnection[] }
      return { rollbacks: w.__trioRollbacks, live: w.__trioPcs.filter((pc) => pc.connectionState !== 'closed').length }
    })
    expect(facts.rollbacks, `${person.name}: rollbacks`).toBe(0)
    expect(facts.live, `${person.name}: live connections`).toBe(5)
  }

  // A second storm: everybody leaves, then all six come back at once.
  await Promise.all(people.map((person) => person.page.getByTestId('btn-hangup').click()))
  for (const person of people) await expect(person.page.locator('[data-testid^="voice-user-"]')).toHaveCount(0)
  await joinAllAtOnce(people)
  await expectFullMesh(people)
  await expectEverybodyHearing(people)
  for (const person of people) {
    const rollbacks = await person.page.evaluate(() => (window as unknown as { __trioRollbacks: number }).__trioRollbacks)
    expect(rollbacks, `${person.name}: rollbacks after the second storm`).toBe(0)
  }
})
