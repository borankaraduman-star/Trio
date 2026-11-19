/**
 * CONTRACT-V4 A1: a voice call survives a signalling drop. Media is peer to
 * peer; the server only relays signalling, so a deploy (the server killed and
 * started again) or one person's network blip must not cut the call.
 *
 * The property is held strictly: across the outage every pair keeps
 * RECEIVING audio (inbound bytes keep growing, sampled before, during and
 * after), on the SAME RTCPeerConnection objects (no page makes a new one).
 */
import { expectTileDecoding } from '../lib/media'
import { freshServer, readState, startServer, stopServer } from '../lib/server'
import {
  apiJoin,
  expect,
  expectConnected,
  expectHearing,
  joinVoice,
  personViaApi,
  personWithSession,
  test,
  threePeople,
  type Person,
} from '../lib/trio'
import { expectAudioGrew, pairName, pairs, pcCount, sampleAll, socketSwitch, type SocketSwitch } from '../lib/voiceProbe'

test.beforeEach(async () => {
  await freshServer()
})

const KEPT = 'Sunucuya yeniden bağlanılıyor… ses sürüyor'
/** Opus at the fake microphone's level: well over 2 KB/s. A few seconds of audio. */
const SECONDS_OF_AUDIO = 8_000

const row = (viewer: Person, subject: Person) => viewer.page.getByTestId(`voice-user-${subject.user.id}`)

async function everyoneHears(people: Person[]): Promise<void> {
  for (const listener of people) for (const speaker of people) {
    if (listener !== speaker) await expectHearing(listener, speaker)
  }
}

/** Three people, Zeynep's websocket behind a switch the test controls. */
async function callWithSwitch(browser: Parameters<typeof personViaApi>[0], trio: { add: (p: Person) => Person }) {
  const sw: SocketSwitch = socketSwitch()
  const ayse = trio.add(await personViaApi(browser, 'Ayşe'))
  const mehmet = trio.add(await personViaApi(browser, 'Mehmet'))
  const zeynep = trio.add(await personWithSession(browser, 'Zeynep', await apiJoin('Zeynep'), { prepare: sw.prepare }))
  const people = [ayse, mehmet, zeynep]
  for (const person of people) await joinVoice(person)
  await everyoneHears(people)
  return { sw, people, ayse, mehmet, zeynep }
}

test('A1: the server is killed and restarted with three in voice; the call never stops', async ({ browser, trio }) => {
  test.setTimeout(240_000)
  const people = await threePeople(browser, trio)
  for (const person of people) await joinVoice(person)
  await everyoneHears(people)
  const list = pairs(people)
  const made = await Promise.all(people.map((p) => pcCount(p.page)))

  const before = await sampleAll(list)
  const state = readState()
  await stopServer('SIGKILL')
  for (const person of people) {
    await expect(person.page.getByTestId('connection-banner')).toHaveText(KEPT)
    await expect(person.page.locator('.voice-status strong')).toHaveText('Ses bağlı')
  }
  // During the outage: every pair still receives, on the same connection.
  const during = await expectAudioGrew(list, before, SECONDS_OF_AUDIO, 'audio keeps flowing while the server is down')
  const during2 = await expectAudioGrew(list, during, SECONDS_OF_AUDIO, 'and keeps flowing for longer')

  await startServer({ port: state.port, dataDir: state.dataDir })
  for (const person of people) await expectConnected(person.page)
  for (const viewer of people) await expect(viewer.page.locator('[data-testid^="voice-user-"]')).toHaveCount(3)
  const after = await expectAudioGrew(list, during2, SECONDS_OF_AUDIO, 'audio keeps flowing after the resume')
  // Not one new connection anywhere.
  expect(await Promise.all(people.map((p) => pcCount(p.page)))).toEqual(made)
  console.log(
    'A1 restart, inbound audio bytes per pair (before / during / during+ / after, connection):\n' +
      list.map((pair, i) => `  ${pairName(pair)}: ${before[i].bytes} / ${during[i].bytes} / ${during2[i].bytes} / ${after[i].bytes}  pc#${after[i].pc}`).join('\n'),
  )
  for (let i = 0; i < list.length; i += 1) expect(after[i].pc).toBe(before[i].pc)
  await everyoneHears(people)

  // Signalling works on the kept connections: a camera and a screen share.
  const [ayse, mehmet, zeynep] = people
  await ayse.page.getByTestId('btn-camera').click()
  await mehmet.page.getByTestId('btn-screen').click()
  await expectTileDecoding(zeynep.page, `remote-camera-${ayse.user.id}`, 'camera', 'Ayşe')
  await expectTileDecoding(zeynep.page, 'remote-video', 'screen', 'Mehmet · ekran')
  await expectTileDecoding(mehmet.page, `remote-camera-${ayse.user.id}`, 'camera', 'Ayşe')
  await expectTileDecoding(ayse.page, 'remote-video', 'screen', 'Mehmet · ekran')
  await ayse.page.getByTestId('btn-camera').click()
  await mehmet.page.getByTestId('btn-screen').click()
  for (const viewer of [mehmet, zeynep]) await expect(viewer.page.getByTestId(`remote-camera-${ayse.user.id}`)).toHaveCount(0)
  for (const viewer of [ayse, zeynep]) await expect(viewer.page.getByTestId('remote-video')).toHaveCount(0)
  expect(await Promise.all(people.map((p) => pcCount(p.page)))).toEqual(made)
  await everyoneHears(people)
})

