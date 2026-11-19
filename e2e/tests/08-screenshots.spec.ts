/**
 * The screenshots of the release notes, taken through the real UI with real
 * media. Each one also asserts what it is meant to show.
 */
import path from 'node:path'
import type { Page } from '@playwright/test'
import { sql } from '../lib/db'
import { E2E_DIR, freshServer } from '../lib/server'
import { expectTileDecoding } from '../lib/media'
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

/** A photo-like picture for the attachment shot: drawn in the page, a real PNG. */
async function drawPhoto(page: Page): Promise<Buffer> {
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 800
    canvas.height = 533
    const g = canvas.getContext('2d')!
    const sky = g.createLinearGradient(0, 0, 0, 533)
    sky.addColorStop(0, '#f6b36b')
    sky.addColorStop(0.55, '#f4d6a0')
    sky.addColorStop(1, '#c98b5a')
    g.fillStyle = sky
    g.fillRect(0, 0, 800, 533)
    // Balloons over the valley.
    const balloons: [number, number, number, string][] = [
      [180, 150, 46, '#e4572e'],
      [420, 110, 58, '#2a9d8f'],
      [620, 190, 38, '#e9c46a'],
      [300, 250, 28, '#6a4c93'],
    ]
    for (const [x, y, r, color] of balloons) {
      g.fillStyle = color
      g.beginPath()
      g.ellipse(x, y, r, r * 1.15, 0, 0, Math.PI * 2)
      g.fill()
      g.fillStyle = '#5b3a29'
      g.fillRect(x - r * 0.18, y + r * 1.3, r * 0.36, r * 0.3)
    }
    g.fillStyle = '#8c5a3c'
    g.beginPath()
    g.moveTo(0, 533)
    for (let x = 0; x <= 800; x += 40) g.lineTo(x, 420 + 40 * Math.sin(x / 70) + (x % 120 === 0 ? -30 : 0))
    g.lineTo(800, 533)
    g.fill()
    return canvas.toDataURL('image/png').split(',')[1]
  })
  return Buffer.from(base64, 'base64')
}

test('screenshot 06: an image and a file in the conversation', async ({ browser, trio }) => {
  const people = await threePeople(browser, trio, DESKTOP)
  const [ayse, mehmet] = people
  await seedConversation(people)
  const photo = await drawPhoto(mehmet.page)
  await mehmet.page.getByTestId('file-input').setInputFiles([
    { name: 'kapadokya-balonlar.png', mimeType: 'image/png', buffer: photo },
    { name: 'oyun-kurallari.pdf', mimeType: 'application/pdf', buffer: Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(184_000, 32)]) },
  ])
  await expect(mehmet.page.locator('[data-testid="pending-attachment"][data-status="done"]')).toHaveCount(2)
  await send(mehmet, 'Geçen haftadan bir kare, bir de kuralların özeti 📎')
  await send(ayse, 'Harika görünüyor, akşam bakarım!')

  const page = ayse.page
  const image = page.getByTestId('attachment-image')
  await expect.poll(() => image.locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(800)
  await expect(page.getByTestId('attachment-file')).toContainText('oyun-kurallari.pdf')
  // A chip of her own reply-in-progress, above the composer.
  await page.getByTestId('file-input').setInputFiles({ name: 'pizza-menusu.jpg', mimeType: 'image/jpeg', buffer: await jpeg(page) })
  await expect(page.locator('[data-testid="pending-attachment"][data-status="done"]')).toHaveCount(1)
  await page.getByTestId('message-list').evaluate((el) => (el.scrollTop = el.scrollHeight))
  await shot(page, '06-attachments.png')
})

async function jpeg(page: Page): Promise<Buffer> {
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 320
    canvas.height = 240
    const g = canvas.getContext('2d')!
    g.fillStyle = '#d62828'
    g.fillRect(0, 0, 320, 240)
    g.fillStyle = '#fcbf49'
    g.beginPath()
    g.arc(160, 120, 90, 0, Math.PI * 2)
    g.fill()
    return canvas.toDataURL('image/jpeg', 0.9).split(',')[1]
  })
  return Buffer.from(base64, 'base64')
}

