import { expectEnergy, fakeAudioArgs, inboundEnergy, localDescriptions, sentAudioTrackIds, wavFile, whiteNoise } from '../lib/media'
import { baseUrl, freshServer } from '../lib/server'
import { apiJoin, expect, expectHearing, joinVoice, personViaApi, personWithSession, test, type Person } from '../lib/trio'

// Every microphone in this browser hears steady white noise: what RNNoise is
// for, and very different on the receiving side with it on and off.
test.use({ launchOptions: { args: fakeAudioArgs(wavFile('white-noise.wav', 10, whiteNoise())) } })

test.beforeEach(async () => {
  await freshServer()
})

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
  const on = await steadyEnergy(mehmet, ayse)

  // Off in the settings dialog: the noise comes through (the browser's own
  // filter is on again, and it leaves far more of it).
  await ayse.page.getByTestId('btn-settings').click()
  await expect(ayse.page.getByTestId('settings-noise-state')).toHaveAttribute('data-state', 'active')
  await ayse.page.getByTestId('settings-noise').uncheck()
  await expect(ayse.page.getByTestId('btn-settings')).toHaveAttribute('data-noise', 'off')
  await expect(ayse.page.getByTestId('settings-noise-state')).toHaveAttribute('data-state', 'off')
  let off = 0
  await expect.poll(async () => (off = await steadyEnergy(mehmet, ayse)), { timeout: 20_000 }).toBeGreaterThan(on * 5)

  // On again: suppressed again.
  await ayse.page.getByTestId('settings-noise').check()
  await expect(ayse.page.getByTestId('btn-settings')).toHaveAttribute('data-noise', 'active')
  await expect.poll(() => steadyEnergy(mehmet, ayse), { timeout: 20_000 }).toBeLessThan(off / 5)
  await ayse.page.getByTestId('settings-close').click()

  // Neither toggle renegotiated or swapped the sent track, and the call is still up.
  expect(await sentAudioTrackIds(ayse.page)).toEqual(tracksBefore)
  expect(await localDescriptions(ayse.page)).toEqual(sdpBefore)
  expect(sdpBefore.every((sdp) => sdp.startsWith('connected '))).toBe(true)
  await expect(ayse.page.locator('.voice-status strong')).toHaveText('Ses bağlı')
  await expectEnergy(mehmet, ayse, true, 'still sending after the toggles')

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
