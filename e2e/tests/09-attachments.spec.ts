import fs from 'node:fs'
import type { Page } from '@playwright/test'
import { freshServer } from '../lib/server'
import { bulkSend, expect, expectConnected, GENEL, test, threePeople } from '../lib/trio'

test.beforeEach(async () => {
  await freshServer()
})

const messages = (page: Page) => page.getByTestId('message')
const message = (page: Page, text: string) => messages(page).filter({ hasText: text })

/** A real 640×400 PNG, drawn in the page. */
async function drawPng(page: Page): Promise<Buffer> {
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 640
    canvas.height = 400
    const g = canvas.getContext('2d')!
    const gradient = g.createLinearGradient(0, 0, 640, 400)
    gradient.addColorStop(0, '#f59e0b')
    gradient.addColorStop(1, '#0ea5a4')
    g.fillStyle = gradient
    g.fillRect(0, 0, 640, 400)
    g.fillStyle = '#fff'
    g.font = 'bold 64px sans-serif'
    g.fillText('Kapadokya', 40, 220)
    return canvas.toDataURL('image/png').split(',')[1]
  })
  return Buffer.from(base64, 'base64')
}

/** The `<img>` of an attachment has really been decoded, at the picture's own size. */
async function expectImageDecoded(page: Page, scope: ReturnType<Page['getByTestId']>, width = 640): Promise<void> {
  await expect
    .poll(() => scope.locator('img').evaluate((img: HTMLImageElement) => (img.complete ? img.naturalWidth : 0)))
    .toBe(width)
}

async function uploadsDone(page: Page, count: number): Promise<void> {
  await expect(page.getByTestId('pending-attachment')).toHaveCount(count)
  await expect(page.locator('[data-testid="pending-attachment"][data-status="done"]')).toHaveCount(count)
}

const NOTES = 'Trio notları — Kapadokya gezisi\n'.repeat(400)