test('A1: one person\'s socket blips for under 10 s; they show as reconnecting and audio never stops', async ({ browser, trio }) => {
  test.setTimeout(180_000)
  const { sw, people, ayse, mehmet, zeynep } = await callWithSwitch(browser, trio)
  const list = pairs(people)
  const made = await Promise.all(people.map((p) => pcCount(p.page)))
  const before = await sampleAll(list)

  const cutAt = Date.now()
  await sw.cut()
  await expect(zeynep.page.getByTestId('connection-banner')).toHaveText(KEPT)
  for (const viewer of [ayse, mehmet]) {
    await expect(row(viewer, zeynep)).toHaveAttribute('data-reconnecting', 'true')
    // The ICE badge waits for the server's word: no "failed" on her row.
    await expect(row(viewer, zeynep).getByTestId('peer-health')).toHaveCount(0)
  }
  const during = await expectAudioGrew(list, before, 4_000, 'audio to and from Zeynep keeps flowing during her blip')
  expect(Date.now() - cutAt).toBeLessThan(9_000)
  sw.online = true
  await expectConnected(zeynep.page)
  for (const viewer of [ayse, mehmet]) await expect(row(viewer, zeynep)).toHaveAttribute('data-reconnecting', 'false')
  const after = await expectAudioGrew(list, during, SECONDS_OF_AUDIO, 'and after it')
  for (let i = 0; i < list.length; i += 1) expect(after[i].pc).toBe(before[i].pc)
  expect(await Promise.all(people.map((p) => pcCount(p.page)))).toEqual(made)
  await everyoneHears(people)
})

test('A1: a blip of more than 10 s is voice.left for the others, then a normal rejoin', async ({ browser, trio }) => {
  test.setTimeout(180_000)
  const { sw, people, ayse, mehmet, zeynep } = await callWithSwitch(browser, trio)
  await sw.cut()
  for (const viewer of [ayse, mehmet]) await expect(row(viewer, zeynep)).toHaveAttribute('data-reconnecting', 'true')
  // The grace runs out: she is gone for them...
  for (const viewer of [ayse, mehmet]) await expect(row(viewer, zeynep)).toHaveCount(0, { timeout: 15_000 })
  // ...while her own page still keeps the call (under 30 s).
  await expect(zeynep.page.getByTestId('connection-banner')).toHaveText(KEPT)
  sw.online = true
  await expectConnected(zeynep.page)
  for (const viewer of people) await expect(viewer.page.locator('[data-testid^="voice-user-"]')).toHaveCount(3)
  for (const viewer of [ayse, mehmet]) await expect(row(viewer, zeynep)).toHaveAttribute('data-reconnecting', 'false')
  await everyoneHears(people)
})

test('A1: a camera turned on while the socket is down waits, and applies after the resume', async ({ browser, trio }) => {
  test.setTimeout(150_000)
  const { sw, ayse, mehmet, zeynep } = await callWithSwitch(browser, trio)
  await sw.cut()
  await expect(zeynep.page.getByTestId('connection-banner')).toHaveText(KEPT)
  const camera = zeynep.page.getByTestId('btn-camera')
  await camera.click()
  await expect(camera).toHaveAttribute('data-held', 'true')
  await expect(camera).toHaveAttribute('aria-pressed', 'false')
  await expect(camera).toHaveAttribute('title', 'Kamera bağlantı gelince açılacak')
  // Toggling back cancels it; once more holds it again.
  await camera.click()
  await expect(camera).toHaveAttribute('data-held', 'false')
  await camera.click()
  await expect(camera).toHaveAttribute('data-held', 'true')
  sw.online = true
  await expectConnected(zeynep.page)
  await expect(camera).toHaveAttribute('aria-pressed', 'true')
  await expect(camera).toHaveAttribute('data-held', 'false')
  await expectTileDecoding(ayse.page, `remote-camera-${zeynep.user.id}`, 'camera', 'Zeynep')
  await expectTileDecoding(mehmet.page, `remote-camera-${zeynep.user.id}`, 'camera', 'Zeynep')
  for (const viewer of [ayse, mehmet]) await expect(row(viewer, zeynep)).toHaveAttribute('data-camera', 'true')
})

