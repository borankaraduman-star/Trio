/**
 * CONTRACT-V6-MEDIA §4: voice messages — hold to record and let go to send,
 * click to start and "Gönder" to stop, Esc or sliding away to cancel; a live
 * level and time; the others get a compact player whose audio really plays
 * (duration, time advancing), with the waveform as seek bar and 1×/1,5×/2×,
 * one at a time. Recording while in a voice room leaves the call alone: the
 * others keep receiving the microphone (receiver-side bytes and level).
 */
import path from 'node:path'
import type { Page } from '@playwright/test'
import { E2E_DIR, freshServer } from '../lib/server'
import { expect, expectHearing, GENEL, joinVoice, personViaApi, remoteAudioProbe, test, threePeople } from '../lib/trio'
import { lastAttachments } from '../lib/v6media'

const OUT = path.join(E2E_DIR, 'screenshots')

test.beforeEach(async () => {
  await freshServer()
})

const voiceRows = (page: Page) => page.getByTestId('message').filter({ has: page.getByTestId('voice-message') })

/** The recording's clock has reached `seconds` (read as a number: a busy machine may skip a tick). */
async function recordedFor(page: Page, seconds: number): Promise<void> {
  await expect
    .poll(
      async () => {
        const text = (await page.getByTestId('voice-recording-time').textContent().catch(() => null)) ?? ''
        const match = /^(\d+):(\d\d) \/ 2:00$/.exec(text)
        return match ? Number(match[1]) * 60 + Number(match[2]) : -1
      },
      { timeout: 15_000, intervals: [50] },
    )
    .toBeGreaterThanOrEqual(seconds)
}

