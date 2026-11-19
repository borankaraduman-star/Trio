import { fakeAudioArgs, inboundEnergy, localDescriptions, sentAudioTrackIds, wavFile, whiteNoise } from '../lib/media'
import { baseUrl, freshServer } from '../lib/server'
import { apiJoin, expect, expectHearing, joinVoice, personViaApi, personWithSession, remoteAudioProbe, test, type Person } from '../lib/trio'

// Every microphone in this browser hears steady white noise: what RNNoise is
// for, and very different on the receiving side with it on and off.
test.use({ launchOptions: { args: fakeAudioArgs(wavFile('white-noise.wav', 10, whiteNoise())) } })

test.beforeEach(async () => {
  await freshServer()
})

/** RTP from `speaker` keeps arriving at `listener` (the call is up; the content may be silence). */
async function expectPacketsFlowing(listener: Person, speaker: Person): Promise<void> {
  const first = await remoteAudioProbe(listener.page, speaker.user.id)
  await expect.poll(async () => (await remoteAudioProbe(listener.page, speaker.user.id)).packets).toBeGreaterThan(first.packets + 20)
}

/** The lowest of a few readings: a single window can catch the suppressor adapting. */
async function steadyEnergy(listener: Person, speaker: Person): Promise<number> {
  const readings: number[] = []
  for (let i = 0; i < 3; i++) readings.push(await inboundEnergy(listener, speaker, 1000))
  return Math.min(...readings)
}

