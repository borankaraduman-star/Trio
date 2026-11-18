// Push-to-talk: outgoing audio is silent unless the key is held, the 150 ms
// tail, no trigger while typing in the composer, blur releases the key, and
// voice.state.muted is NOT touched by the gating.
import { channels, check, inboundAudioEnergy, joinVoice, launch, person, sleep, until, voiceish, wavFile } from './lib.mjs'

const wav = await wavFile('trio-voiceish.wav', 10, voiceish)
const browser = await launch([`--use-file-for-fake-audio-capture=${wav}`])
try {
  const a = await person(browser, 'Ayşe', {
    settings: { version: 1, inputMode: 'ptt', pttKey: 'Backquote', noiseSuppression: false },
  })
  const b = await person(browser, 'Bora')
  const voice = (await channels(a.token)).find((c) => c.kind === 'voice')

  await joinVoice(a, voice.id)
  await joinVoice(b, voice.id)
  await until(() => b.page.getByTestId(`remote-audio-${a.user.id}`).count(), 'B receives A')
  await sleep(1500)

  const silent = await inboundAudioEnergy(b.page, 1200)
  console.log('  energy, key up:', silent.toExponential(2))
  check(silent < 1e-5, 'nothing is sent while the PTT key is up')
  check((await a.page.getByTestId('btn-mute').getAttribute('data-transmitting')) === 'false', 'A shows not transmitting')

  // Hold the key with the focus OUTSIDE any text field.
  await a.page.locator('.main-header').click()
  await a.page.keyboard.down('Backquote')
  await sleep(600)
  const held = await inboundAudioEnergy(b.page, 1200)
  console.log('  energy, key held:', held.toExponential(2))
  check(held > 1e-4, 'audio flows while the key is held')
  check((await a.page.getByTestId('btn-mute').getAttribute('data-transmitting')) === 'true', 'A shows transmitting')
  check(
    (await b.page.getByTestId(`voice-user-${a.user.id}`).getAttribute('data-muted')) === 'false',
    'voice.state.muted stays false (PTT gating is local)',
  )
  await until(
    async () => (await b.page.getByTestId(`voice-user-${a.user.id}`).getAttribute('data-speaking')) === 'true',
    'B sees A speaking while held',
  )

  // Release: open for the 150 ms tail, then closed.
  await a.page.keyboard.up('Backquote')
  const afterTail = await a.page.evaluate(
    () =>
      new Promise((resolve) => {
        const button = document.querySelector('[data-testid="btn-mute"]')
        const at50 = () => button.getAttribute('data-transmitting')
        setTimeout(() => {
          const early = at50()
          setTimeout(() => resolve({ early, late: button.getAttribute('data-transmitting') }), 250)
        }, 60)
      }),
  )
  check(afterTail.early === 'true' && afterTail.late === 'false', `150 ms release tail (${JSON.stringify(afterTail)})`)
  await sleep(500)
  const released = await inboundAudioEnergy(b.page, 1200)
  console.log('  energy, released:', released.toExponential(2))
  check(released < 1e-5, 'silent again after release')

  // Typing: the same key inside the composer must not open the microphone.
  await a.page.getByTestId('composer').click()
  await a.page.keyboard.down('Backquote')
  await sleep(500)
  const typing = await inboundAudioEnergy(b.page, 1000)
  await a.page.keyboard.up('Backquote')
  console.log('  energy, key in composer:', typing.toExponential(2))
  check(typing < 1e-5, 'no trigger while typing in the composer')
  check((await a.page.getByTestId('composer').inputValue()).includes('`'), 'the key still types into the composer')

  // Blur while held releases.
  await a.page.locator('.main-header').click()
  await a.page.keyboard.down('Backquote')
  await sleep(300)
  check((await a.page.getByTestId('btn-mute').getAttribute('data-transmitting')) === 'true', 'held again')
  await a.page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await sleep(400)
  check((await a.page.getByTestId('btn-mute').getAttribute('data-transmitting')) === 'false', 'window blur releases the key')
  await a.page.keyboard.up('Backquote')

  // Mute wins over the key.
  await a.page.getByTestId('btn-mute').click()
  await a.page.locator('.main-header').click()
  await a.page.keyboard.down('Backquote')
  await sleep(500)
  const mutedHeld = await inboundAudioEnergy(b.page, 1000)
  await a.page.keyboard.up('Backquote')
  check(mutedHeld < 1e-5, 'muted + key held = silent')
  check(
    (await until(async () => (await b.page.getByTestId(`voice-user-${a.user.id}`).getAttribute('data-muted')) === 'true', 'muted flag')) ,
    'the mute button still sets voice.state.muted',
  )
  await a.page.getByTestId('btn-mute').click()

  // Back to activity mode through the dialog: always open.
  await a.page.getByTestId('btn-settings').click()
  await a.page.getByTestId('settings-mode-activity').check()
  await a.page.getByTestId('settings-close').click()
  await sleep(800)
  const activity = await inboundAudioEnergy(b.page, 1200)
  console.log('  energy, activity mode:', activity.toExponential(2))
  check(activity > 1e-4, 'activity mode sends without the key')
  console.log('PTT: all checks passed')
} finally {
  await browser.close()
}
