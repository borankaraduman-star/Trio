/**
 * CONTRACT-V6-MEDIA §1–2: a phone photo is made smaller in the browser before
 * it is uploaded, stands up (EXIF orientation applied), loses its EXIF (GPS
 * included), and carries a 480 px preview the list shows while the lightbox
 * shows the original; the message box is reserved at the picture's own shape.
 */
import { freshServer } from '../lib/server'
import { expect, GENEL, personViaApi, test, threePeople } from '../lib/trio'
import {
  chipsDone,
  decodedImage,
  drawnPng,
  exifSegment,
  fetchBytes,
  lastAttachments,
  dropPhoto,
  noisyJpeg,
  photoInPage,
  sendComposer,
  webpChunks,
  withSegment,
} from '../lib/v6media'

test.beforeEach(async () => {
  await freshServer()
})

const isRed = ([r, g, b]: number[]) => r > 200 && g < 70 && b < 70

test('a 12-megapixel phone photo: smaller, upright, no EXIF, a preview in the list, the original in the lightbox', async ({ browser, trio }) => {
  test.setTimeout(150_000)
  const [ayse, mehmet, zeynep] = await threePeople(browser, trio)
  // 4000 × 3000 as stored, "rotate 90°" in its EXIF, with a GPS position; made in the page.
  const pickedSize = await photoInPage(ayse.page, 4000, 3000, exifSegment(6), 'IMG_2041.JPG')
  expect(pickedSize).toBeGreaterThan(3_000_000)

  // How long the page's own thread is blocked while the photo is prepared.
  await ayse.page.evaluate(() => {
    const w = window as unknown as { __longTasks: number[] }
    w.__longTasks = []
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) w.__longTasks.push(entry.duration)
    }).observe({ type: 'longtask', buffered: false })
  })
  await dropPhoto(ayse.page)
  // While it is prepared the composer stays usable: typing works at once.
  await ayse.page.getByTestId('composer').fill('Kapadokya')
  await expect(ayse.page.getByTestId('composer')).toHaveValue('Kapadokya')
  await chipsDone(ayse.page, 1)
  const chip = ayse.page.getByTestId('pending-attachment')
  await expect(chip.locator('.pending-name')).toHaveText('IMG_2041.webp')
  await expect(chip.getByTestId('pending-shrunk')).toHaveText(/^\d+(,\d)? MB → \d+(,\d)? (KB|MB)\s*konum bilgisi silindi$/)
  await expect(chip.getByTestId('send-original')).not.toBeChecked()
  const longTasks = await ayse.page.evaluate(() => (window as unknown as { __longTasks: number[] }).__longTasks)
  const stall = Math.max(0, ...longTasks)
  test.info().annotations.push({ type: 'main-thread stall (longest long task, ms)', description: String(Math.round(stall)) })
  console.log(`[v6] 12 MP photo: longest main-thread task ${Math.round(stall)} ms over ${longTasks.length} long tasks`)
  expect(stall).toBeLessThan(200)

  await sendComposer(ayse, 'Kapadokya')

  // What was stored: a WebP, ≤ 2048 px, much smaller, with no EXIF chunk or bytes.
  const [stored] = await lastAttachments(ayse.token, GENEL)
  expect(stored.content_type).toBe('image/webp')
  expect([stored.width, stored.height]).toEqual([1536, 2048])
  expect(stored.size).toBeLessThan(pickedSize / 3)
  expect(stored.preview_url).toMatch(/^\/api\/previews\//)
  const file = await fetchBytes(stored.url)
  expect(file.bytes.length).toBe(stored.size)
  expect(webpChunks(file.bytes).filter((id) => id === 'EXIF' || id === 'XMP ')).toEqual([])
  expect(file.bytes.includes(Buffer.from('Exif', 'latin1'))).toBe(false)
  const preview = await fetchBytes(stored.preview_url!)
  expect(preview.type).toBe('image/webp')
  expect(preview.bytes.length).toBeLessThanOrEqual(200 * 1024)
  console.log(`[v6] sizes: picked ${pickedSize} B → stored ${stored.size} B, preview ${preview.bytes.length} B`)
  test.info().annotations.push({ type: 'sizes (picked → stored → preview)', description: `${pickedSize} → ${stored.size} → ${preview.bytes.length}` })

  for (const viewer of [mehmet, zeynep]) {
    const row = viewer.page.getByTestId('message').filter({ hasText: 'Kapadokya' })
    const box = row.getByTestId('attachment-image')
    // The box has the picture's shape (portrait 1536 × 2048 → 225 × 300) whether or not it has loaded.
    await expect(box).toBeVisible()
    const reserved = (await box.boundingBox())!
    expect([Math.round(reserved.width), Math.round(reserved.height)]).toEqual([225, 300])
    // The list shows the 480 px preview, upright: the red band is at the top.
    await expect
      .poll(() => decodedImage(box.locator('img')))
      .toMatchObject({ w: 360, h: 480 })
    const small = (await decodedImage(box.locator('img')))!
    expect(isRed(small.top)).toBe(true)
    expect(isRed(small.bottom)).toBe(false)
    // The lightbox loads the original, upright too.
    await box.click()
    const lightbox = viewer.page.getByTestId('lightbox')
    await expect(lightbox).toBeVisible()
    await expect.poll(() => decodedImage(lightbox.locator('img'))).toMatchObject({ w: 1536, h: 2048 })
    const big = (await decodedImage(lightbox.locator('img')))!
    expect(isRed(big.top)).toBe(true)
    expect(isRed(big.bottom)).toBe(false)
    await viewer.page.keyboard.press('Escape')
    await expect(lightbox).toHaveCount(0)
    expect(await box.boundingBox()).toEqual(reserved)
  }
})

