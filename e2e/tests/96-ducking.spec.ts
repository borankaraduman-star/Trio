/**
 * CONTRACT-V12-DUCKING: while somebody speaks, the listener's own playback of
 * a shared screen's sound (and, when chosen, of shared music) drops by the
 * configured amount and comes back after the hold and the release; voices
 * are not touched; the setting off changes nothing; it follows speech with
 * the tab hidden.
 *
 * Mehmet shares a screen whose sound is a steady tone (lib/v12duck.ts);
 * Zeynep's microphone is a continuous speech-like signal in her own browser,
 * so "speaking" starts when she unmutes and stops when she mutes; Ayşe and
 * Mehmet stay muted (the fake beep would duck too). Measured in Ayşe's page:
 * every 10 ms the screen element's volume (the element path's output gain),
 * and on the boost route the analyser AFTER its gain (the Web Audio path's
 * actual output) — a peak over a window, never one frame.
 */
import { chromium, type Page } from '@playwright/test'
import { fakeAudioArgs, voiceish, wavFile } from '../lib/media'
import { freshServer } from '../lib/server'
import { expect, joinVoice, personViaApi, test, type Person } from '../lib/trio'
import { settingsTab } from '../lib/v7phone'
import { boostLevels } from '../lib/v6voice'
import {
  DUCK_PROBE,
  duckState,
  FAKE_TONE_CAPTURE,
  shareSourcePeak,
  startRecorder,
  stopRecorder,
  tapPeaks,
  TONE_LEVEL,
  type DuckRecord,
} from '../lib/v12duck'

test.beforeEach(async () => {
  await freshServer()
})

/** Defaults: −60 %, so ducked = 40 % of the volume. */
const DUCKED = 0.4
const HOLD_MS = 250 + 300 // the ducker's own + the detector's
const RELEASE_MS = 650

async function setMuted(person: Person, muted: boolean): Promise<number> {
  const button = person.page.getByTestId('btn-mute')
  if ((await button.getAttribute('aria-pressed')) !== String(muted)) {
    const at = await person.page.evaluate(() => Date.now())
    await button.click()
    await expect(button).toHaveAttribute('aria-pressed', String(muted))
    return at
  }
  return person.page.evaluate(() => Date.now())
}

async function withSettings(page: Page, act: () => Promise<void>): Promise<void> {
  await page.getByTestId('btn-settings').click()
  await settingsTab(page, 'ses')
  await page.getByTestId('settings-duck').scrollIntoViewIfNeeded()
  await act()
  await page.getByTestId('settings-close').click()
}

interface Episode {
  /** ms from "speaking" on Ayşe's row to the level at the ducked value. */
  attack: number
  /** ms from her unmute click to the ducked value (network + detector + attack). */
  fromUnmute: number
  /** ms from the row's last "speaking" to the level back at full. */
  recovery: number
  /** The highest level between being ducked and speech ending (no pumping). */
  maxWhileSpeaking: number
  minWhileSpeaking: number
  /** The largest change between two samples 10 ms apart (smoothness). */
  maxStep: number
  voicesMin: number
}

function episode(records: DuckRecord[], field: 'share' | 'music', base: number, ducked: number, unmuteAt: number): Episode {
  const value = (r: DuckRecord) => r[field] ?? NaN
  const speakOn = records.find((r) => r.t >= unmuteAt && r.speaking)
  if (!speakOn) throw new Error(`speech never seen: ${JSON.stringify(records.slice(-3))}`)
  const duckedAt = records.find((r) => r.t >= unmuteAt && value(r) <= ducked + 0.03 * base)
  if (!duckedAt) throw new Error(`never ducked; min ${Math.min(...records.map(value))}`)
  const lastSpeak = [...records].reverse().find((r) => r.speaking)!
  const back = records.find((r) => r.t > lastSpeak.t && value(r) >= base * 0.98)
  if (!back) throw new Error(`never came back; last ${value(records[records.length - 1])}`)
  const during = records.filter((r) => r.t >= duckedAt.t && r.t <= lastSpeak.t).map(value)
  let maxStep = 0
  for (let i = 1; i < records.length; i++) maxStep = Math.max(maxStep, Math.abs(value(records[i]) - value(records[i - 1])))
  return {
    attack: duckedAt.t - speakOn.t,
    fromUnmute: duckedAt.t - unmuteAt,
    recovery: back.t - lastSpeak.t,
    maxWhileSpeaking: Math.max(...during),
    minWhileSpeaking: Math.min(...during),
    maxStep,
    voicesMin: Math.min(...records.flatMap((r) => r.voices)),
  }
}

