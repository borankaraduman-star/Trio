/**
 * CONTRACT-V8-MUSIC: Ayşe shares the sound "playing on her computer" (the
 * test page's getDisplayMedia answers a stereo tone, see lib/v8music.ts);
 * Mehmet and Zeynep receive it as STEREO Opus at ~128 kbit/s in its own
 * element, told from her microphone by `meta.music`, with their own music
 * volume and mute; deafen silences it; her microphone's mute and push-to-talk
 * do not touch it, it never lights her speaking ring, and the title is text.
 */
import path from 'node:path'
import { freshServer } from '../lib/server'
import { expect, expectHearing, joinVoice, personViaApi, test, type Person } from '../lib/trio'
import { audioElement } from '../lib/v6voice'
import { SCREENSHOTS } from '../lib/v7phone'
import { expectMusicFlowing, expectStereoMusic, FAKE_MUSIC_CAPTURE, musicIn, musicOut } from '../lib/v8music'

test.beforeEach(async () => {
  await freshServer()
})

async function sharer(browser: Parameters<typeof personViaApi>[0], name: string): Promise<Person> {
  return personViaApi(browser, name, { prepare: (context) => context.addInitScript(FAKE_MUSIC_CAPTURE) })
}

test('music: stereo at ~128 kbit/s to everyone, its own element and volume, mute and deafen, title as text', async ({ browser, trio }) => {
  test.setTimeout(240_000)
  const ayse = trio.add(await sharer(browser, 'Ayşe'))
  const mehmet = trio.add(await personViaApi(browser, 'Mehmet'))
  const zeynep = trio.add(await personViaApi(browser, 'Zeynep'))

  // Not in voice: no music button.
  await expect(ayse.page.getByTestId('btn-music')).toHaveCount(0)
  for (const person of [ayse, mehmet, zeynep]) await joinVoice(person)
  await expectHearing(mehmet, ayse)

  await ayse.page.getByTestId('btn-music').click()
  await expect(ayse.page.getByTestId('btn-music')).toHaveAttribute('aria-pressed', 'true')
  await expect(ayse.page.getByTestId('music-panel')).toBeVisible()

  // What the picker was asked for (CONTRACT-V8-MUSIC §3).
  const calls = await ayse.page.evaluate(() => (window as unknown as { __trioMusicCalls: Record<string, unknown>[] }).__trioMusicCalls)
  expect(calls).toHaveLength(1)
  expect(calls[0]).toMatchObject({
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'exclude',
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 },
  })
  // The picture is never sent: only audio senders on Ayşe's connections.
  const kinds = await ayse.page.evaluate(() =>
    (window as unknown as { __trioPcs: RTCPeerConnection[] }).__trioPcs
      .filter((pc) => pc.connectionState !== 'closed')
      .flatMap((pc) => pc.getSenders().map((s) => s.track?.kind ?? 'none')),
  )
  expect(kinds.filter((k) => k === 'video')).toEqual([])

  // Both listeners: a separate element, stereo, at the music bitrate.
  for (const listener of [mehmet, zeynep]) {
    await expect(listener.page.getByTestId(`remote-music-${ayse.user.id}`)).toHaveCount(1, { timeout: 20_000 })
    const heard = await expectStereoMusic(listener, ayse, `${listener.name} gets Ayşe's music in stereo`)
    console.log(`music in (${listener.name}): ${JSON.stringify(heard)}`)
    expect(heard.kbps).toBeGreaterThan(90)
    expect(heard.kbps).toBeLessThan(170)
    // The microphone is still the microphone (its own element and track).
    await expectHearing(listener, ayse)
  }
  const out = await musicOut(ayse)
  console.log(`music out: ${JSON.stringify(out)}`)
  expect(out).toHaveLength(2)
  for (const sender of out) {
    expect(sender.maxBitrate).toBe(128_000)
    expect(sender.fmtp).toContain('stereo=1')
    expect(sender.kbps).toBeGreaterThan(90)
  }
  // The microphone's m-line stays mono (only music m-lines are made stereo).
  const micFmtp = await ayse.page.evaluate(async () => {
    const lines: string[] = []
    for (const pc of (window as unknown as { __trioPcs: RTCPeerConnection[] }).__trioPcs) {
      if (pc.connectionState === 'closed') continue
      const sender = pc.getSenders().find((s) => s.track?.kind === 'audio' && s.track.contentHint !== 'music')
      if (!sender) continue
      ;(await sender.getStats()).forEach((s) => {
        if (s.type === 'codec') lines.push(s.sdpFmtpLine ?? '')
      })
    }
    return lines
  })
  expect(micFmtp.length).toBeGreaterThan(0)
  for (const line of micFmtp) expect(line).not.toContain('stereo=1')

  // The room shows it: a note mark on her row; no title yet.
  const row = mehmet.page.getByTestId(`voice-user-${ayse.user.id}`)
  await expect(row).toHaveAttribute('data-music', 'true')
  await expect(mehmet.page.getByTestId(`music-now-playing-${ayse.user.id}`)).toHaveCount(0)

  // The title she types is sent (as text, cleaned of markup's power) after a pause.
  await ayse.page.getByTestId('music-title-input').fill('<b>Daft Punk</b> — One More Time')
  const line = mehmet.page.getByTestId(`music-now-playing-${ayse.user.id}`)
  await expect(line).toHaveText('Şu an çalıyor: <b>Daft Punk</b> — One More Time')
  expect(await line.locator('b').count()).toBe(0)
  await expect(zeynep.page.getByTestId(`music-now-playing-${ayse.user.id}`)).toContainText('One More Time')
  await ayse.page.screenshot({ path: path.join(SCREENSHOTS, 'v8-music-sharer.png') })

  // "Şarkı adını göster" off: no title on the wire, the line goes; the mark stays.
  await ayse.page.getByTestId('music-title-toggle').uncheck()
  await expect(line).toHaveCount(0)
  await expect(row).toHaveAttribute('data-music', 'true')
  await ayse.page.getByTestId('music-title-toggle').check()
  await expect(line).toContainText('One More Time')

  // Her microphone muted: the music goes on, her mic is silent, her ring stays dark.
  await ayse.page.getByTestId('btn-mute').click()
  await expect(row).toHaveAttribute('data-muted', 'true')
  await expectMusicFlowing(mehmet, ayse, 'muted microphone: the music still arrives')
  for (let i = 0; i < 10; i++) {
    await expect(row).toHaveAttribute('data-speaking', 'false')
    await mehmet.page.waitForTimeout(300)
  }
  await expect(ayse.page.getByTestId(`voice-user-${ayse.user.id}`)).toHaveAttribute('data-speaking', 'false')

  // Mehmet's music volume and mute, apart from Ayşe's voice volume (default 50 %).
  expect((await musicIn(mehmet, ayse))?.volume).toBeCloseTo(0.5, 2)
  await row.click({ button: 'right' })
  await expect(mehmet.page.getByTestId('volume-sheet')).toBeVisible()
  await mehmet.page.getByTestId(`music-volume-${ayse.user.id}`).fill('20')
  await expect.poll(async () => (await musicIn(mehmet, ayse, 200))?.volume).toBeCloseTo(0.2, 2)
  expect(await audioElement(mehmet.page, ayse.user.id)).toEqual({ volume: 1, muted: false, route: 'element' })
  // A voice boost does not touch the music.
  await mehmet.page.getByTestId('volume-voice').fill('150')
  await expect.poll(async () => (await audioElement(mehmet.page, ayse.user.id)).route).toBe('webaudio')
  expect((await musicIn(mehmet, ayse, 200))?.volume).toBeCloseTo(0.2, 2)
  await mehmet.page.screenshot({ path: path.join(SCREENSHOTS, 'v8-music-volume.png') })
  await mehmet.page.getByTestId(`music-mute-${ayse.user.id}`).click()
  await expect(mehmet.page.getByTestId(`music-mute-${ayse.user.id}`)).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(async () => (await musicIn(mehmet, ayse, 200))?.muted).toBe(true)
  await mehmet.page.getByTestId(`music-mute-${ayse.user.id}`).click()
  await expect.poll(async () => (await musicIn(mehmet, ayse, 200))?.muted).toBe(false)
  await mehmet.page.getByTestId('volume-reset').click()
  await mehmet.page.keyboard.press('Escape')
  // Remembered on the device, apart from the voice volumes.
  expect(await mehmet.page.evaluate(() => JSON.parse(localStorage.getItem('trio.music8') ?? '{}'))).toEqual({
    volumes: { [String(ayse.user.id)]: { volume: 0.2, muted: false } },
    showTitle: true,
  })
  // Zeynep's own choice is untouched.
  expect((await musicIn(zeynep, ayse, 200))?.volume).toBeCloseTo(0.5, 2)

  // Deafen silences the music too, and undeafening brings it back.
  await zeynep.page.getByTestId('btn-deafen').click()
  await expect.poll(async () => (await musicIn(zeynep, ayse, 200))?.muted).toBe(true)
  await zeynep.page.getByTestId('btn-deafen').click()
  await expect.poll(async () => (await musicIn(zeynep, ayse, 200))?.muted).toBe(false)

  // "Müziği durdur": the element goes for both, the mark goes, the mic stays.
  await ayse.page.getByTestId('btn-mute').click()
  await ayse.page.getByTestId('btn-music').click()
  await expect(ayse.page.getByTestId('btn-music')).toHaveAttribute('aria-pressed', 'false')
  for (const listener of [mehmet, zeynep]) {
    await expect(listener.page.getByTestId(`remote-music-${ayse.user.id}`)).toHaveCount(0)
    await expect(listener.page.getByTestId(`voice-user-${ayse.user.id}`)).toHaveAttribute('data-music', 'false')
    await expectHearing(listener, ayse)
  }
  await expect(ayse.page.getByTestId('music-panel')).toHaveCount(0)
})