test('attachments: image and file for the others, limits, paste, drop, lightbox, download, history', async ({ browser, trio }) => {
  test.setTimeout(150_000)
  const people = await threePeople(browser, trio)
  const [ayse, mehmet, zeynep] = people
  const png = await drawPng(ayse.page)

  // Zeynep's browser holds every file back until the test lets it go, to see
  // the image's box before the picture has arrived.
  let release: () => void = () => undefined
  const held = new Promise<void>((resolve) => (release = resolve))
  await zeynep.context.route('**/api/files/**', async (route) => {
    await held
    await route.continue()
  })

  // 1. Too large: refused in the browser with a Turkish sentence, never uploaded.
  const uploads: string[] = []
  ayse.page.on('request', (request) => {
    if (request.url().endsWith('/api/uploads')) uploads.push(request.method())
  })
  await ayse.page.getByTestId('file-input').setInputFiles({
    name: 'buyuk-video.mp4',
    mimeType: 'video/mp4',
    buffer: Buffer.alloc(26 * 1024 * 1024, 1),
  })
  await expect(ayse.page.getByTestId('attachment-notice')).toContainText(
    '“buyuk-video.mp4” çok büyük (26 MB). En fazla 25 MB yüklenebilir.',
  )
  await expect(ayse.page.getByTestId('pending-attachment')).toHaveCount(0)
  await ayse.page.getByTestId('attachment-notice').getByRole('button', { name: 'Tamam' }).click()
  await expect(ayse.page.getByTestId('attachment-notice')).toHaveCount(0)
  expect(uploads).toEqual([])

  // 2. An image and a text file through the paperclip, with a caption.
  const chooser = ayse.page.waitForEvent('filechooser')
  await ayse.page.getByTestId('btn-attach').click()
  await (await chooser).setFiles([
    { name: 'kapadokya.png', mimeType: 'image/png', buffer: png },
    { name: 'notlar.txt', mimeType: 'text/plain', buffer: Buffer.from(NOTES) },
  ])
  await uploadsDone(ayse.page, 2)
  expect(uploads).toEqual(['POST', 'POST'])
  await ayse.page.getByTestId('composer').fill('Fotoğraf ve notlar ekte')
  await ayse.page.getByTestId('composer').press('Enter')
  await expect(ayse.page.getByTestId('pending-attachment')).toHaveCount(0)
  await expect(message(ayse.page, 'Fotoğraf ve notlar ekte')).toHaveAttribute('data-status', 'sent')

  // What Zeynep sees before the picture arrives: its 400×300 box is already there.
  const zImage = message(zeynep.page, 'Fotoğraf ve notlar ekte').getByTestId('attachment-image')
  await expect(zImage).toBeVisible()
  expect(await zImage.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(0)
  const reserved = await zImage.boundingBox()
  expect(reserved && [Math.round(reserved.width), Math.round(reserved.height)]).toEqual([400, 300])
  release()
  await expectImageDecoded(zeynep.page, zImage)
  const loaded = await zImage.boundingBox()
  expect(loaded && [Math.round(loaded.width), Math.round(loaded.height)]).toEqual([400, 300])

  // Both others get the image and the file row (name, size, download).
  for (const viewer of [mehmet, zeynep]) {
    const row = message(viewer.page, 'Fotoğraf ve notlar ekte')
    await expect(row).toHaveCount(1)
    await expectImageDecoded(viewer.page, row.getByTestId('attachment-image'))
    await expect(row.getByTestId('attachment-file')).toContainText('notlar.txt')
    await expect(row.getByTestId('attachment-file')).toContainText('14 KB')
  }
  // The sender's optimistic row became the stored one: once, sent.
  await expect(message(ayse.page, 'Fotoğraf ve notlar ekte')).toHaveCount(1)

  // 3. Download: the file comes down as a download, byte for byte, served as `attachment`.
  const fileRow = message(mehmet.page, 'Fotoğraf ve notlar ekte').getByTestId('attachment-file')
  const href = (await fileRow.locator('a').first().getAttribute('href'))!
  expect(href).toMatch(/^\/api\/files\/[^/]+\/notlar\.txt$/)
  const downloading = mehmet.page.waitForEvent('download')
  await fileRow.getByRole('link', { name: 'İndir: notlar.txt' }).click()
  const download = await downloading
  expect(download.suggestedFilename()).toBe('notlar.txt')
  expect(fs.readFileSync(await download.path()).toString()).toBe(NOTES)
  const served = await mehmet.context.request.get(href)
  expect(served.status()).toBe(200)
  expect(served.headers()['content-disposition']).toMatch(/^attachment/)
  expect(served.headers()['x-content-type-options']).toBe('nosniff')
  const imageHref = (await message(mehmet.page, 'Fotoğraf ve notlar ekte').getByTestId('attachment-image').locator('img').getAttribute('src'))!
  const image = await mehmet.context.request.get(imageHref)
  expect(image.headers()['content-disposition']).toMatch(/^inline/)
  expect(image.headers()['content-type']).toBe('image/png')

  // 4. Lightbox: the picture at full size; Esc, a click outside, and the keyboard.
  const mImage = message(mehmet.page, 'Fotoğraf ve notlar ekte').getByTestId('attachment-image')
  await mImage.click()
  const lightbox = mehmet.page.getByTestId('lightbox')
  await expect(lightbox).toBeVisible()
  await expect(lightbox).toContainText('kapadokya.png')
  await expect.poll(() => lightbox.locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(640)
  await mehmet.page.keyboard.press('Escape')
  await expect(lightbox).toHaveCount(0)
  await mImage.focus()
  await mehmet.page.keyboard.press('Enter')
  await expect(lightbox).toBeVisible()
  await mehmet.page.mouse.click(8, 400)
  await expect(lightbox).toHaveCount(0)
  await expect(mImage).toBeFocused()

  // 5. Paste an image: it gets a name, and a message with only an attachment is allowed.
  await ayse.page.getByTestId('composer').focus()
  await ayse.page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const data = new DataTransfer()
    data.items.add(new File([bytes], 'image.png', { type: 'image/png' }))
    document
      .querySelector('[data-testid="composer"]')!
      .dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, png.toString('base64'))
  await uploadsDone(ayse.page, 1)
  await expect(ayse.page.locator('.pending-name')).toHaveText(/^yapistirilan-\d{8}-\d{6}\.png$/)
  await expect(ayse.page.getByTestId('composer')).toHaveValue('')
  await expect(ayse.page.getByTestId('composer-send')).toBeEnabled()
  await ayse.page.getByTestId('composer-send').click()
  for (const viewer of [mehmet, zeynep]) {
    const last = messages(viewer.page).last()
    await expect(last.getByTestId('attachment-image')).toHaveCount(1)
    await expect(last.locator('.message-content')).toHaveCount(0)
    await expectImageDecoded(viewer.page, last.getByTestId('attachment-image'))
  }

  // 6. Drag and drop onto the chat: an overlay while dragging, a chip after the drop.
  await ayse.page.evaluate(() => {
    const data = new DataTransfer()
    data.items.add(new File(['rota: Göreme → Uçhisar'], 'rota.txt', { type: 'text/plain' }))
    ;(window as unknown as { __drop: DataTransfer }).__drop = data
    document.querySelector('main')!.dispatchEvent(new DragEvent('dragenter', { dataTransfer: data, bubbles: true, cancelable: true }))
  })
  await expect(ayse.page.getByTestId('drop-overlay')).toBeVisible()
  await expect(ayse.page.getByTestId('drop-overlay')).toContainText('Dosyaları buraya bırak')
  await ayse.page.evaluate(() => {
    const data = (window as unknown as { __drop: DataTransfer }).__drop
    document.querySelector('main')!.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }))
  })
  await expect(ayse.page.getByTestId('drop-overlay')).toHaveCount(0)
  await uploadsDone(ayse.page, 1)
  await ayse.page.getByTestId('composer').fill('rota da burada')
  await ayse.page.getByTestId('composer').press('Enter')
  for (const viewer of [mehmet, zeynep]) {
    await expect(message(viewer.page, 'rota da burada').getByTestId('attachment-file')).toContainText('rota.txt')
  }
  // A chip can also be taken back before sending.
  await ayse.page.getByTestId('file-input').setInputFiles({ name: 'vazgec.txt', mimeType: 'text/plain', buffer: Buffer.from('x') })
  await uploadsDone(ayse.page, 1)
  await ayse.page.getByTestId('pending-remove').click()
  await expect(ayse.page.getByTestId('pending-attachment')).toHaveCount(0)
  await expect(ayse.page.getByTestId('composer-send')).toBeDisabled()

  // 7. History: after a reload, and from an older page (55 messages on top push it off the first 50).
  await bulkSend(mehmet, GENEL, 55, 'sonraki mesaj')
  await expect(messages(zeynep.page).last()).toContainText('sonraki mesaj 55')
  await zeynep.context.unroute('**/api/files/**')
  await zeynep.page.reload()
  await expectConnected(zeynep.page)
  await expect(messages(zeynep.page)).toHaveCount(50)
  await expect(message(zeynep.page, 'Fotoğraf ve notlar ekte')).toHaveCount(0)
  await zeynep.page.getByTestId('message-list').evaluate((el) => (el.scrollTop = 0))
  const old = message(zeynep.page, 'Fotoğraf ve notlar ekte')
  await expect(old).toHaveCount(1)
  await expectImageDecoded(zeynep.page, old.getByTestId('attachment-image'))
  await expect(old.getByTestId('attachment-file')).toContainText('notlar.txt')
  await expect(message(zeynep.page, 'rota da burada').getByTestId('attachment-file')).toContainText('rota.txt')
  await expect(zeynep.page.getByTestId('attachment-image')).toHaveCount(2)
  await expect(zeynep.page.getByTestId('attachment-file')).toHaveCount(2)
})
