// Attachments: an image and a non-image file uploaded by one user render for
// another (image inline in its reserved box + lightbox, file as a download
// row); a too-large file is refused before upload with a Turkish message;
// paste and drag-and-drop add chips; an attachment-only message is allowed.
// Screenshot: shots/attachments.png.
import { join } from 'node:path'
import { check, launch, person, SHOTS, sleep, until } from './lib.mjs'

const browser = await launch()
try {
  const a = await person(browser, 'Ayşe')
  const b = await person(browser, 'Bora', { scale: 2 })

  // Earlier runs left messages behind: count relative to now.
  await sleep(1000)
  const imagesBefore = await b.page.getByTestId('attachment-image').count()
  const filesBefore = await b.page.getByTestId('attachment-file').count()

  // A real PNG, drawn in the page.
  const pngBase64 = await a.page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 640
    canvas.height = 400
    const g = canvas.getContext('2d')
    const gradient = g.createLinearGradient(0, 0, 640, 400)
    gradient.addColorStop(0, '#f59e0b')
    gradient.addColorStop(1, '#0ea5a4')
    g.fillStyle = gradient
    g.fillRect(0, 0, 640, 400)
    g.fillStyle = '#fff'
    g.font = 'bold 56px sans-serif'
    g.fillText('Trio 📷', 40, 220)
    return canvas.toDataURL('image/png').split(',')[1]
  })
  const png = Buffer.from(pngBase64, 'base64')

  // 1. Too large: refused before any upload.
  const uploadsBefore = []
  a.page.on('request', (request) => {
    if (request.url().endsWith('/api/uploads')) uploadsBefore.push(request.url())
  })
  await a.page.getByTestId('file-input').setInputFiles({
    name: 'buyuk-video.mp4',
    mimeType: 'video/mp4',
    buffer: Buffer.alloc(26 * 1024 * 1024, 1),
  })
  const notice = await a.page.getByTestId('attachment-notice').innerText()
  console.log('  notice:', notice)
  check(/çok büyük/.test(notice) && /25 MB/.test(notice), 'a too-large file gets a clear Turkish message')
  check(uploadsBefore.length === 0, 'and is never uploaded')
  check((await a.page.getByTestId('pending-attachment').count()) === 0, 'no chip for it')
  await a.page.getByTestId('attachment-notice').getByRole('button').click()

  // 2. An image and a text file through the paperclip's input.
  await a.page.getByTestId('file-input').setInputFiles([
    { name: 'tatil.png', mimeType: 'image/png', buffer: png },
    { name: 'notlar.txt', mimeType: 'text/plain', buffer: Buffer.from('Trio notları\n'.repeat(400)) },
  ])
  check((await a.page.getByTestId('pending-attachment').count()) === 2, 'two chips above the composer')
  await until(
    async () => (await a.page.locator('[data-testid="pending-attachment"][data-status="done"]').count()) === 2,
    'both uploaded',
  )
  await a.page.getByTestId('composer').fill('Fotoğraf ve notlar ekte')
  await a.page.getByTestId('composer').press('Enter')
  check((await a.page.getByTestId('pending-attachment').count()) === 0, 'chips cleared on send')

  // 3. Attachment-only message (content empty) via paste of an image.
  await a.page.getByTestId('composer').focus()
  await a.page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const file = new File([bytes], 'image.png', { type: 'image/png' })
    const data = new DataTransfer()
    data.items.add(file)
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
    document.querySelector('[data-testid="composer"]').dispatchEvent(event)
  }, pngBase64)
  await until(
    async () => (await a.page.locator('[data-testid="pending-attachment"][data-status="done"]').count()) === 1,
    'pasted image uploaded',
  )
  const pastedName = await a.page.locator('.pending-name').innerText()
  check(/^yapistirilan-\d{8}-\d{6}\.png$/.test(pastedName), `a pasted image gets a name (${pastedName})`)
  check(await a.page.getByTestId('composer-send').isEnabled(), 'send is enabled with only an attachment')
  await a.page.getByTestId('composer-send').click()

  // 4. Drag-and-drop: overlay while dragging, a chip after the drop; then cancel it.
  await a.page.evaluate(() => {
    const main = document.querySelector('main')
    const data = new DataTransfer()
    data.items.add(new File(['merhaba'], 'surukle.txt', { type: 'text/plain' }))
    main.dispatchEvent(new DragEvent('dragenter', { dataTransfer: data, bubbles: true, cancelable: true }))
    window.__dropData = data
  })
  await a.page.getByTestId('drop-overlay').waitFor({ timeout: 3000 })
  check(await a.page.getByTestId('drop-overlay').isVisible(), 'a visible drop overlay while dragging files')
  await a.page.evaluate(() => {
    const main = document.querySelector('main')
    main.dispatchEvent(new DragEvent('drop', { dataTransfer: window.__dropData, bubbles: true, cancelable: true }))
  })
  check((await a.page.getByTestId('drop-overlay').count()) === 0, 'overlay gone after the drop')
  await until(() => a.page.getByTestId('pending-attachment').count(), 'dropped file is a chip')
  await a.page.getByTestId('pending-remove').click()
  check((await a.page.getByTestId('pending-attachment').count()) === 0, 'a chip can be removed')

  // 5. What the other user sees.
  await until(async () => (await b.page.getByTestId('attachment-image').count()) === imagesBefore + 2, 'B sees both images')
  await until(async () => (await b.page.getByTestId('attachment-file').count()) === filesBefore + 1, 'B sees the file row')
  const message = b.page.getByTestId('message').filter({ hasText: 'Fotoğraf ve notlar ekte' }).last()
  const image = message.getByTestId('attachment-image')
  await until(
    () => image.locator('img').evaluate((img) => img.complete && img.naturalWidth > 0),
    'image decoded',
  )
  const box = await image.boundingBox()
  check(Math.round(box.height) === 300 && Math.round(box.width) <= 400, `image sits in its reserved 400x300 box (${box.width}x${box.height})`)
  const fileRow = message.getByTestId('attachment-file')
  const fileText = await fileRow.innerText()
  check(/notlar\.txt/.test(fileText) && /KB/.test(fileText), `file row with name and size (${fileText.replace(/\n/g, ' | ')})`)
  const href = await fileRow.locator('a').first().getAttribute('href')
  check(href.startsWith('/api/files/') && (await fileRow.locator('a[download]').count()) > 0, 'download link to /api/files/')
  const served = await fetch(new URL(href, 'http://localhost:8000'))
  check(/attachment/.test(served.headers.get('content-disposition') ?? ''), 'the text file is served as an attachment')
  check((await message.count()) === 1, 'the text arrived with its attachments')

  await sleep(300)
  await b.page.screenshot({ path: join(SHOTS, 'attachments.png') })
  console.log('  screenshot shots/attachments.png')

  // 6. Lightbox: opens on click / Enter, Esc closes, a click outside closes.
  await image.click()
  await b.page.getByTestId('lightbox').waitFor()
  await b.page.screenshot({ path: join(SHOTS, 'lightbox.png') })
  await b.page.keyboard.press('Escape')
  check((await b.page.getByTestId('lightbox').count()) === 0, 'Esc closes the lightbox')
  await image.focus()
  await b.page.keyboard.press('Enter')
  await b.page.getByTestId('lightbox').waitFor()
  check(true, 'the image opens from the keyboard')
  await b.page.mouse.click(10, 400)
  check((await b.page.getByTestId('lightbox').count()) === 0, 'a click outside the image closes it')

  // 7. The sender's optimistic row is replaced by the stored one (no duplicate).
  check(
    (await a.page.getByTestId('message').filter({ hasText: 'Fotoğraf ve notlar ekte' }).count()) ===
      (await b.page.getByTestId('message').filter({ hasText: 'Fotoğraf ve notlar ekte' }).count()),
    'no duplicate for the sender',
  )
  check((await a.page.locator('[data-testid="message"][data-status="failed"]').count()) === 0, 'nothing failed')
  console.log('attachments: all checks passed')
} finally {
  await browser.close()
}