/** Hold the microphone with the mouse until the recording has run `seconds`, then let go (or not). */
async function holdToRecord(page: Page, seconds: number, release = true): Promise<void> {
  const box = (await page.getByTestId('btn-voice').boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await recordedFor(page, seconds)
  if (release) await page.mouse.up()
}

/** The live meter showed sound at some point (the fake microphone beeps every 500 ms). */
async function meterMoved(page: Page): Promise<void> {
  await expect
    .poll(async () => Number(await page.getByTestId('voice-level').getAttribute('data-level')), { timeout: 5_000, intervals: [50] })
    .toBeGreaterThan(0.01)
}

async function audioFacts(page: Page, index: number) {
  return voiceRows(page)
    .nth(index)
    .getByTestId('voice-audio')
    .evaluate((a: HTMLAudioElement) => ({ duration: a.duration, time: a.currentTime, paused: a.paused, rate: a.playbackRate, ready: a.readyState }))
}

test('hold to record, let go to send; the others play it; click mode; cancel by Esc and by sliding away; one player at a time', async ({ browser, trio }) => {
  test.setTimeout(150_000)
  const [ayse, mehmet, zeynep] = await threePeople(browser, trio)
  const page = ayse.page
  const types = await page.evaluate(() =>
    ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].filter((t) => MediaRecorder.isTypeSupported(t)),
  )
  console.log(`[v6] MediaRecorder types in this Chromium: ${types.join(', ')}`)
  test.info().annotations.push({ type: 'MediaRecorder types', description: types.join(', ') })

  // The microphone shows only while the box is empty.
  await page.getByTestId('composer').fill('yazı var')
  await expect(page.getByTestId('btn-voice')).toHaveCount(0)
  await page.getByTestId('composer').fill('')

  // 1. Hold, see time and level, let go: sent as a voice message.
  await holdToRecord(page, 2, false)
  await meterMoved(page)
  await expect(page.getByTestId('composer')).toBeHidden()
  await page.mouse.up()
  await expect(page.getByTestId('voice-recording')).toHaveCount(0)
  await expect(voiceRows(page)).toHaveCount(1)
  await expect(voiceRows(page).first()).toHaveAttribute('data-status', 'sent')
  const [stored] = await lastAttachments(ayse.token, GENEL)
  expect(stored.content_type).toBe('audio/webm')
  expect(stored.voice!.duration_ms).toBeGreaterThanOrEqual(2000)
  expect(stored.voice!.duration_ms).toBeLessThan(6000)
  expect(stored.voice!.waveform).toHaveLength(64)
  expect(Math.max(...stored.voice!.waveform)).toBe(255)

  // 2. The others: the player, the real audio (finite duration, time moving while it plays).
  for (const viewer of [mehmet, zeynep]) {
    const row = voiceRows(viewer.page).first()
    await expect(row.getByTestId('voice-time')).toHaveText(/^0:0[2-5]$/)
    await expect(row.locator('.voice-wave > span')).toHaveCount(64)
    await row.getByTestId('voice-play').click()
    await expect
      .poll(() => audioFacts(viewer.page, 0), { timeout: 10_000 })
      .toMatchObject({ paused: false })
    await expect.poll(async () => (await audioFacts(viewer.page, 0)).time, { timeout: 10_000 }).toBeGreaterThan(0.3)
    const facts = await audioFacts(viewer.page, 0)
    expect(Number.isFinite(facts.duration)).toBe(true)
    expect(facts.duration).toBeGreaterThan(1.8)
    expect(facts.duration).toBeLessThan(6)
    await expect(row.locator('.voice-wave > span.played').first()).toBeVisible()
    // Faster.
    await row.getByTestId('voice-rate').click()
    await expect(row.getByTestId('voice-rate')).toHaveText('1,5×')
    expect((await audioFacts(viewer.page, 0)).rate).toBe(1.5)
    await expect.poll(async () => (await audioFacts(viewer.page, 0)).paused, { timeout: 10_000 }).toBe(true)
  }

  // 3. Seeking on the waveform: a click at three quarters.
  const wave = voiceRows(mehmet.page).first().getByTestId('voice-wave')
  const waveBox = (await wave.boundingBox())!
  await mehmet.page.mouse.click(waveBox.x + waveBox.width * 0.75, waveBox.y + waveBox.height / 2)
  await expect.poll(async () => (await audioFacts(mehmet.page, 0)).time).toBeGreaterThan(1.2)

  // 4. Click mode: a short click starts, "Gönder" stops and sends.
  await page.getByTestId('btn-voice').click()
  await recordedFor(page, 1)
  await page.getByTestId('voice-send').click()
  await expect(voiceRows(page)).toHaveCount(2)
  await expect(voiceRows(mehmet.page)).toHaveCount(2)

  // 5. Cancelled by Esc while held, and by sliding away: nothing is sent, the box comes back.
  await holdToRecord(page, 1, false)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('voice-recording')).toHaveCount(0)
  await page.mouse.up()
  await holdToRecord(page, 1, false)
  const mic = (await page.getByTestId('btn-voice').boundingBox())!
  await page.mouse.move(mic.x - 200, mic.y + 10, { steps: 5 })
  await expect(page.getByTestId('voice-recording')).toHaveCount(0)
  await page.mouse.up()
  await expect(page.getByTestId('composer')).toBeVisible()
  await expect(voiceRows(page)).toHaveCount(2)
  await expect(voiceRows(zeynep.page)).toHaveCount(2)
  await expect(page.getByTestId('pending-attachment')).toHaveCount(0)

  // 6. One at a time: starting the second pauses the first.
  const rows = voiceRows(zeynep.page)
  await rows.nth(0).getByTestId('voice-play').click()
  await expect.poll(async () => (await audioFacts(zeynep.page, 0)).paused).toBe(false)
  await rows.nth(1).getByTestId('voice-play').click()
  await expect.poll(async () => (await audioFacts(zeynep.page, 1)).paused).toBe(false)
  expect((await audioFacts(zeynep.page, 0)).paused).toBe(true)
})

