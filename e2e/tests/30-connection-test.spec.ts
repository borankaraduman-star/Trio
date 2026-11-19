/**
 * CONTRACT-V4 A3: Ayarlar › Bağlantı testi, and the TURN hint in the voice
 * panel. There is no TURN server on this machine: the two paths that can be
 * shown here are "yapılandırılmamış" (the e2e server lists no ICE servers)
 * and "yok veya ulaşılamıyor" (a TURN entry in /api/ice that answers
 * nothing). "TURN çalışıyor" needs a real TURN server and is NOT verified.
 */
import type { Page } from '@playwright/test'
import { freshServer } from '../lib/server'
import { expect, joinVoice, test, threePeople, type Person } from '../lib/trio'
import { settingsTab } from '../lib/v7phone'

async function openTest(page: Page) {
  await page.getByTestId('btn-settings').click()
  await settingsTab(page, 'ses')
  const section = page.getByTestId('conn-test')
  await section.scrollIntoViewIfNeeded()
  return section
}

async function copiedReport(person: Person): Promise<string> {
  await person.page.getByTestId('conn-report').click()
  const box = person.page.getByTestId('conn-report-text')
  await expect(box).toBeVisible()
  return box.inputValue()
}

test('A3: no TURN configured — the test says so, and the voice panel carries the quiet hint', async ({ browser, trio }) => {
  test.setTimeout(150_000)
  await freshServer()
  const people = await threePeople(browser, trio, { deviceScaleFactor: 2 })
  const [ayse, mehmet, zeynep] = people
  for (const person of people) await joinVoice(person)
  for (const person of people) {
    await expect(person.page.getByTestId('turn-hint')).toHaveText('TURN ayarlı değil: bazı ağlarda ses bağlanmayabilir')
  }

  const section = await openTest(ayse.page)
  await expect(section.getByTestId('conn-turn')).toHaveAttribute('data-state', 'unconfigured')
  await expect(section.getByTestId('conn-turn')).toHaveText('TURN yapılandırılmamış')
  // Per peer, while in voice: the path (all on this machine: direct) and a round trip.
  for (const other of [mehmet, zeynep]) {
    const peerRow = section.getByTestId(`conn-peer-${other.user.id}`)
    await expect(peerRow).toHaveAttribute('data-path', 'direct')
    await expect(peerRow).toContainText(other.name)
    await expect(peerRow).toContainText('doğrudan')
    await expect(peerRow.locator('td').nth(2)).toHaveText(/^\d+ ms$/)
  }
  // The microphone meter moves with the fake microphone's beep. The beep is 20 ms every
  // 500 ms and the meter shows the current frame, so polling `data-level` samples it at
  // the poll's rhythm and can miss every beep; the loudest the meter showed is `data-peak`.
  await section.getByTestId('conn-mic-start').click()
  await expect.poll(async () => Number(await section.getByTestId('conn-mic-level').getAttribute('data-peak'))).toBeGreaterThan(0.01)
  await section.getByTestId('conn-loopback').check()
  await expect(section.getByTestId('conn-loopback')).toBeChecked()

  const report = await copiedReport(ayse)
  expect(report).toContain('Trio bağlantı raporu')
  expect(report).toContain('TURN: TURN yapılandırılmamış')
  expect(report).toContain('- Mehmet: doğrudan')
  expect(report).toContain('- Zeynep: doğrudan')
  // No token, no address, no ids, no other names.
  for (const person of people) expect(report).not.toContain(person.token)
  expect(report).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/)
  expect(report).not.toMatch(/\.local\b/)
  expect(report).not.toContain('Ayşe')
  expect(report).not.toMatch(/[A-Za-z0-9_-]{24,}/)
  await ayse.page.screenshot({ path: 'screenshots/v4-connection-test.png', fullPage: true })
})

test('A3: a TURN entry that answers nothing — "yok veya ulaşılamıyor", no hint', async ({ browser, trio }) => {
  test.setTimeout(120_000)
  // An ICE list with a TURN server on a port nothing listens on.
  await freshServer({ TRIO_TURN_HOST: '127.0.0.1', TRIO_TURN_SECRET: 'e2e-not-a-real-turn-secret' })
  const people = await threePeople(browser, trio)
  const [ayse, mehmet, zeynep] = people
  await joinVoice(ayse)
  await joinVoice(mehmet)
  await expect(ayse.page.locator('.voice-status strong')).toHaveText('Ses bağlı')
  await expect(ayse.page.getByTestId('turn-hint')).toHaveCount(0)
  const section = await openTest(ayse.page)
  await expect(section.getByTestId('conn-turn')).toHaveAttribute('data-state', 'unreachable', { timeout: 15_000 })
  await expect(section.getByTestId('conn-turn')).toHaveText('TURN yok veya ulaşılamıyor')
  // The result stays while the rest of the app re-renders (somebody joins the room): the
  // probe ran once, it does not go back to "deneniyor…" on every update of the session.
  await section.getByTestId('conn-turn').evaluate((element) => {
    const seen: string[] = []
    ;(window as unknown as { __turnStates: string[] }).__turnStates = seen
    new MutationObserver(() => seen.push(element.getAttribute('data-state') ?? '')).observe(element, { attributes: true })
  })
  await joinVoice(zeynep)
  await expect(section.getByTestId('conn-peer-' + zeynep.user.id)).toBeVisible()
  expect(await ayse.page.evaluate(() => (window as unknown as { __turnStates: string[] }).__turnStates)).toEqual([])
  const report = await copiedReport(ayse)
  expect(report).toContain('TURN: TURN yok veya ulaşılamıyor')
  expect(report).not.toContain('127.0.0.1')
  expect(report).not.toContain('e2e-not-a-real-turn-secret')
  // Retry runs it again.
  await section.getByTestId('conn-turn-retry').click()
  await expect(section.getByTestId('conn-turn')).toHaveAttribute('data-state', 'unreachable', { timeout: 15_000 })
})

test('A3 at 390 px: the connection test fits the phone', async ({ browser, trio }) => {
  await freshServer()
  const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
  const [ayse, mehmet] = await threePeople(browser, trio, phone)
  await ayse.page.getByTestId('btn-drawer').click()
  await joinVoice(ayse)
  await mehmet.page.getByTestId('btn-drawer').click()
  await joinVoice(mehmet)
  if (!(await ayse.page.getByTestId('btn-settings').isVisible())) await ayse.page.getByTestId('btn-drawer').click()
  const section = await openTest(ayse.page)
  await expect(section.getByTestId(`conn-peer-${mehmet.user.id}`)).toBeVisible()
  const widths = await ayse.page.evaluate(() => ({
    page: document.documentElement.scrollWidth,
    dialog: document.querySelector('[data-testid="settings-dialog"]')!.scrollWidth,
    client: document.querySelector('[data-testid="settings-dialog"]')!.clientWidth,
  }))
  expect(widths.page).toBeLessThanOrEqual(390)
  expect(widths.dialog).toBeLessThanOrEqual(widths.client)
  await section.screenshot({ path: 'screenshots/v4-connection-test-390.png' })
})