/** Zeynep speaks for `ms`, then stops; returns Ayşe's records over it and the release after. */
async function speakAndRecord(ayse: Person, zeynep: Person, voiceIds: number[], ms = 2500): Promise<{ records: DuckRecord[]; unmuteAt: number }> {
  await startRecorder(ayse.page, zeynep.user.id, voiceIds)
  await ayse.page.waitForTimeout(300)
  const unmuteAt = await setMuted(zeynep, false)
  await ayse.page.waitForTimeout(ms)
  await setMuted(zeynep, true)
  await ayse.page.waitForTimeout(HOLD_MS + RELEASE_MS + 1200)
  return { records: await stopRecorder(ayse.page), unmuteAt }
}

async function people(browser: Parameters<typeof personViaApi>[0], trio: { add: (p: Person) => Person }) {
  const ayse = trio.add(await personViaApi(browser, 'Ayşe', { prepare: async (context) => void (await context.addInitScript(DUCK_PROBE)) }))
  const mehmet = trio.add(
    await personViaApi(browser, 'Mehmet', { prepare: async (context) => void (await context.addInitScript(FAKE_TONE_CAPTURE)) }),
  )
  const speechBrowser = await chromium.launch({
    args: fakeAudioArgs(wavFile('duck-voice.wav', 10, (t) => 0.3 * voiceish(t))),
  })
  const zeynep = trio.add(await personViaApi(speechBrowser, 'Zeynep'))
  for (const person of [ayse, mehmet, zeynep]) await joinVoice(person)
  for (const person of [ayse, mehmet, zeynep]) await setMuted(person, true)
  return { ayse, mehmet, zeynep, speechBrowser }
}

