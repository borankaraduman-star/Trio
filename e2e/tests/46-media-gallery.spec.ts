/**
 * CONTRACT-V6-MEDIA §3: the channel's "Medya" panel — pictures and videos by
 * month with infinite scroll, the lightbox walking through all of them, every
 * link with its author and "mesaja git", and the other files. Seeded with 80+
 * mixed posts across three months from three people.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { sql } from '../lib/db'
import { E2E_DIR, freshServer, ROOT } from '../lib/server'
import { expect, GENEL, personViaApi, test, threePeople, type Person } from '../lib/trio'
import { apiSocket, apiUpload, decodedImage, gradientPng } from '../lib/v6media'
import { rest } from '../lib/messages'

const OUT = path.join(E2E_DIR, 'screenshots')
const VIDEO = fs.readFileSync(path.join(ROOT, 'server', 'tests', 'fixtures', 'video-chromium.webm'))
const MONTHS = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık']

test.beforeEach(async () => {
  await freshServer()
})

/** Istanbul's month `back` months before now, as the panel labels it. */
function monthBack(back: number): { label: string; iso: string } {
  const now = new Date()
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 12, 9, 0, 0))
  return { label: `${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`, iso: date.toISOString().replace(/\.\d+Z$/, '.000Z') }
}

interface Seeded {
  imageIds: string[]
  /** The newer video (message 70). */
  videoId: string
  /** Newest first, as the gallery lists them. */
  mediaNewestFirst: string[]
  linkMessages: { id: number; url: string }[]
  fileNames: string[]
}

/**
 * 84 messages from the three: 41 with two pictures each, 2 with a video, 20
 * with a link, 21 with a text file (84 pictures and videos). The oldest 30 are dated two months back,
 * the next 30 one month back, the rest now.
 */
async function seed(people: Person[]): Promise<Seeded> {
  const sockets = await Promise.all(people.map((p) => apiSocket(p.token)))
  const seeded: Seeded = { imageIds: [], videoId: '', mediaNewestFirst: [], linkMessages: [], fileNames: [] }
  const media: { messageId: number; ids: string[] }[] = []
  for (let i = 0; i < 84; i += 1) {
    const who = i % 3
    const token = people[who].token
    const send = sockets[who].send
    if (i === 20 || i === 70) {
      const video = await apiUpload(token, { name: `video-${i}.webm`, type: 'video/webm', buffer: VIDEO })
      if (i === 70) seeded.videoId = video.id
      media.push({ messageId: await send(GENEL, `video ${i}`, [video.id]), ids: [video.id] })
    } else if (i % 4 < 2) {
      const a = await apiUpload(token, { name: `foto-${i}-a.png`, type: 'image/png', buffer: gradientPng(320, 200, i * 2) })
      const b = await apiUpload(token, { name: `foto-${i}-b.png`, type: 'image/png', buffer: gradientPng(200, 320, i * 2 + 1) })
      seeded.imageIds.push(a.id, b.id)
      media.push({ messageId: await send(GENEL, `fotoğraflar ${i}`, [a.id, b.id]), ids: [a.id, b.id] })
    } else if (i % 4 === 2) {
      const url = `https://ornek.com.tr/yazi/${i}`
      seeded.linkMessages.push({ id: await send(GENEL, `şuna bak: ${url}, güzel`), url })
    } else {
      const file = await apiUpload(token, { name: `notlar-${i}.txt`, type: 'text/plain', buffer: Buffer.from(`not ${i}\n`) })
      seeded.fileNames.push(file.filename)
      await send(GENEL, `dosya ${i}`, [file.id])
    }
  }
  for (const s of sockets) s.close()
  sql('UPDATE messages SET created_at = ? WHERE id <= 30', [monthBack(2).iso])
  sql('UPDATE messages SET created_at = ? WHERE id > 30 AND id <= 60', [monthBack(1).iso])
  seeded.mediaNewestFirst = [...media].reverse().flatMap((m) => m.ids)
  return seeded
}

async function openGallery(page: Page): Promise<void> {
  await page.getByTestId('btn-media').click()
  await expect(page.getByTestId('media-gallery')).toBeVisible()
}

/** Scroll the panel to its end until it has loaded `count` grid items. */
async function scrollUntil(page: Page, testId: string, count: number): Promise<void> {
  await expect
    .poll(
      async () => {
        await page.getByTestId('gallery-scroll').evaluate((element) => (element.scrollTop = element.scrollHeight))
        return page.getByTestId(testId).count()
      },
      { timeout: 20_000, intervals: [100, 250, 500] },
    )
    .toBe(count)
}