test('A1: after 30 s without a socket the call is closed and rejoined as before', async ({ browser, trio }) => {
  test.setTimeout(180_000)
  const { sw, people, ayse, mehmet, zeynep } = await callWithSwitch(browser, trio)
  await sw.cut()
  await expect(zeynep.page.getByTestId('connection-banner')).toHaveText(KEPT)
  await zeynep.page.getByTestId('btn-camera').click()
  await expect(zeynep.page.getByTestId('btn-camera')).toHaveAttribute('data-held', 'true')
  // The fallback: the notice, every connection closed, the held camera dropped.
  await expect(zeynep.page.locator('.voice-error')).toContainText('30 saniyedir', { timeout: 40_000 })
  await expect(zeynep.page.locator('[data-testid^="remote-audio-"]')).toHaveCount(0)
  await expect(zeynep.page.getByTestId('btn-camera')).toHaveAttribute('data-held', 'false')
  await expect(zeynep.page.getByTestId('btn-camera')).toHaveAttribute('aria-pressed', 'false')
  await expect(zeynep.page.getByTestId('connection-banner')).toHaveText('Bağlantı koptu, yeniden bağlanılıyor…')
  for (const viewer of [ayse, mehmet]) await expect(row(viewer, zeynep)).toHaveCount(0)
  sw.online = true
  await expectConnected(zeynep.page)
  await expect(zeynep.page.locator('.voice-status strong')).toHaveText('Ses bağlı')
  for (const viewer of people) await expect(viewer.page.locator('[data-testid^="voice-user-"]')).toHaveCount(3)
  await everyoneHears(people)
})

test('A1 on screen: the "ses sürüyor" banner and a participant reconnecting, at desktop and 390 px', async ({ browser, trio }) => {
  test.setTimeout(150_000)
  const sw = socketSwitch()
  const desktop = { deviceScaleFactor: 2 }
  const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
  const ayse = trio.add(await personViaApi(browser, 'Ayşe', desktop))
  const mehmet = trio.add(await personViaApi(browser, 'Mehmet', phone))
  const zeynep = trio.add(await personWithSession(browser, 'Zeynep', await apiJoin('Zeynep'), { ...desktop, prepare: sw.prepare }))
  await joinVoice(ayse)
  await mehmet.page.getByTestId('btn-drawer').click()
  await joinVoice(mehmet)
  await joinVoice(zeynep)
  await expectHearing(ayse, zeynep)

  await sw.cut()
  await expect(zeynep.page.getByTestId('connection-banner')).toHaveText(KEPT)
  await expect(row(ayse, zeynep)).toHaveAttribute('data-reconnecting', 'true')
  await expect(row(mehmet, zeynep)).toHaveAttribute('data-reconnecting', 'true')
  await zeynep.page.screenshot({ path: 'screenshots/v4-voice-kept-banner.png' })
  await ayse.page.screenshot({ path: 'screenshots/v4-participant-reconnecting.png' })
  await mehmet.page.screenshot({ path: 'screenshots/v4-participant-reconnecting-390.png' })
  sw.online = true
  await expectConnected(zeynep.page)
  await expect(row(ayse, zeynep)).toHaveAttribute('data-reconnecting', 'false')
})

test('A1 at 390 px: the kept call\'s banner and the waiting camera fit', async ({ browser, trio }) => {
  test.setTimeout(120_000)
  const sw = socketSwitch()
  const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
  const ayse = trio.add(await personViaApi(browser, 'Ayşe'))
  const zeynep = trio.add(await personWithSession(browser, 'Zeynep', await apiJoin('Zeynep'), { ...phone, prepare: sw.prepare }))
  await joinVoice(ayse)
  await zeynep.page.getByTestId('btn-drawer').click()
  await joinVoice(zeynep)
  await expectHearing(ayse, zeynep)
  await sw.cut()
  const banner = zeynep.page.getByTestId('connection-banner')
  await expect(banner).toHaveText(KEPT)
  if (!(await zeynep.page.getByTestId('btn-camera').isVisible())) await zeynep.page.getByTestId('btn-drawer').click()
  await zeynep.page.getByTestId('btn-camera').click()
  await expect(zeynep.page.getByTestId('btn-camera')).toHaveAttribute('data-held', 'true')
  expect(await zeynep.page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await zeynep.page.screenshot({ path: 'screenshots/v4-voice-kept-390.png' })
  sw.online = true
  await expectConnected(zeynep.page)
  await expectTileDecoding(ayse.page, `remote-camera-${zeynep.user.id}`, 'camera', 'Zeynep')
})