test('noise suppression: RNNoise runs in the built client; toggling keeps the call; blocked wasm falls back and is heard', async ({ browser, trio }) => {
  test.setTimeout(150_000)
  const assets: { name: string; status: number; type: string }[] = []
  const warnings: string[] = []
  const ayse = trio.add(
    await personWithSession(browser, 'Ayşe', await apiJoin('Ayşe'), {
      prepare: async (context) => {
        context.on('response', (response) => {
          const name = response.url().split('/').pop() ?? ''
          if (/rnnoise|workletProcessor/.test(name)) {
            assets.push({ name, status: response.status(), type: response.headers()['content-type'] ?? '' })
          }
        })
        context.on('console', (message) => {
          if (message.type() === 'warning') warnings.push(message.text())
        })
      },
    }),
  )
  const mehmet = trio.add(await personViaApi(browser, 'Mehmet'))
  await joinVoice(ayse)
  await joinVoice(mehmet)
  await expect(mehmet.page.getByTestId(`remote-audio-${ayse.user.id}`)).toHaveCount(1)
  // A join is two negotiations, one per side's microphone, taking turns (voice.ts). The
  // "nothing renegotiates" snapshot below must come after BOTH: Ayşe has Mehmet's audio,
  // and both connections are stable. On a slow machine the second one was still running
  // when the snapshot was taken, and its answer read as a renegotiation by the toggle.
  await expect(ayse.page.getByTestId(`remote-audio-${mehmet.user.id}`)).toHaveCount(1)
  for (const page of [ayse.page, mehmet.page]) {
    await expect
      .poll(() =>
        page.evaluate(() =>
          (window as unknown as { __trioPcs: RTCPeerConnection[] }).__trioPcs
            .filter((pc) => pc.connectionState !== 'closed')
            .every((pc) => pc.signalingState === 'stable' && pc.currentRemoteDescription !== null),
        ),
      )
      .toBe(true)
  }

  // Active, from the bundle the server serves: the wasm and the worklet module are local assets.
  await expect(ayse.page.getByTestId('btn-settings')).toHaveAttribute('data-noise', 'active')
  expect(assets.some((a) => a.name.endsWith('.wasm') && a.status === 200 && a.type === 'application/wasm')).toBe(true)
  // An AudioWorklet module fetch is invisible to Playwright's network events:
  // find the URL the built chunk asks for and fetch it from the same server.
  const workletPath = await ayse.page.evaluate(async () => {
    const chunk = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((name) => /\/assets\/rnnoise-[^/]+\.js$/.test(name))
    if (!chunk) return null
    const text = await (await fetch(chunk)).text()
    return /["'`](\/assets\/workletProcessor-[^"'`]+\.js)["'`]/.exec(text)?.[1] ?? null
  })
  expect(workletPath).not.toBeNull()
  const worklet = await fetch(new URL(workletPath!, baseUrl()))
  expect(worklet.status).toBe(200)
  expect(worklet.headers.get('content-type')).toMatch(/javascript/)
  expect(warnings.filter((w) => w.includes('noise suppression unavailable'))).toEqual([])

  const tracksBefore = await sentAudioTrackIds(ayse.page)
  const sdpBefore = await localDescriptions(ayse.page)
  expect(tracksBefore).toHaveLength(1)
  // What RNNoise does to this input, measured at Mehmet (energy per second):
  // with it off the loud white noise arrives at ~1.6e-1 whatever the time
  // (the browser's own suppressor leaves most of it); with it on the level
  // falls over 5-15 s, usually to far below 1e-3, but in one run of nine here
  // it was still at 2.6e-2 after 30 s (RNNoise is adaptive, and this is not
  // the kind of noise it was trained on). So the reference is the noise as sent with
  // RNNoise OFF, and "on" has to bring it down to a quarter of that.
  const level = (what: string) => ({ timeout: 30_000, message: what })

  await ayse.page.getByTestId('btn-settings').click()
  await expect(ayse.page.getByTestId('settings-noise-state')).toHaveAttribute('data-state', 'active')
  await ayse.page.getByTestId('settings-noise').uncheck()
  await expect(ayse.page.getByTestId('btn-settings')).toHaveAttribute('data-noise', 'off')
  await expect(ayse.page.getByTestId('settings-noise-state')).toHaveAttribute('data-state', 'off')
  let reference = 0
  await expect.poll(async () => (reference = await steadyEnergy(mehmet, ayse)), level('off: the noise is sent')).toBeGreaterThan(1e-2)

  for (let round = 1; round <= 2; round++) {
    await ayse.page.getByTestId('settings-noise').check()
    await expect(ayse.page.getByTestId('btn-settings')).toHaveAttribute('data-noise', 'active')
    await expect.poll(() => steadyEnergy(mehmet, ayse), level(`on (${round}): suppressed`)).toBeLessThan(reference / 4)
    if (round === 2) break
    await ayse.page.getByTestId('settings-noise').uncheck()
    await expect(ayse.page.getByTestId('btn-settings')).toHaveAttribute('data-noise', 'off')
    await expect.poll(() => steadyEnergy(mehmet, ayse), level('off again: the noise is back')).toBeGreaterThan(reference / 2)
  }
  await ayse.page.getByTestId('settings-close').click()

  // Neither toggle renegotiated or swapped the sent track, and the call is still up.
  expect(await sentAudioTrackIds(ayse.page)).toEqual(tracksBefore)
  expect(await localDescriptions(ayse.page)).toEqual(sdpBefore)
  expect(sdpBefore.every((sdp) => sdp.startsWith('connected '))).toBe(true)
  await expect(ayse.page.locator('.voice-status strong')).toHaveText('Ses bağlı')
  await expectPacketsFlowing(mehmet, ayse)

  // Zeynep's browser cannot load the wasm: she falls back to the raw
  // microphone with a console warning only, and is heard.
  const zeynepWarnings: string[] = []
  const zeynep = trio.add(
    await personWithSession(browser, 'Zeynep', await apiJoin('Zeynep'), {
      prepare: async (context) => {
        await context.route('**/*.wasm', (route) => route.abort())
        context.on('console', (message) => {
          if (message.type() === 'warning') zeynepWarnings.push(message.text())
        })
      },
    }),
  )
  await joinVoice(zeynep)
  await expect(zeynep.page.getByTestId('btn-settings')).toHaveAttribute('data-noise', 'unavailable')
  await expect(zeynep.page.locator('.voice-error')).toHaveCount(0)
  expect(zeynepWarnings.some((w) => w.includes('noise suppression unavailable'))).toBe(true)
  await zeynep.page.getByTestId('btn-settings').click()
  await expect(zeynep.page.getByTestId('settings-noise-state')).toHaveAttribute('data-state', 'unavailable')
  await expect(zeynep.page.getByTestId('settings-noise-state')).toHaveText('Gürültü engelleme yüklenemedi; ham mikrofon kullanılıyor.')
  await zeynep.page.getByTestId('settings-close').click()
  // (Not the other way round: Ayşe's only input is noise and her RNNoise
  // takes nearly all of it out, so from her Zeynep rightly hears silence.)
  await expectHearing(mehmet, zeynep)
  await expectHearing(ayse, zeynep)
})