test('a shared screen ducks while somebody speaks, comes back after hold and release, voices untouched, off means off, hidden tab too', async ({
  browser,
  trio,
}) => {
  test.setTimeout(300_000)
  const { ayse, mehmet, zeynep, speechBrowser } = await people(browser, trio)
  // Mehmet shares his screen with its sound.
  await mehmet.page.getByTestId('btn-settings').click()
  await settingsTab(mehmet.page, 'goruntu')
  await mehmet.page.getByTestId('settings-screen-audio').check()
  await mehmet.page.getByTestId('settings-close').click()
  await mehmet.page.getByTestId('btn-screen').click()
  await expect(ayse.page.getByTestId('remote-video')).toHaveCount(1, { timeout: 20_000 })
  // Media, not elements: the screen stream Ayşe plays carries the tone.
  await expect.poll(() => shareSourcePeak(ayse.page), { timeout: 20_000 }).toBeGreaterThan(TONE_LEVEL * 0.7)
  await expect(ayse.page.getByTestId(`voice-user-${zeynep.user.id}`)).toHaveAttribute('data-speaking', 'false')
  const voices = [zeynep.user.id, mehmet.user.id]
  await expect.poll(() => ayse.page.getByTestId('remote-video').evaluate((v: HTMLVideoElement) => v.volume)).toBe(1)

  // 1. Zeynep speaks: the screen drops to 40 % within ~300 ms of her ring, holds, comes back.
  const one = await speakAndRecord(ayse, zeynep, voices)
  const first = episode(one.records, 'share', 1, DUCKED, one.unmuteAt)
  console.log(`duck (element path): ${JSON.stringify(first)}`)
  expect(first.attack).toBeLessThanOrEqual(300)
  expect(first.fromUnmute).toBeLessThan(1200)
  expect(first.maxWhileSpeaking).toBeLessThan(DUCKED + 0.03)
  expect(first.minWhileSpeaking).toBeGreaterThan(DUCKED - 0.03)
  expect(first.recovery).toBeGreaterThan(250 + RELEASE_MS * 0.6)
  expect(first.recovery).toBeLessThan(250 + RELEASE_MS + 600)
  // No jumps: a 10 ms sample never moves more than the cosine's steepest slope allows (+ timer slack).
  expect(first.maxStep).toBeLessThan(0.3)
  // Voices are never ducked.
  expect(first.voicesMin).toBe(1)

  // 2. The setting off: nothing changes while she speaks.
  await withSettings(ayse.page, async () => {
    await expect(ayse.page.getByTestId('settings-duck')).toBeChecked()
    await expect(ayse.page.getByTestId('settings-duck-music')).not.toBeChecked()
    await expect(ayse.page.getByTestId('settings-duck-self')).toBeChecked()
    await expect(ayse.page.getByTestId('settings-duck-amount-value')).toHaveText('%60')
    await ayse.page.getByTestId('settings-duck').uncheck()
  })
  const off = await speakAndRecord(ayse, zeynep, voices, 1500)
  expect(off.records.some((r) => r.speaking)).toBe(true)
  expect(Math.min(...off.records.map((r) => r.share ?? 0))).toBe(1)
  expect(await ayse.page.evaluate(() => JSON.parse(localStorage.getItem('trio.duck12') ?? 'null'))).toEqual({
    enabled: false,
    amount: 0.6,
    music: false,
    self: true,
  })
  await withSettings(ayse.page, async () => {
    await ayse.page.getByTestId('settings-duck').check()
    await ayse.page.getByTestId('settings-duck-amount').fill('80')
    await expect(ayse.page.getByTestId('settings-duck-amount-value')).toHaveText('%80')
  })

  // 3. My own speech ducks too ("Ben konuşurken de kıs", on by default), and the amount is followed.
  await setMuted(ayse, false)
  await expect.poll(() => ayse.page.getByTestId('remote-video').evaluate((v: HTMLVideoElement) => v.volume), { timeout: 5000 }).toBeCloseTo(0.2, 2)
  await withSettings(ayse.page, async () => {
    await ayse.page.getByTestId('settings-duck-self').uncheck()
  })
  await expect.poll(() => ayse.page.getByTestId('remote-video').evaluate((v: HTMLVideoElement) => v.volume), { timeout: 5000 }).toBe(1)
  await setMuted(ayse, true)
  await withSettings(ayse.page, async () => {
    await ayse.page.getByTestId('settings-duck-self').check()
    await ayse.page.getByTestId('settings-duck-amount').fill('60')
  })

  // 4. The boost path (Yayın sesi 150 %): the route's own output, measured after its gain, drops by the amount;
  //    and Zeynep's voice, boosted too, keeps exactly its slider while the screen ducks.
  await ayse.page.getByTestId(`voice-user-${mehmet.user.id}`).click({ button: 'right' })
  await ayse.page.getByTestId('volume-stream').fill('150')
  await ayse.page.keyboard.press('Escape')
  await ayse.page.getByTestId(`voice-user-${zeynep.user.id}`).click({ button: 'right' })
  await ayse.page.getByTestId('volume-voice').fill('150')
  await ayse.page.keyboard.press('Escape')
  await expect(ayse.page.getByTestId('remote-video')).toHaveAttribute('data-route', 'webaudio')
  const shareKey = `stream:${mehmet.user.id}`
  const [full] = await tapPeaks(ayse.page, [shareKey])
  await setMuted(zeynep, false)
  await expect(ayse.page.getByTestId(`voice-user-${zeynep.user.id}`)).toHaveAttribute('data-speaking', 'true')
  await ayse.page.waitForTimeout(300)
  const [duckedPeak] = await tapPeaks(ayse.page, [shareKey])
  const voice = await boostLevels(ayse.page, zeynep.user.id)
  await setMuted(zeynep, true)
  await ayse.page.waitForTimeout(HOLD_MS + RELEASE_MS + 800)
  const [after] = await tapPeaks(ayse.page, [shareKey])
  console.log(`duck (boost path): full ${full} ducked ${duckedPeak} after ${after}; voice ${JSON.stringify(voice)}`)
  expect(full!).toBeGreaterThan(TONE_LEVEL * 1.5 * 0.8)
  expect(duckedPeak! / full!).toBeGreaterThan(DUCKED - 0.06)
  expect(duckedPeak! / full!).toBeLessThan(DUCKED + 0.06)
  expect(after! / full!).toBeGreaterThan(0.95)
  expect(voice.tap).not.toBeNull()
  expect(Math.abs(voice.tap! / voice.source - 1.5) / 1.5).toBeLessThan(0.15)
  // Back to the element for the hidden-tab part (its volume is read without an analyser).
  await ayse.page.getByTestId(`voice-user-${mehmet.user.id}`).click({ button: 'right' })
  await ayse.page.getByTestId('volume-stream').fill('100')
  await ayse.page.keyboard.press('Escape')
  await expect(ayse.page.getByTestId('remote-video')).toHaveAttribute('data-route', 'element')
  await ayse.page.getByTestId(`voice-user-${zeynep.user.id}`).click({ button: 'right' })
  await ayse.page.getByTestId('volume-voice').fill('100')
  await ayse.page.keyboard.press('Escape')

  // 5. The tab hidden. Headless Chromium keeps every page "visible" whatever is done to it (measured:
  //    another tab in front, window.open, a minimised window, a tab opened over CDP — all stay
  //    `visible`), so the page is TOLD it is hidden, as the browser would tell it: `visibilityState`
  //    and `hidden` answer hidden and `visibilitychange` fires. What this proves: nothing in the duck
  //    waits for a frame or for the tab to be shown (requestAnimationFrame would). What it cannot:
  //    Chromium's own timer throttling of a hidden page (CONTRACT-V12-DUCKING §2).
  await ayse.page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  expect(await ayse.page.evaluate(() => [document.visibilityState, document.hidden])).toEqual(['hidden', true])
  const hidden = await speakAndRecord(ayse, zeynep, voices)
  expect(hidden.records.every((r) => r.hidden)).toBe(true)
  const third = episode(hidden.records, 'share', 1, DUCKED, hidden.unmuteAt)
  const state = await duckState(ayse.page)
  const gaps = hidden.records.slice(1).map((r, i) => r.t - hidden.records[i].t)
  console.log(`duck (hidden tab): ${JSON.stringify(third)} ticks ${JSON.stringify(state)} recorder max gap ${Math.max(...gaps)} ms`)
  expect(state!.hiddenTicks).toBeGreaterThan(20)
  expect(state!.hiddenMaxGapMs).toBeLessThan(100)
  expect(third.attack).toBeLessThanOrEqual(350)
  expect(third.maxWhileSpeaking).toBeLessThan(DUCKED + 0.03)
  expect(third.recovery).toBeLessThan(250 + RELEASE_MS + 800)
  expect(third.voicesMin).toBe(1)
  expect(state!.speech).toBe(false)
  expect(state!.share).toBe(1)
  await speechBrowser.close()
})