test('the media panel after 84 posts: months, infinite scroll, the lightbox through all of them, links and files', async ({ browser, trio }) => {
  test.setTimeout(180_000)
  const people = await threePeople(browser, trio)
  const [ayse, mehmet, zeynep] = people
  const seeded = await seed(people)
  expect(seeded.mediaNewestFirst).toHaveLength(84)

  // Mehmet opens it: the first page (60), newest first, by month; then the rest as he scrolls.
  await mehmet.page.reload()
  await openGallery(mehmet.page)
  const items = mehmet.page.getByTestId('gallery-item')
  await expect(items).toHaveCount(60)
  await scrollUntil(mehmet.page, 'gallery-item', 84)
  const order = await items.evaluateAll((els) => els.map((e) => e.closest('li')!.parentElement!.parentElement!.querySelector('h3')!.textContent))
  expect([...new Set(order)]).toEqual([monthBack(0).label, monthBack(1).label, monthBack(2).label])
  await expect(mehmet.page.getByTestId('gallery-month')).toHaveText([monthBack(0).label, monthBack(1).label, monthBack(2).label])
  await expect(items.filter({ has: mehmet.page.locator('video') })).toHaveCount(2)
  // A grid picture is the real decoded picture.
  await expect.poll(() => decodedImage(items.first().locator('img'))).toMatchObject({ w: 320, h: 200 })

  // The lightbox: the original, arrow keys through the whole gallery, both ends stop.
  await items.nth(0).click()
  const lightbox = mehmet.page.getByTestId('gallery-lightbox')
  await expect(lightbox).toHaveAttribute('data-index', '0')
  await expect.poll(() => decodedImage(lightbox.getByTestId('gallery-lightbox-image'))).toMatchObject({ w: 320, h: 200 })
  await mehmet.page.keyboard.press('ArrowRight')
  await expect(lightbox).toHaveAttribute('data-index', '1')
  await expect.poll(() => decodedImage(lightbox.getByTestId('gallery-lightbox-image'))).toMatchObject({ w: 200, h: 320 })
  await mehmet.page.keyboard.press('ArrowLeft')
  await mehmet.page.keyboard.press('ArrowLeft')
  await expect(lightbox).toHaveAttribute('data-index', '0')
  await expect(mehmet.page.getByTestId('gallery-prev')).toBeDisabled()
  // The newer video (message 70's) decodes in the lightbox, reached with "Sonraki".
  const videoIndex = seeded.mediaNewestFirst.indexOf(seeded.videoId)
  expect(videoIndex).toBeGreaterThan(0)
  for (let i = 0; i < videoIndex; i += 1) await mehmet.page.getByTestId('gallery-next').click()
  await expect(lightbox).toHaveAttribute('data-index', String(videoIndex))
  const video = lightbox.getByTestId('gallery-lightbox-video')
  await expect(video).toHaveCount(1)
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.readyState >= 1 && v.videoWidth)).toBe(320)
  await mehmet.page.keyboard.press('Escape')
  await expect(lightbox).toHaveCount(0)
  await expect(mehmet.page.getByTestId('media-gallery')).toBeVisible()

  // "mesaja git" from the lightbox of the oldest picture: the panel closes, the old message is brought into view.
  await items.last().click()
  await expect(lightbox).toHaveAttribute('data-index', '83')
  await expect(mehmet.page.getByTestId('gallery-next')).toBeDisabled()
  await lightbox.getByTestId('gallery-lightbox-jump').click()
  await expect(mehmet.page.getByTestId('media-gallery')).toHaveCount(0)
  const oldest = mehmet.page.getByTestId('message').filter({ hasText: 'fotoğraflar 0' })
  await expect(oldest).toBeInViewport()

  // Links: edit one away, change one, delete one; Zeynep's panel shows what is true now.
  const [first, second, third] = seeded.linkMessages
  const authorOf = (index: number) => people[(index * 4 + 2) % 3]
  expect((await rest(authorOf(0).token, `/api/messages/${first.id}`, 'PATCH', { content: 'bağlantı kaldırıldı' })).status).toBe(200)
  expect((await rest(authorOf(1).token, `/api/messages/${second.id}`, 'PATCH', { content: 'yeni adres (https://yeni.ornek.com/a_(b)).' })).status).toBe(200)
  expect((await rest(authorOf(2).token, `/api/messages/${third.id}`, 'DELETE')).status).toBe(204)
  await openGallery(zeynep.page)
  await zeynep.page.getByTestId('gallery-tab-links').click()
  const links = zeynep.page.getByTestId('gallery-link')
  await expect(links).toHaveCount(18)
  const urls = await links.locator('.gallery-link-url').allTextContents()
  expect(urls).not.toContain(first.url)
  expect(urls).not.toContain(third.url)
  expect(urls).not.toContain(second.url)
  expect(urls[urls.length - 1]).toBe('https://yeni.ornek.com/a_(b)')
  expect(urls[0]).toBe(seeded.linkMessages[seeded.linkMessages.length - 1].url)
  await expect(links.first()).toContainText(people[(82 % 3)].name)
  await expect(links.first().locator('a')).toHaveAttribute('href', urls[0])
  await expect(links.first().locator('a')).toHaveAttribute('target', '_blank')
  await expect(links.last()).toContainText('yeni adres')
  await links.last().getByTestId('gallery-jump').click()
  await expect(zeynep.page.getByTestId('media-gallery')).toHaveCount(0)
  await expect(zeynep.page.getByTestId('message').filter({ hasText: 'yeni adres' })).toBeInViewport()

  // Files: the text files, newest first, with the download link; no pictures there.
  await openGallery(ayse.page)
  await ayse.page.getByTestId('gallery-tab-files').click()
  const files = ayse.page.getByTestId('gallery-file')
  await expect(files).toHaveCount(seeded.fileNames.length)
  await expect(files.first()).toContainText(seeded.fileNames[seeded.fileNames.length - 1])
  await expect(files.first().getByRole('link', { name: `İndir: ${seeded.fileNames[seeded.fileNames.length - 1]}` })).toHaveAttribute('href', /^\/api\/files\//)
})