test('"Orijinali gönder": the file as picked, remembered on this device; GIFs, small pictures and HEIC untouched; transparency kept', async ({ browser, trio }) => {
  test.setTimeout(150_000)
  const [ayse, mehmet] = await threePeople(browser, trio)
  const page = ayse.page
  const photo = withSegment(await noisyJpeg(page, 3000, 2000), exifSegment(1))

  await page.getByTestId('file-input').setInputFiles({ name: 'tatil.jpg', mimeType: 'image/jpeg', buffer: photo })
  await chipsDone(page, 1)
  await expect(page.locator('.pending-name')).toHaveText('tatil.webp')
  // Turned on: the same chip is prepared again and goes up as picked.
  await page.getByTestId('send-original').check()
  await chipsDone(page, 1)
  await expect(page.locator('.pending-name')).toHaveText('tatil.jpg')
  await expect(page.getByTestId('pending-shrunk')).toHaveCount(0)
  await sendComposer(ayse, 'orijinal')
  let [stored] = await lastAttachments(ayse.token, GENEL)
  expect([stored.content_type, stored.size, stored.width, stored.height]).toEqual(['image/jpeg', photo.length, 3000, 2000])
  expect((await fetchBytes(stored.url)).bytes.equals(photo)).toBe(true)
  // Still a preview: a 3000 px original is not what the list should load.
  expect(stored.preview_url).not.toBeNull()

  // Remembered after a reload, and turned off again.
  await page.reload()
  await page.getByTestId('file-input').setInputFiles({ name: 'tatil2.jpg', mimeType: 'image/jpeg', buffer: photo })
  await chipsDone(page, 1)
  await expect(page.getByTestId('send-original')).toBeChecked()
  await expect(page.locator('.pending-name')).toHaveText('tatil2.jpg')
  await page.getByTestId('send-original').uncheck()
  await chipsDone(page, 1)
  await expect(page.locator('.pending-name')).toHaveText('tatil2.webp')
  await sendComposer(ayse, 'küçük')
  ;[stored] = await lastAttachments(ayse.token, GENEL)
  expect(stored.content_type).toBe('image/webp')
  expect(Math.max(stored.width!, stored.height!)).toBeLessThanOrEqual(2048)

  // A small picture, a GIF and a HEIC (Chromium cannot decode it) go up byte for byte.
  const smallPng = await drawnPng(page, 200, 120)
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64')
  const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic\0\0\0\0mif1heic', 'latin1'), Buffer.alloc(4000, 9)])
  await page.getByTestId('file-input').setInputFiles([
    { name: 'kucuk.png', mimeType: 'image/png', buffer: smallPng },
    { name: 'kedi.gif', mimeType: 'image/gif', buffer: gif },
    { name: 'IMG_9.HEIC', mimeType: 'image/heic', buffer: heic },
  ])
  await chipsDone(page, 3)
  await expect(page.getByTestId('send-original')).toHaveCount(0)
  await sendComposer(ayse, 'dokunulmadı')
  const untouched = await lastAttachments(ayse.token, GENEL)
  expect(untouched.map((a) => [a.filename, a.size, a.preview_url])).toEqual([
    ['kucuk.png', smallPng.length, null],
    ['kedi.gif', gif.length, null],
    ['IMG_9.HEIC', heic.length, null],
  ])

  // A big PNG with a transparent half: a WebP that is still transparent there.
  const alpha = await drawnPng(page, 2600, 1300, true)
  await page.getByTestId('file-input').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: alpha })
  await chipsDone(page, 1)
  await sendComposer(ayse, 'saydam')
  ;[stored] = await lastAttachments(ayse.token, GENEL)
  expect([stored.content_type, stored.width, stored.height]).toEqual(['image/webp', 2048, 1024])
  const pixels = await mehmet.page.evaluate(async (url) => {
    const bitmap = await createImageBitmap(await (await fetch(url)).blob())
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const g = canvas.getContext('2d')!
    g.drawImage(bitmap, 0, 0)
    return { left: g.getImageData(200, 500, 1, 1).data[3], right: g.getImageData(1800, 500, 1, 1).data[3] }
  }, stored.url)
  expect(pixels).toEqual({ left: 255, right: 0 })
})

test('390 px: the photo chip with its sizes and the switch fits the screen', async ({ browser, trio }) => {
  const phone = trio.add(await personViaApi(browser, 'Ayşe', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }))
  const photo = await noisyJpeg(phone.page, 3000, 2000)
  await phone.page.getByTestId('file-input').setInputFiles({ name: 'telefon-fotografi-uzun-adli.jpg', mimeType: 'image/jpeg', buffer: photo })
  await chipsDone(phone.page, 1)
  for (const id of ['pending-attachment', 'pending-shrunk', 'send-original', 'composer-send']) {
    await expect(phone.page.getByTestId(id)).toBeInViewport({ ratio: 1 })
  }
  expect(await phone.page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
})
