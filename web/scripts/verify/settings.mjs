// Settings dialog: device lists (with names after the permission grant), live
// microphone / camera switching in a call without renegotiation, output device
// through setSinkId, PTT key binding with a readable name, persistence in
// localStorage `trio.settings`. Screenshot: shots/settings.png.
import { join } from 'node:path'
import { channels, check, joinVoice, launch, person, SHOTS, sleep, until, videoFacts } from './lib.mjs'

const browser = await launch()
try {
  const a = await person(browser, 'Ayşe', { scale: 2 })
  const b = await person(browser, 'Bora')
  const voice = (await channels(a.token)).find((c) => c.kind === 'voice')
  await joinVoice(a, voice.id)
  await joinVoice(b, voice.id)
  await until(() => b.page.getByTestId(`remote-audio-${a.user.id}`).count(), 'B receives A')
  await until(() => a.page.getByTestId(`remote-audio-${b.user.id}`).count(), 'A receives B')
  await a.page.getByTestId('btn-camera').click()
  await until(async () => {
    const f = await videoFacts(b.page, `[data-testid="remote-camera-${a.user.id}"]`)
    return f?.width > 0 && f.advancing
  }, 'B sees A camera')

  await a.page.getByTestId('btn-settings').click()
  const dialog = a.page.getByTestId('settings-dialog')
  await dialog.waitFor()
  const options = async (testId) =>
    a.page.getByTestId(testId).locator('option').evaluateAll((list) => list.map((o) => [o.value, o.textContent]))
  const mics = await options('settings-mic')
  const cams = await options('settings-camera')
  const outs = (await a.page.getByTestId('settings-output').count()) ? await options('settings-output') : []
  console.log('  mics:', JSON.stringify(mics.map((o) => o[1])))
  console.log('  cameras:', JSON.stringify(cams.map((o) => o[1])))
  console.log('  outputs:', JSON.stringify(outs.map((o) => o[1])))
  check(mics.length >= 2 && mics[0][1] === 'Sistem varsayılanı', 'microphones listed after the default')
  check(cams.length >= 2, 'cameras listed')
  check(mics.slice(1).every(([, label]) => label.trim() !== ''), 'every device has a name')

  // Live microphone switch: the sent track stays, the raw device changes.
  const sentBefore = await a.page.evaluate(() =>
    window.__trioPcs.flatMap((pc) => pc.getSenders().filter((s) => s.track?.kind === 'audio').map((s) => s.track.id)),
  )
  const target = mics[mics.length - 1]
  await a.page.getByTestId('settings-mic').selectOption(target[0])
  const micState = await until(async () => {
    const tracks = await a.page.evaluate(() => (window.__trioMicTracks ?? []).map((t) => [t.label, t.readyState]))
    const live = tracks.filter(([, state]) => state === 'live')
    return live.length === 1 && live[0][0] === target[1] ? tracks : null
  }, 'the chosen microphone is the live one')
  console.log('  mic tracks:', JSON.stringify(micState))
  const sentAfter = await a.page.evaluate(() =>
    window.__trioPcs.flatMap((pc) => pc.getSenders().filter((s) => s.track?.kind === 'audio').map((s) => s.track.id)),
  )
  check(JSON.stringify(sentBefore) === JSON.stringify(sentAfter), 'microphone switched live, sent track unchanged (no renegotiation)')
  check(
    (await a.page.evaluate(() => window.__trioPcs.every((pc) => pc.connectionState === 'connected' || pc.connectionState === 'closed'))),
    'the call stays connected',
  )

  // Live camera switch through replaceTrack.
  const camTarget = cams[cams.length - 1]
  const sdpBefore = await a.page.evaluate(() => window.__trioPcs.map((pc) => pc.currentLocalDescription?.sdp ?? ''))
  await a.page.getByTestId('settings-camera').selectOption(camTarget[0])
  await until(async () => {
    const labels = await a.page.evaluate(() =>
      (window.__trioCameraTracks ?? []).filter((t) => t.readyState === 'live').map((t) => t.label),
    )
    return labels.length === 1 && labels[0] === camTarget[1]
  }, 'the chosen camera is the live one')
  await sleep(1000)
  const camFacts = await videoFacts(b.page, `[data-testid="remote-camera-${a.user.id}"]`)
  check(camFacts?.width > 0 && camFacts.advancing, 'B still decodes A camera after the switch')
  const sdpAfter = await a.page.evaluate(() => window.__trioPcs.map((pc) => pc.currentLocalDescription?.sdp ?? ''))
  check(JSON.stringify(sdpBefore) === JSON.stringify(sdpAfter), 'camera switched with replaceTrack (no renegotiation)')

  // Output device.
  if (outs.length >= 2) {
    const out = outs[outs.length - 1]
    await a.page.getByTestId('settings-output').selectOption(out[0])
    await until(
      async () => (await a.page.getByTestId(`remote-audio-${b.user.id}`).evaluate((el) => el.sinkId)) === out[0],
      'remote audio plays on the chosen output',
    )
    check(true, `remote audio sinkId = chosen output (${out[1]})`)
  } else {
    console.log('  (no selectable output devices in this browser: setSinkId not exercised)')
  }

  // Push-to-talk key binding.
  await a.page.getByTestId('settings-mode-ptt').check()
  check((await a.page.getByTestId('settings-ptt-key').innerText()).includes('Backquote'), 'default key shown readably')
  await a.page.getByTestId('settings-ptt-bind').click()
  await a.page.keyboard.press('KeyV')
  check((await a.page.getByTestId('settings-ptt-key').innerText()) === 'V', 'press-to-bind: KeyV shows as "V"')
  await a.page.getByTestId('settings-ptt-bind').click()
  await a.page.keyboard.press('Escape')
  check((await a.page.getByTestId('settings-ptt-key').innerText()) === 'V', 'Esc cancels binding and keeps the key')
  check(await dialog.isVisible(), 'and does not close the dialog')

  await sleep(300)
  await a.page.screenshot({ path: join(SHOTS, 'settings.png') })
  console.log('  screenshot shots/settings.png')

  const stored = JSON.parse(await a.page.evaluate(() => localStorage.getItem('trio.settings')))
  console.log('  stored:', JSON.stringify(stored))
  check(stored.inputMode === 'ptt' && stored.pttKey === 'KeyV' && stored.micDeviceId === target[0], 'persisted in trio.settings')
  await a.page.keyboard.press('Escape')
  check((await dialog.count()) === 0, 'Esc closes the dialog')

  // Survives a reload.
  await a.page.reload()
  await a.page.getByTestId('composer').waitFor()
  await a.page.getByTestId('btn-settings').click()
  check(await a.page.getByTestId('settings-mode-ptt').isChecked(), 'reload keeps PTT mode')
  check((await a.page.getByTestId('settings-ptt-key').innerText()) === 'V', 'reload keeps the key')
  // Reset for the other scripts.
  await a.page.getByTestId('settings-mode-activity').check()
  await a.page.evaluate(() => localStorage.removeItem('trio.settings'))
  console.log('settings: all checks passed')
} finally {
  await browser.close()
}