test('390 px: the panel fills the screen, a swipe walks the lightbox, screenshots', async ({ browser, trio }) => {
  test.setTimeout(180_000)
  const people = await threePeople(browser, trio)
  await seed(people)
  const phone = trio.add(await personViaApi(browser, 'Ece', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }))
  const desktop = trio.add(await personViaApi(browser, 'Deniz', { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 }))

  // Desktop screenshot: the panel over the chat.
  await openGallery(desktop.page)
  await expect(desktop.page.getByTestId('gallery-item')).toHaveCount(60)
  await expect.poll(() => desktop.page.getByTestId('gallery-item').locator('img').evaluateAll((els) => (els as HTMLImageElement[]).slice(0, 18).every((i) => i.complete && i.naturalWidth > 0))).toBe(true)
  await desktop.page.screenshot({ path: path.join(OUT, 'v6-media-gallery.png') })

  await phone.page.getByTestId('btn-media').tap()
  const panel = phone.page.getByTestId('media-gallery')
  const box = (await panel.boundingBox())!
  expect([box.x, Math.round(box.width)]).toEqual([0, 390])
  expect(await phone.page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await expect.poll(() => phone.page.getByTestId('gallery-item').locator('img').evaluateAll((els) => (els as HTMLImageElement[]).slice(0, 12).every((i) => i.complete && i.naturalWidth > 0))).toBe(true)
  await phone.page.screenshot({ path: path.join(OUT, 'v6-media-gallery-390.png') })

  // A swipe left is the next picture, a swipe right the previous.
  await phone.page.getByTestId('gallery-item').nth(2).tap()
  const lightbox = phone.page.getByTestId('gallery-lightbox')
  await expect(lightbox).toHaveAttribute('data-index', '2')
  const cdp = await phone.context.newCDPSession(phone.page)
  const swipe = async (fromX: number, toX: number) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: fromX, y: 420 }] })
    for (let step = 1; step <= 5; step += 1) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: fromX + ((toX - fromX) * step) / 5, y: 425 }] })
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  }
  await swipe(300, 80)
  await expect(lightbox).toHaveAttribute('data-index', '3')
  await swipe(80, 320)
  await expect(lightbox).toHaveAttribute('data-index', '2')
  // Not a swipe: mostly vertical.
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 200, y: 300 }] })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 140, y: 520 }] })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await expect(lightbox).toHaveAttribute('data-index', '2')
  await cdp.detach()
  for (const id of ['gallery-prev', 'gallery-next', 'gallery-lightbox-close', 'gallery-lightbox-jump']) {
    await expect(phone.page.getByTestId(id)).toBeInViewport({ ratio: 1 })
  }
  await phone.page.getByTestId('gallery-lightbox-close').tap()
  await phone.page.getByTestId('gallery-tab-links').tap()
  await expect(phone.page.getByTestId('gallery-link')).toHaveCount(20)
  expect(await phone.page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await phone.page.getByTestId('gallery-close').tap()
  await expect(panel).toHaveCount(0)
})
