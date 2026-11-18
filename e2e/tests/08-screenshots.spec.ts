/**
 * The screenshots of the release notes, taken through the real UI with real
 * media. Each one also asserts what it is meant to show.
 */
import path from 'node:path'
import type { Page } from '@playwright/test'
import { sql } from '../lib/db'
import { E2E_DIR, freshServer } from '../lib/server'
import { expect, expectConnected, expectScreensDecoding, joinVoice, newContext, personViaApi, test, threePeople, type Person } from '../lib/trio'

const OUT = path.join(E2E_DIR, 'screenshots')
const DESKTOP = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 }

test.beforeEach(async () => {
  await freshServer()
})

async function send(person: Person, text: string): Promise<void> {
  await person.page.getByTestId('composer').fill(text)
  await person.page.getByTestId('composer').press('Enter')
  await expect(person.page.getByTestId('message').last()).toHaveAttribute('data-status', 'sent')
}

const MINUTE = 60_000

/**
 * When each line was "said": the first part yesterday evening (Istanbul
 * time, the users' zone, UTC+3 with no DST), the rest in the last few
 * minutes, so that there is exactly one day separator whenever this runs.
 */
function conversationTimes(): string[] {
  const now = Date.now()
  const istanbul = new Date(now + 3 * 3600_000)
  const todayStart = Date.UTC(istanbul.getUTCFullYear(), istanbul.getUTCMonth(), istanbul.getUTCDate()) - 3 * 3600_000
  const yesterday = (hour: number, minute: number) => todayStart - 24 * 3600_000 + (hour * 60 + minute) * MINUTE
  const recent = (minutesAgo: number) => Math.max(now - minutesAgo * MINUTE, todayStart + (7 - minutesAgo) * 1000)
  const times = [
    yesterday(21, 4),
    yesterday(21, 6),
    yesterday(21, 6),
    yesterday(21, 12),
    yesterday(21, 13),
    recent(6),
    recent(3),
    recent(2),
    recent(2),
    recent(1),
  ]
  return times.map((time) => new Date(time).toISOString())
}

const CONVERSATION: [number, string][] = [
  [0, 'Cumartesi akşamı kim boş? Bizde oyun gecesi yapalım 🎲'],
  [1, 'Ben varım!'],
  [1, 'Pizza da söyleriz, geçen seferki yer çok iyiydi'],
  [2, 'Ben de gelirim ama 9’dan önce çıkamam işten'],
  [0, 'Tamam o zaman 9.30 gibi başlarız'],
  [0, 'Bu arada yeni oyunu buldum, şuna bir bakın: https://boardgamegeek.com/boardgame/266192/wingspan'],
  [2, 'Ooo kuşlu oyun mu bu? Çok güzel görünüyor'],
  [1, 'Kurallar biraz uzun ama bir kere öğrenince akıyor'],
  [1, 'Akşam sesli kanalda kısaca anlatırım, ekranımı da paylaşırım'],
  [0, 'Süper, görüşürüz 👋'],
]
/** Rows that start a new author group (the others continue one). */
const GROUP_HEADERS = 8

async function seedConversation(people: Person[]): Promise<void> {
  for (const [who, text] of CONVERSATION) await send(people[who], text)
  // Give the messages the times of a real conversation (yesterday evening,
  // this morning): the server stamps "now", which only a direct write can change.
  conversationTimes().forEach((time, index) => {
    sql('UPDATE messages SET created_at = ? WHERE id = ?', [time, index + 1])
  })
  for (const person of people) {
    await person.page.reload()
    await expectConnected(person.page)
  }
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(OUT, name), animations: 'disabled', caret: 'hide' })
}

test('screenshot 01: the join screen', async ({ browser }) => {
  const context = await newContext(browser, DESKTOP)
  const page = await context.newPage()
  await page.goto('/')
  await page.getByTestId('join-name').fill('Ayşe')
  await expect(page.getByTestId('join-submit')).toBeDisabled()
  await shot(page, '01-join.png')
  await context.close()
})

test('screenshots 02-04: chat, voice room, screen share', async ({ browser, trio }) => {
  test.setTimeout(150_000)
  const people = await threePeople(browser, trio, DESKTOP)
  const [ayse, mehmet, zeynep] = people
  await seedConversation(people)

  const page = ayse.page
  await expect(page.getByTestId('message')).toHaveCount(CONVERSATION.length)
  await expect(page.locator('.day-separator')).toHaveText(['Dün', 'Bugün'])
  await expect(page.locator('.message.with-header')).toHaveCount(GROUP_HEADERS)
  await mehmet.page.getByTestId('composer').pressSequentially('Pizza', { delay: 30 })
  await expect(page.getByTestId('typing')).toHaveText('Mehmet yazıyor…')
  await shot(page, '02-chat.png')

  // The voice room: all three in, Zeynep muted, someone speaking.
  for (const person of people) await joinVoice(person)
  await zeynep.page.getByTestId('btn-mute').click()
  await expect(page.locator('[data-testid^="voice-user-"]')).toHaveCount(3)
  await expect(page.getByTestId(`voice-user-${zeynep.user.id}`)).toHaveAttribute('data-muted', 'true')
  // The fake microphone beeps about once a second; catch a beep for the ring.
  await expect(page.locator('[data-testid^="voice-user-"][data-speaking="true"]').first()).toBeVisible({ timeout: 15_000 })
  await shot(page, '03-voice.png')

  // Mehmet shares his screen; Ayşe sees it above the chat.
  await mehmet.page.getByTestId('btn-screen').click()
  await expectScreensDecoding(page, 1)
  await expect(page.getByTestId(`voice-user-${mehmet.user.id}`)).toHaveAttribute('data-screensharing', 'true')
  await shot(page, '04-screenshare.png')
})

test('screenshot 05: phone width with the drawer open', async ({ browser, trio }) => {
  const people = await threePeople(browser, trio)
  await seedConversation(people)
  for (const person of people.slice(0, 2)) await joinVoice(person)
  const phone = trio.add(
    await personViaApi(browser, 'Deniz', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }),
  )
  await phone.page.getByTestId('btn-drawer').tap()
  await expect(phone.page.locator('nav.sidebar')).toBeInViewport({ ratio: 0.99 })
  await joinVoice(phone)
  await phone.page.getByTestId('btn-mute').tap()
  await expect(phone.page.locator('[data-testid^="voice-user-"]')).toHaveCount(3)
  await expect(phone.page.getByTestId(`voice-user-${phone.user.id}`)).toHaveAttribute('data-muted', 'true')
  await expect(phone.page.locator('nav.sidebar')).toBeInViewport({ ratio: 0.99 })
  await shot(phone.page, '05-mobile.png')
})