test('recording in a voice room: the call keeps flowing to the others', async ({ browser, trio }) => {
  test.setTimeout(150_000)
  const [ayse, mehmet] = await threePeople(browser, trio)
  await joinVoice(ayse)
  await joinVoice(mehmet)
  await expectHearing(mehmet, ayse)

  await holdToRecord(ayse.page, 1, false)
  // While Ayşe records, Mehmet still receives her microphone: bytes grow and it is audible.
  const before = await remoteAudioProbe(mehmet.page, ayse.user.id)
  await expectHearing(mehmet, ayse)
  const during = await remoteAudioProbe(mehmet.page, ayse.user.id)
  expect(during.bytes).toBeGreaterThan(before.bytes)
  expect(during.level).toBeGreaterThan(0.01)
  // Her call is still connected and not muted by it.
  await expect(ayse.page.locator('.voice-status strong')).toHaveText('Ses bağlı')
  await ayse.page.mouse.up()
  await expect(voiceRows(mehmet.page)).toHaveCount(1)
  // And after: still flowing.
  await expectHearing(mehmet, ayse)
})

test('microphone refused: a clear Turkish message, nothing sent', async ({ browser, trio }) => {
  const ayse = trio.add(
    await personViaApi(browser, 'Ayşe', {
      prepare: async (context) => {
        await context.addInitScript(() => {
          navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError'))
        })
      },
    }),
  )
  await ayse.page.getByTestId('btn-voice').click()
  await expect(ayse.page.getByTestId('attachment-notice')).toContainText('Mikrofon izni verilmedi')
  await expect(ayse.page.getByTestId('voice-recording')).toHaveCount(0)
  await expect(ayse.page.getByTestId('message')).toHaveCount(0)
})

test('390 px: recording and the player fit; screenshot of a conversation with a voice message and a photo chip', async ({ browser, trio }) => {
  test.setTimeout(150_000)
  const [ayse, mehmet] = await threePeople(browser, trio)
  const phone = trio.add(await personViaApi(browser, 'Ece', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }))
  await ayse.page.getByTestId('composer').fill('Akşam ne yapıyoruz?')
  await ayse.page.getByTestId('composer').press('Enter')
  await holdToRecord(mehmet.page, 3)
  await expect(voiceRows(mehmet.page)).toHaveCount(1)
  await expect(voiceRows(phone.page)).toHaveCount(1)

  // On the phone: the player inside the screen; recording with a finger.
  const player = voiceRows(phone.page).first().getByTestId('voice-message')
  const box = (await player.boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(390)
  await phone.page.getByTestId('btn-voice').tap()
  await recordedFor(phone.page, 1)
  for (const id of ['voice-recording', 'voice-cancel', 'voice-send', 'btn-voice']) {
    await expect(phone.page.getByTestId(id)).toBeInViewport({ ratio: 1 })
  }
  expect(await phone.page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await phone.page.getByTestId('voice-send').tap()
  await expect(voiceRows(phone.page)).toHaveCount(2)

  // The desktop screenshot: Ayşe's conversation with two voice messages and a photo being made smaller.
  const shot = trio.add(await personViaApi(browser, 'Deniz', { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 }))
  const { noisyJpeg, chipsDone } = await import('../lib/v6media')
  const photo = await noisyJpeg(shot.page, 4000, 3000)
  await shot.page.getByTestId('file-input').setInputFiles({ name: 'IMG_2041.jpg', mimeType: 'image/jpeg', buffer: photo })
  await chipsDone(shot.page, 1)
  await shot.page.getByTestId('composer').fill('Kapadokya’dan bir kare')
  await voiceRows(shot.page).first().getByTestId('voice-play').click()
  await expect.poll(() => audioFacts(shot.page, 0).then((f) => f.time), { timeout: 10_000 }).toBeGreaterThan(0.5)
  await voiceRows(shot.page).first().getByTestId('voice-play').click()
  await shot.page.mouse.move(5, 5)
  await shot.page.screenshot({ path: path.join(OUT, 'v6-media-voice-photo.png') })
  await phone.page.screenshot({ path: path.join(OUT, 'v6-media-voice-390.png') })
})
