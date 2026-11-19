/**
 * CONTRACT-V4 A4: calling friends into voice, and the cue sounds.
 *
 * Sounds are asserted on the WebAudio graph, not by listening: the page's
 * cue module announces each cue it schedules (`trio-cue`), and every
 * OscillatorNode started is counted (lib/voiceProbe.ts CUE_PROBE).
 * Notifications are recorded by a stand-in `Notification` (granted).
 */
import type { BrowserContext, Page } from '@playwright/test'
import { freshServer } from '../lib/server'
import { expect, expectConnected, joinVoice, personViaApi, SOHBET, test, type Person } from '../lib/trio'
import { CUE_PROBE, cuesPlayed, oscillatorsStarted } from '../lib/voiceProbe'

test.beforeEach(async () => {
  await freshServer()
})

const NOTIFICATION_PROBE = `
(() => {
  window.__trioNotes = []
  class Recorded {
    static permission = 'granted'
    static requestPermission() { return Promise.resolve('granted') }
    constructor(title, options) { window.__trioNotes.push({ title, body: options?.body ?? '', silent: !!options?.silent }) }
    close() {}
  }
  window.Notification = Recorded
  // "Not looking at the page" on demand (lib/viewing.ts asks hasFocus()).
  const hasFocus = document.hasFocus.bind(document)
  document.hasFocus = () => (window.__trioAway ? false : hasFocus())
})()
`

async function prepare(context: BrowserContext): Promise<void> {
  await context.addInitScript(CUE_PROBE)
  await context.addInitScript(NOTIFICATION_PROBE)
}

async function away(page: Page, isAway: boolean): Promise<void> {
  await page.evaluate((value) => {
    ;(window as unknown as { __trioAway: boolean }).__trioAway = value
    window.dispatchEvent(new Event(value ? 'blur' : 'focus'))
  }, isAway)
}

async function notes(page: Page): Promise<{ title: string; body: string; silent: boolean }[]> {
  return page.evaluate(() => (window as unknown as { __trioNotes: { title: string; body: string; silent: boolean }[] }).__trioNotes)
}

async function setting(person: Person, testId: string, checked: boolean): Promise<void> {
  await person.page.getByTestId('btn-settings').click()
  const box = person.page.getByTestId(testId)
  if (checked) await box.check()
  else await box.uncheck()
  await person.page.getByTestId('settings-close').click()
}

const band = (person: Person) => person.page.getByTestId('ring-band')

test('A4: ringing friends into voice — band, ringtone, notification, Katıl, "rahatsız etme", the limit', async ({ browser, trio }) => {
  test.setTimeout(180_000)
  const ayse = trio.add(await personViaApi(browser, 'Ayşe', { prepare }))
  const mehmet = trio.add(await personViaApi(browser, 'Mehmet', { prepare }))
  const zeynep = trio.add(await personViaApi(browser, 'Zeynep', { prepare }))
  await setting(mehmet, 'settings-dnd', true)
  await away(zeynep.page, true)
  await away(mehmet.page, true)

  // Ayşe opens the empty room: those not looking get "Ayşe ses odasına girdi".
  await joinVoice(ayse)
  await expect.poll(() => notes(zeynep.page)).toContainEqual({ title: 'Ayşe ses odasına girdi', body: 'Sohbet', silent: false })
  // With "rahatsız etme" it comes without sound.
  await expect.poll(() => notes(mehmet.page)).toContainEqual({ title: 'Ayşe ses odasına girdi', body: 'Sohbet', silent: true })

  // Çağır.
  const ring = ayse.page.getByTestId('btn-ring')
  await expect(ring).toHaveText('Çağır')
  await ring.click()
  await expect(ring).toBeDisabled()
  await expect(ring).toHaveText(/Çağrıldı · (30|29) sn/)
  for (const person of [zeynep, mehmet]) {
    await expect(band(person)).toContainText('Ayşe seni Sohbet odasına çağırıyor')
    await expect(band(person)).toHaveAttribute('data-from', String(ayse.user.id))
  }
  // Zeynep: the ringtone is scheduled, and a notification (she is not looking).
  await expect.poll(() => cuesPlayed(zeynep.page)).toContain('ring')
  expect(await oscillatorsStarted(zeynep.page)).toBeGreaterThan(0)
  await expect.poll(() => notes(zeynep.page)).toContainEqual({
    title: 'Trio — sesli çağrı',
    body: 'Ayşe seni Sohbet odasına çağırıyor',
    silent: false,
  })
  // Mehmet ("rahatsız etme"): the band only — no ringtone, no notification.
  await expect(band(mehmet)).toHaveAttribute('data-silent', 'true')
  expect(await cuesPlayed(mehmet.page)).not.toContain('ring')
  expect(await oscillatorsStarted(mehmet.page)).toBe(0)
  expect((await notes(mehmet.page)).map((n) => n.title)).not.toContain('Trio — sesli çağrı')
  // Ayşe does not ring herself.
  await expect(band(ayse)).toHaveCount(0)

  // Katıl: Zeynep is in the room, the band and the ringtone stop.
  await band(zeynep).getByTestId('ring-join').click()
  await expect(zeynep.page.locator('.voice-status strong')).toHaveText('Ses bağlı')
  await expect(band(zeynep)).toHaveCount(0)
  await expect.poll(() => cuesPlayed(zeynep.page)).toContain('ring-stop')
  // Ayşe heard her come in.
  await expect.poll(() => cuesPlayed(ayse.page)).toContain('join')

  // The ringer leaves the room: Mehmet's band goes.
  await expect(band(mehmet)).toBeVisible()
  await ayse.page.getByTestId('btn-hangup').click()
  await expect(band(mehmet)).toHaveCount(0)
  await expect.poll(() => cuesPlayed(zeynep.page)).toContain('leave')

  // The server's limit: a reloaded page forgot its cooldown; the server did not.
  await ayse.page.reload()
  await expectConnected(ayse.page)
  await joinVoice(ayse)
  await ayse.page.getByTestId('btn-ring').click()
  await expect(ayse.page.getByTestId('ring-error')).toHaveText('Az önce çağırdın; 30 saniyede bir çağırabilirsin.')
  await expect(band(mehmet)).toHaveCount(0)

  // Not delivered to somebody already in the room: Zeynep rings, Mehmet gets it, Ayşe does not.
  await zeynep.page.getByTestId('btn-ring').click()
  await expect(band(mehmet)).toContainText('Zeynep seni Sohbet odasına çağırıyor')
  await expect(band(ayse)).toHaveCount(0)
  await band(mehmet).getByTestId('ring-dismiss').click()
  await expect(band(mehmet)).toHaveCount(0)
})