test('shared music ducks only with "Paylaşılan müziği de kıs", from its own music volume', async ({ browser, trio }) => {
  test.setTimeout(240_000)
  const { ayse, mehmet, zeynep, speechBrowser } = await people(browser, trio)
  await mehmet.page.getByTestId('btn-music').click()
  await expect(mehmet.page.getByTestId('btn-music')).toHaveAttribute('aria-pressed', 'true')
  await expect(ayse.page.getByTestId(`remote-music-${mehmet.user.id}`)).toHaveCount(1, { timeout: 20_000 })
  const music = ayse.page.getByTestId(`remote-music-${mehmet.user.id}`)
  // Music starts at its own default, 50 %.
  await expect.poll(() => music.evaluate((m: HTMLAudioElement) => m.volume)).toBe(0.5)
  const voices = [zeynep.user.id]

  // Default: music is not ducked.
  const plain = await speakAndRecord(ayse, zeynep, voices, 1500)
  expect(plain.records.some((r) => r.speaking)).toBe(true)
  expect(Math.min(...plain.records.map((r) => r.music ?? 0))).toBe(0.5)

  await withSettings(ayse.page, async () => {
    await ayse.page.getByTestId('settings-duck-music').check()
  })
  const ducked = await speakAndRecord(ayse, zeynep, voices)
  const result = episode(ducked.records, 'music', 0.5, 0.5 * DUCKED, ducked.unmuteAt)
  console.log(`duck (music): ${JSON.stringify(result)}`)
  expect(result.attack).toBeLessThanOrEqual(300)
  expect(result.maxWhileSpeaking).toBeLessThan(0.5 * DUCKED + 0.02)
  expect(result.minWhileSpeaking).toBeGreaterThan(0.5 * DUCKED - 0.02)
  expect(result.recovery).toBeLessThan(250 + RELEASE_MS + 600)
  expect(result.voicesMin).toBe(1)
  // data-volume is still the music volume the person chose.
  await expect(music).toHaveAttribute('data-volume', '0.5')
  await speechBrowser.close()
})
