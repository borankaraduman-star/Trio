/**
 * CONTRACT-V3 §4: one upload in flight per user, quotas and a full disk, and
 * the content types decided by ISO-BMFF brand (avif inline; heic and
 * quicktime as file rows).
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import type { Page, Route } from '@playwright/test'
import { E2E_DIR, freshServer, readState } from '../lib/server'
import { expect, sendThroughUi, test, threePeople, type Person } from '../lib/trio'

const AVIF = fs.readFileSync(path.join(E2E_DIR, 'fixtures', 'kapadokya.avif'))

/** An ISO-BMFF file of the given major brand, padded: the server types it by the brand alone. */
function bmff(brand: string, compatible: string[], size = 4096): Buffer {
  const brands = [brand, '\0\0\0\0', ...compatible].join('')
  const box = Buffer.alloc(8 + brands.length)
  box.writeUInt32BE(box.length, 0)
  box.write('ftyp', 4, 'latin1')
  box.write(brands, 8, 'latin1')
  return Buffer.concat([box, Buffer.alloc(size, 7)])
}

function chips(page: Page) {
  return page.getByTestId('pending-attachment')
}

async function statuses(page: Page): Promise<string[]> {
  return chips(page).evaluateAll((items) => items.map((item) => item.getAttribute('data-status') ?? ''))
}

test.beforeEach(async () => {
  await freshServer()
})

test('several files in one message go up one after another; a queued one can be cancelled', async ({ browser, trio }) => {
  const [ayse, mehmet] = await threePeople(browser, trio)
  const page = ayse.page

  // Hold every upload at the door, counting how many are in flight at once.
  let inFlight = 0
  let most = 0
  const requests: string[] = []
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  await page.route('**/api/uploads', async (route: Route) => {
    inFlight += 1
    most = Math.max(most, inFlight)
    requests.push(route.request().postDataBuffer()?.includes(Buffer.from('filename="')) ? 'upload' : '?')
    await gate
    const response = await route.fetch()
    inFlight -= 1
    await route.fulfill({ response })
  })

  await page.getByTestId('file-input').setInputFiles([
    { name: 'kapadokya.avif', mimeType: 'image/avif', buffer: AVIF },
    { name: 'IMG_2041.HEIC', mimeType: 'image/heic', buffer: bmff('heic', ['mif1', 'heic']) },
    { name: 'gereksiz.txt', mimeType: 'text/plain', buffer: Buffer.from('silinecek\n') },
    { name: 'balon.mov', mimeType: 'video/quicktime', buffer: bmff('qt  ', ['qt  ']) },
  ])
  await expect(chips(page)).toHaveCount(4)
  // One is being sent, the rest wait their turn — and say so.
  await expect.poll(() => statuses(page)).toEqual(['uploading', 'queued', 'queued', 'queued'])
  await expect(chips(page).nth(1)).toContainText('Sırada bekliyor…')
  await expect(page.getByTestId('composer-send')).toBeDisabled()
  expect(requests).toHaveLength(1)

  // The third is cancelled while it waits: it is never sent.
  await chips(page).nth(2).getByTestId('pending-remove').click()
  await expect(chips(page)).toHaveCount(3)

  release()
  await expect(page.locator('[data-testid="pending-attachment"][data-status="done"]')).toHaveCount(3)
  expect(most).toBe(1)
  expect(requests).toHaveLength(3)

  await sendThroughUi(ayse, 'Geziden üç dosya')
  const message = mehmet.page.getByTestId('message').filter({ hasText: 'Geziden üç dosya' })
  // avif is an image, shown inline and really decoded.
  const image = message.getByTestId('attachment-image').locator('img')
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(320)
  // heic and quicktime are file rows (served as attachment, never a player or an image).
  await expect(message.getByTestId('attachment-file')).toHaveCount(2)
  await expect(message.getByTestId('attachment-file').nth(0)).toContainText('IMG_2041.HEIC')
  await expect(message.getByTestId('attachment-file').nth(1)).toContainText('balon.mov')
  await expect(message.locator('video, audio')).toHaveCount(0)
  await expect(message).not.toContainText('gereksiz.txt')
  const served = await mehmet.page.request.get(
    (await message.getByTestId('attachment-file').nth(0).locator('a').first().getAttribute('href'))!,
  )
  expect(served.headers()['content-type']).toBe('image/heic')
  expect(served.headers()['content-disposition']).toMatch(/^attachment/)
})

/**
 * A raw upload from "another device" of the same user that stays open until
 * `finish()`: while it streams, the server refuses the user's other uploads
 * with 429 UPLOAD_IN_PROGRESS.
 */