test('A4: cue sounds for my own mute and deafen, the master switch, nothing while deafened but my own click', async ({ browser, trio }) => {
  test.setTimeout(150_000)
  const ayse = trio.add(await personViaApi(browser, 'Ayşe', { prepare }))
  const mehmet = trio.add(await personViaApi(browser, 'Mehmet', { prepare }))
  await joinVoice(ayse)
  await joinVoice(mehmet)
  await expect.poll(() => cuesPlayed(ayse.page)).toEqual(['join'])
  // Nothing for my own join.
  expect(await cuesPlayed(mehmet.page)).toEqual([])

  await ayse.page.getByTestId('btn-mute').click()
  await ayse.page.getByTestId('btn-mute').click()
  await expect.poll(() => cuesPlayed(ayse.page)).toEqual(['join', 'mute', 'unmute'])
  await ayse.page.getByTestId('btn-deafen').click()
  await expect.poll(() => cuesPlayed(ayse.page)).toEqual(['join', 'mute', 'unmute', 'deafen'])
  // Deafened: Mehmet leaving and coming back is not cued...
  await mehmet.page.getByTestId('btn-hangup').click()
  await expect(ayse.page.getByTestId(`voice-user-${mehmet.user.id}`)).toHaveCount(0)
  await joinVoice(mehmet)
  await expect(ayse.page.getByTestId(`voice-user-${mehmet.user.id}`)).toBeVisible()
  // ...but my own undeafen click is.
  await ayse.page.getByTestId('btn-deafen').click()
  await expect.poll(() => cuesPlayed(ayse.page)).toEqual(['join', 'mute', 'unmute', 'deafen', 'undeafen'])
  const tones = await oscillatorsStarted(ayse.page)
  expect(tones).toBeGreaterThanOrEqual(10)

  // "Uyarı sesleri" off: a mute is silent.
  await setting(ayse, 'settings-cues', false)
  await ayse.page.getByTestId('btn-mute').click()
  await expect(ayse.page.getByTestId('btn-mute')).toHaveAttribute('aria-pressed', 'true')
  await mehmet.page.getByTestId('btn-hangup').click()
  await expect(ayse.page.getByTestId(`voice-user-${mehmet.user.id}`)).toHaveCount(0)
  expect(await cuesPlayed(ayse.page)).toEqual(['join', 'mute', 'unmute', 'deafen', 'undeafen'])
  expect(await oscillatorsStarted(ayse.page)).toBe(tones)
  void SOHBET
})

test('A4 at 390 px: the ring band and the Çağır button fit', async ({ browser, trio }) => {
  const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, prepare }
  const ayse = trio.add(await personViaApi(browser, 'Ayşe', phone))
  const zeynep = trio.add(await personViaApi(browser, 'Zeynep', phone))
  const mehmet = trio.add(await personViaApi(browser, 'Mehmet', { deviceScaleFactor: 2, prepare }))
  await ayse.page.getByTestId('btn-drawer').click()
  await joinVoice(ayse)
  await expect(ayse.page.getByTestId('btn-ring')).toBeVisible()
  await ayse.page.screenshot({ path: 'screenshots/v4-ring-button-390.png' })
  await ayse.page.getByTestId('btn-ring').click()
  await expect(band(zeynep)).toBeVisible()
  await expect(band(mehmet)).toBeVisible()
  await mehmet.page.screenshot({ path: 'screenshots/v4-ring-band.png' })
  await expect(ayse.page.getByTestId('btn-ring')).toBeDisabled()
  await ayse.page.screenshot({ path: 'screenshots/v4-ring-cooldown-390.png' })
  const box = await band(zeynep).boundingBox()
  expect(box).not.toBeNull()
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(390)
  for (const id of ['ring-join', 'ring-dismiss']) {
    const button = await band(zeynep).getByTestId(id).boundingBox()
    expect(button!.height).toBeGreaterThanOrEqual(32)
    expect(button!.x + button!.width).toBeLessThanOrEqual(390)
  }
  await zeynep.page.screenshot({ path: 'screenshots/v4-ring-band-390.png' })
})
