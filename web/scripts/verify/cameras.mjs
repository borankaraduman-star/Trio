// Camera + screen at once: two cameras and one shared screen in a call of
// three. Every remote tile really decodes (videoWidth > 0, frames advance) and
// is labelled camera vs screen by the `meta` signal. Stopping the camera
// releases the device. Screenshot: shots/cameras.png.
import { join } from 'node:path'
import { channels, check, joinVoice, launch, person, SHOTS, sleep, until, videoFacts } from './lib.mjs'

const browser = await launch(['--auto-select-desktop-capture-source=Entire screen'])
try {
  const a = await person(browser, 'Ayşe', { scale: 2, viewport: { width: 1280, height: 800 } })
  const b = await person(browser, 'Bora')
  const c = await person(browser, 'Cem')
  const voice = (await channels(a.token)).find((ch) => ch.kind === 'voice')
  for (const p of [a, b, c]) await joinVoice(p, voice.id)
  for (const p of [a, b, c]) {
    for (const q of [a, b, c]) {
      if (p !== q) await until(() => p.page.getByTestId(`remote-audio-${q.user.id}`).count(), `${p.user.name} hears ${q.user.name}`)
    }
  }

  await a.page.getByTestId('btn-camera').click()
  await b.page.getByTestId('btn-camera').click()
  await c.page.getByTestId('btn-screen').click()
  await until(async () => (await c.page.getByTestId('btn-screen').getAttribute('aria-pressed')) === 'true', 'C shares the screen')

  const expectations = [
    [a, [[`remote-camera-${b.user.id}`, 'camera'], ['remote-video', 'screen']], 'local-camera'],
    [b, [[`remote-camera-${a.user.id}`, 'camera'], ['remote-video', 'screen']], 'local-camera'],
    [c, [[`remote-camera-${a.user.id}`, 'camera'], [`remote-camera-${b.user.id}`, 'camera']], 'local-video'],
  ]
  for (const [p, tiles, local] of expectations) {
    for (const [testId, kind] of tiles) {
      const selector = `[data-testid="${testId}"]`
      const facts = await until(async () => {
        const f = await videoFacts(p.page, selector)
        return f && f.width > 0 && f.advancing ? f : null
      }, `${p.user.name}: ${testId} decodes`)
      check(facts.kind === kind, `${p.user.name}: ${testId} is a ${kind} tile, ${facts.width}x${facts.height}, frames advancing`)
    }
    check(await p.page.locator(`[data-testid="${local}"]`).count(), `${p.user.name}: own preview (${local})`)
    // Exactly one screen tile in each of A and B (C's), none mislabelled.
    const screens = await p.page.locator('[data-testid="remote-video"]').count()
    check(screens === (p === c ? 0 : 1), `${p.user.name}: ${screens} remote screen tile(s)`)
  }
  check(
    (await c.page.getByTestId(`voice-user-${a.user.id}`).getAttribute('data-camera')) === 'true',
    'the sidebar shows the camera flag from voice.state',
  )

  await a.page.waitForTimeout(800)
  await a.page.screenshot({ path: join(SHOTS, 'cameras.png') })
  console.log('  screenshot shots/cameras.png')

  // Focus: clicking a tile makes it large; clicking again goes back to the grid.
  await a.page.locator(`[data-testid="remote-video"]`).click()
  await until(() => a.page.locator('.call-stage.focus').count(), 'focused layout')
  check(await a.page.locator('.call-stage-main [data-testid="remote-video"]').count(), 'the clicked tile is the large one')
  await a.page.screenshot({ path: join(SHOTS, 'cameras-focus.png') })
  await a.page.locator('.call-stage-main .call-tile').click()
  await until(() => a.page.locator('.call-stage.grid').count(), 'back to the grid')

  // Stopping the camera releases the device and the tile goes away for others.
  await a.page.getByTestId('btn-camera').click()
  const tracks = await a.page.evaluate(() => (window.__trioCameraTracks ?? []).map((t) => t.readyState))
  check(tracks.length > 0 && tracks.every((state) => state === 'ended'), `every camera track is stopped: device released (${tracks})`)
  const sending = await a.page.evaluate(() =>
    (window.__trioPcs ?? []).some((pc) => pc.getSenders().some((s) => (window.__trioCameraTracks ?? []).includes(s.track))),
  )
  check(!sending, 'no camera track is sent any more')
  await until(async () => (await b.page.getByTestId(`remote-camera-${a.user.id}`).count()) === 0, 'B: A camera tile gone')
  await until(async () => (await c.page.getByTestId(`remote-camera-${a.user.id}`).count()) === 0, 'C: A camera tile gone')
  check((await a.page.getByTestId('local-camera').count()) === 0, 'A: own preview gone')
  check((await videoFacts(b.page, '[data-testid="remote-video"]'))?.advancing, 'B: the screen share is untouched')

  // And on again (a new stream id, announced by meta before the track).
  await a.page.getByTestId('btn-camera').click()
  const back = await until(async () => {
    const f = await videoFacts(c.page, `[data-testid="remote-camera-${a.user.id}"]`)
    return f && f.width > 0 && f.advancing ? f : null
  }, 'C sees A camera again')
  check(back.kind === 'camera', 'camera back on, labelled camera')
  console.log('cameras: all checks passed')
} finally {
  await browser.close()
}