function slowUpload(token: string): { started: Promise<void>; finish: () => Promise<number> } {
  const boundary = 'trio-e2e-boundary'
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="buyuk.bin"\r\n` +
      'Content-Type: application/octet-stream\r\n\r\n',
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  const body = Buffer.alloc(2 * 1024 * 1024, 1)
  const request = http.request({
    host: '127.0.0.1',
    port: readState().port,
    path: '/api/uploads',
    method: 'POST',
    // Its own connection: never a pooled socket that may belong to an earlier server on this port.
    agent: false,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': head.length + body.length + tail.length,
    },
  })
  const done = new Promise<number>((resolve, reject) => {
    request.on('response', (response) => {
      response.resume()
      resolve(response.statusCode ?? 0)
    })
    request.on('error', reject)
  })
  request.write(head)
  request.write(body.subarray(0, 64 * 1024))
  // If the server answers this request before it is finished, say how, instead of a bare poll timeout.
  const early = done.then((status) => {
    throw new Error(`the other device's upload was answered early: HTTP ${status}`)
  })
  early.catch(() => undefined)
  return {
    started: Promise.race([untilReceiving(), early]),
    finish: async () => {
      request.end(Buffer.concat([body.subarray(64 * 1024), tail]))
      return done
    },
  }
}

/**
 * Resolves once the server is receiving an upload: its partial file exists.
 * (Probing with a second upload would race the first one: whichever the
 * server took first would have the other refused, and a refused "slow"
 * upload leaves nothing in progress — the cause of a failure seen once.)
 */
async function untilReceiving(): Promise<void> {
  const uploads = path.join(readState().dataDir, 'uploads')
  await expect
    .poll(() => fs.readdirSync(uploads).filter((name) => name.endsWith('.part')).length, {
      message: 'the server should be receiving the other device\'s upload',
    })
    .toBe(1)
}

test('another device uploading: the file waits, is tried again, and goes up', async ({ browser, trio }) => {
  const [ayse, mehmet] = await threePeople(browser, trio)
  const other = slowUpload(ayse.token)
  await other.started

  const refused: number[] = []
  ayse.page.on('response', (response) => {
    if (response.url().endsWith('/api/uploads')) refused.push(response.status())
  })
  await ayse.page.getByTestId('file-input').setInputFiles({ name: 'not.txt', mimeType: 'text/plain', buffer: Buffer.from('iki sekme\n') })
  const chip = chips(ayse.page)
  await expect(chip).toHaveAttribute('data-status', 'queued')
  await expect(chip).toContainText('Başka bir yükleme bitince denenecek…')
  expect(refused[0]).toBe(429)

  expect(await other.finish()).toBe(201)
  await expect(chip).toHaveAttribute('data-status', 'done', { timeout: 15_000 })
  await sendThroughUi(ayse, 'İki sekmeden de oldu')
  await expect(mehmet.page.getByTestId('message').filter({ hasText: 'İki sekmeden de oldu' }).getByTestId('attachment-file')).toContainText('not.txt')
})

async function attachAndTry(person: Person, file: { name: string; mimeType: string; buffer: Buffer }, text: string) {
  const page = person.page
  await page.getByTestId('file-input').setInputFiles(file)
  await expect(chips(page)).toHaveAttribute('data-status', 'error')
  await page.getByTestId('composer').fill(text)
  // Held: a message must not go out with one of its files silently missing.
  await expect(page.getByTestId('composer-send')).toBeDisabled()
  await page.getByTestId('composer').press('Enter')
}

test('over the quota: the Turkish message, and the message is not sent', async ({ browser, trio }) => {
  await freshServer({ TRIO_USER_QUOTA_MB: '1' })
  const [ayse, mehmet] = await threePeople(browser, trio)
  const big = { name: 'tatil-videosu.webm', mimeType: 'video/webm', buffer: Buffer.alloc(1_500_000, 3) }
  await attachAndTry(ayse, big, 'Videoyu da ekledim')
  await expect(chips(ayse.page)).toContainText('Yükleme kotan doldu')
  await expect(ayse.page.getByTestId('message')).toHaveCount(0)
  await expect(mehmet.page.getByTestId('message')).toHaveCount(0)
  // Taking the file away lets the words go on their own.
  await chips(ayse.page).getByTestId('pending-remove').click()
  await ayse.page.getByTestId('composer').press('Enter')
  await expect(mehmet.page.getByTestId('message').filter({ hasText: 'Videoyu da ekledim' })).toHaveCount(1)
})

test('a full disk: the Turkish message, and the message is not sent', async ({ browser, trio }) => {
  // A reserve no disk can keep: every upload would eat into it (507).
  await freshServer({ TRIO_DISK_RESERVE_MB: String(1024 * 1024 * 1024) })
  const [ayse, mehmet] = await threePeople(browser, trio)
  await attachAndTry(ayse, { name: 'fis.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n' + 'x'.repeat(2000)) }, 'Fişi ekledim')
  await expect(chips(ayse.page)).toContainText('Sunucunun diski dolu')
  await expect(mehmet.page.getByTestId('message')).toHaveCount(0)
})
