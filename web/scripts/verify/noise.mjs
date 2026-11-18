// Noise suppression: the RNNoise worklet really runs in the BUILT client (not
// the fallback), it changes what is sent, and toggling it in a call neither
// drops the call nor renegotiates (the sent track stays the same).
import { BASE, channels, check, inboundAudioEnergy, joinVoice, launch, noise, person, sleep, until, wavFile } from './lib.mjs'

async function sentTrackIds(page) {
  return page.evaluate(() =>
    (window.__trioPcs ?? [])
      .filter((pc) => pc.connectionState !== 'closed')
      .flatMap((pc) => pc.getSenders().filter((s) => s.track?.kind === 'audio').map((s) => s.track.id)),
  )
}

async function negotiations(page) {
  return page.evaluate(() =>
    (window.__trioPcs ?? []).map((pc) => [pc.connectionState, pc.signalingState, pc.currentLocalDescription?.sdp.length]),
  )
}

const wav = await wavFile('trio-noise.wav', 10, noise())
const browser = await launch([`--use-file-for-fake-audio-capture=${wav}`])
try {
  const a = await person(browser, 'Ayşe')
  const b = await person(browser, 'Bora')
  const voice = (await channels(a.token)).find((c) => c.kind === 'voice')

  // Which assets the built client fetched for RNNoise, and with which types.
  const assets = []
  a.context.on('response', (response) => {
    const url = response.url()
    if (/workletProcessor|rnnoise/.test(url)) assets.push([url.split('/').pop(), response.status(), response.headers()['content-type']])
  })

  await joinVoice(a, voice.id)
  await joinVoice(b, voice.id)
  await until(() => b.page.getByTestId(`remote-audio-${a.user.id}`).count(), 'B receives A')
  await until(async () => (await a.page.getByTestId('btn-settings').getAttribute('data-noise')) === 'active', 'RNNoise active')
  console.log('  assets:', JSON.stringify(assets))
  check(assets.some(([name, status]) => name.endsWith('.wasm') && status === 200), 'the wasm came from the bundle (200)')
  check(assets.some(([name, , type]) => name.endsWith('.wasm') && type === 'application/wasm'), 'served as application/wasm')
  // Worklet module fetches are invisible to Playwright's network events: find the URL
  // the built chunk asks for and fetch it from the same server.
  const workletPath = await a.page.evaluate(async () => {
    const chunk = [...performance.getEntriesByType('resource')].map((e) => e.name).find((n) => /\/assets\/rnnoise-[^/]+\.js$/.test(n))
    if (!chunk) return null
    const text = await (await fetch(chunk)).text()
    return /["'`](\/assets\/workletProcessor-[^"'`]+\.js)["'`]/.exec(text)?.[1] ?? null
  })
  const workletResponse = workletPath ? await fetch(new URL(workletPath, BASE)) : null
  console.log('  worklet module:', workletPath, workletResponse?.status, workletResponse?.headers.get('content-type'))
  check(workletResponse?.status === 200 && /javascript/.test(workletResponse.headers.get('content-type') ?? ''), 'the worklet module is a local asset served as JavaScript')
  check(!a.logs.some((line) => line.includes('noise suppression unavailable')), 'no fallback warning')
  await sleep(2000)

  const tracksBefore = await sentTrackIds(a.page)
  const sdpBefore = await negotiations(a.page)
  const on = await inboundAudioEnergy(b.page, 1500)
  console.log('  energy of white noise, RNNoise on:', on.toExponential(2))

  await a.page.getByTestId('btn-settings').click()
  await a.page.getByTestId('settings-dialog').waitFor()
  check((await a.page.getByTestId('settings-noise-state').getAttribute('data-state')) === 'active', 'dialog says active')
  await a.page.getByTestId('settings-noise').uncheck()
  await until(async () => (await a.page.getByTestId('btn-settings').getAttribute('data-noise')) === 'off', 'RNNoise off')
  await sleep(2000)
  const off = await inboundAudioEnergy(b.page, 1500)
  console.log('  energy of white noise, RNNoise off (browser NS on):', off.toExponential(2))
  check(on < off / 5, `RNNoise really processes the sent audio (on ${on.toExponential(2)} << off ${off.toExponential(2)})`)

  await a.page.getByTestId('settings-noise').check()
  await until(async () => (await a.page.getByTestId('btn-settings').getAttribute('data-noise')) === 'active', 'RNNoise back on')
  await sleep(2000)
  const again = await inboundAudioEnergy(b.page, 1500)
  console.log('  energy, RNNoise on again:', again.toExponential(2))
  check(again < off / 5, 'suppression is back after toggling on')
  const tracksAfter = await sentTrackIds(a.page)
  check(JSON.stringify(tracksBefore) === JSON.stringify(tracksAfter), 'the sent track never changed (no renegotiation needed)')
  const sdpAfter = await negotiations(a.page)
  check(JSON.stringify(sdpBefore) === JSON.stringify(sdpAfter), 'no renegotiation happened')
  check(sdpAfter.every(([state]) => state === 'connected'), 'the call is still connected')
  check(await b.page.getByTestId(`remote-audio-${a.user.id}`).count(), 'B still has A')
  await a.page.getByTestId('settings-close').click()

  // Fallback: the wasm cannot be loaded -> the raw microphone is sent, silently.
  const c = await person(browser, 'Cem')
  await c.context.route('**/*.wasm', (route) => route.abort())
  await joinVoice(c, voice.id)
  await until(async () => (await c.page.getByTestId('btn-settings').getAttribute('data-noise')) === 'unavailable', 'fallback state')
  await until(() => b.page.getByTestId(`remote-audio-${c.user.id}`).count(), 'B receives C')
  check(!(await c.page.locator('.voice-error').count()), 'no error shown to the user on fallback')
  check(c.logs.some((line) => line.includes('noise suppression unavailable')), 'a console warning on fallback')
  await a.page.getByTestId('btn-hangup').click()
  await sleep(2500)
  const fallback = await inboundAudioEnergy(b.page, 1500)
  console.log('  energy from the fallback user:', fallback.toExponential(2))
  check(fallback > 1e-3, 'the fallback user is heard (raw microphone)')
  console.log('noise suppression: all checks passed')
} finally {
  await browser.close()
}