test('screenshot 07: two cameras and a shared screen', async ({ browser, trio }) => {
  test.setTimeout(150_000)
  const people = await threePeople(browser, trio, DESKTOP)
  const [ayse, mehmet, zeynep] = people
  await seedConversation(people)
  for (const person of people) await joinVoice(person)
  await ayse.page.getByTestId('btn-camera').click()
  await mehmet.page.getByTestId('btn-camera').click()
  await mehmet.page.getByTestId('btn-screen').click()
  const page = zeynep.page
  await expectTileDecoding(page, `remote-camera-${ayse.user.id}`, 'camera', 'Ayşe')
  await expectTileDecoding(page, `remote-camera-${mehmet.user.id}`, 'camera', 'Mehmet')
  await expectTileDecoding(page, 'remote-video', 'screen', 'Mehmet · ekran')
  await expect(page.locator('[data-testid="stage"] figure')).toHaveCount(3)
  await shot(page, '07-cameras.png')
})

test('screenshot 08: the settings dialog', async ({ browser, trio }) => {
  const people = await threePeople(browser, trio, DESKTOP)
  await seedConversation(people)
  const [ayse, mehmet] = people
  await joinVoice(ayse)
  await joinVoice(mehmet)
  const page = ayse.page
  await page.getByTestId('btn-settings').click()
  await expect(page.getByTestId('settings-dialog')).toBeVisible()
  await expect(page.getByTestId('settings-noise-state')).toHaveAttribute('data-state', 'active')
  await page.getByTestId('settings-mode-ptt').check()
  await expect(page.getByTestId('settings-ptt-key')).toHaveText('` (Backquote)')
  await page.getByTestId('settings-mic').selectOption({ label: 'Fake Audio Input 1' })
  await page.getByTestId('settings-mic').blur()
  await shot(page, '08-settings.png')
})

test('screenshot 09: adding a device, the code in Ayarlar › Hesap', async ({ browser, trio }) => {
  const people = await threePeople(browser, trio, DESKTOP)
  await seedConversation(people)
  const page = people[0].page
  await page.getByTestId('btn-settings').click()
  const account = page.getByTestId('settings-account')
  await account.getByTestId('settings-add-device').click()
  await expect(account.getByTestId('link-code')).toHaveText(/^\w{5}-\w{5}$/)
  await expect(account.getByTestId('link-code-countdown')).toHaveText(/^(10:00|9:5\d)$/)
  // Ayarlar › Hesap is taller since v4 (picture and name above "Cihaz ekle"): bring the
  // card itself to the middle of the dialog's scroller, whatever is above or below it.
  const card = account.getByTestId('link-code-card')
  await card.evaluate((el) => el.scrollIntoView({ block: 'center' }))
  await expect(card).toBeInViewport({ ratio: 1 })
  // In the dialog's visible box too (the page viewport alone does not see the dialog's clip).
  expect(
    await card.evaluate((el) => {
      let box = el.parentElement
      while (box && getComputedStyle(box).overflowY !== 'auto' && getComputedStyle(box).overflowY !== 'scroll') box = box.parentElement
      const clip = (box ?? document.documentElement).getBoundingClientRect()
      const rect = el.getBoundingClientRect()
      return rect.top >= clip.top && rect.bottom <= clip.bottom
    }),
  ).toBe(true)
  await shot(page, '09-add-device.png')
})

test('screenshot 10: the join screen, "Zaten hesabım var"', async ({ browser }) => {
  const context = await newContext(browser, DESKTOP)
  const page = await context.newPage()
  await page.goto('/')
  await page.getByTestId('join-mode-link').click()
  await page.getByTestId('join-link-code').pressSequentially('k7qx3mz9pa')
  await expect(page.getByTestId('join-link-code')).toHaveValue('K7QX3-MZ9PA')
  await expect(page.getByTestId('join-submit')).toBeEnabled()
  await shot(page, '10-join-with-code.png')
  await context.close()
})
