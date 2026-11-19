import type { Page } from '@playwright/test'
import { freshServer } from '../lib/server'
import { expect, joinVoice, personViaApi, test } from '../lib/trio'
import { settingsTab } from '../lib/v7phone'

test.beforeEach(async () => {
  await freshServer()
})

const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }

async function expectNoSideScroll(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
}

/** The element's box is inside the 390 px wide screen. */
async function expectWithinWidth(page: Page, testId: string): Promise<void> {
  for (const box of await page.getByTestId(testId).evaluateAll((elements) => elements.map((e) => e.getBoundingClientRect().toJSON()))) {
    expect(box.left).toBeGreaterThanOrEqual(0)
    expect(box.right).toBeLessThanOrEqual(390)
  }
}

test('phone width: attachments and the settings dialog are usable at 390 px', async ({ browser, trio }) => {
  const ayse = trio.add(await personViaApi(browser, 'Ayşe'))
  const phone = trio.add(await personViaApi(browser, 'Mehmet', PHONE))
  const png = Buffer.from(
    await ayse.page.evaluate(() => {
      const canvas = document.createElement('canvas')
      canvas.width = 1200
      canvas.height = 800
      const g = canvas.getContext('2d')!
      g.fillStyle = '#0ea5a4'
      g.fillRect(0, 0, 1200, 800)
      return canvas.toDataURL('image/png').split(',')[1]
    }),
    'base64',
  )

  const [pngWidth, pngHeight] = [1200, 800]

  // Attaching on the phone: the paperclip opens the file picker; the chips fit.
  const chooser = phone.page.waitForEvent('filechooser')
  await phone.page.getByTestId('btn-attach').tap()
  await (await chooser).setFiles([
    { name: 'manzara-cok-uzun-bir-dosya-adi-olan-fotograf.png', mimeType: 'image/png', buffer: png },
    { name: 'otel-rezervasyonu.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%trio\n') },
  ])
  await expect(phone.page.locator('[data-testid="pending-attachment"][data-status="done"]')).toHaveCount(2)
  await expect(phone.page.getByTestId('pending-attachment').first()).toBeInViewport({ ratio: 1 })
  await expect(phone.page.getByTestId('composer-send')).toBeInViewport({ ratio: 1 })
  await expect(phone.page.getByTestId('btn-attach')).toBeInViewport({ ratio: 1 })
  await expectNoSideScroll(phone.page)
  await phone.page.getByTestId('composer').tap()
  await phone.page.getByTestId('composer').fill('telefondan iki dosya')
  await phone.page.getByTestId('composer-send').tap()
  await expect(ayse.page.getByTestId('attachment-image')).toHaveCount(1)

  // Ayşe's image and file as the phone shows them: inside the screen, the image box narrower than 400.
  await ayse.page.getByTestId('file-input').setInputFiles({ name: 'notlar.txt', mimeType: 'text/plain', buffer: Buffer.from('not') })
  await expect(ayse.page.locator('[data-testid="pending-attachment"][data-status="done"]')).toHaveCount(1)
  await ayse.page.getByTestId('composer').fill('masaüstünden bir dosya')
  await ayse.page.getByTestId('composer').press('Enter')
  await expect(phone.page.getByTestId('attachment-file')).toHaveCount(2)
  await expectWithinWidth(phone.page, 'attachment-image')
  await expectWithinWidth(phone.page, 'attachment-file')
  const box = (await phone.page.getByTestId('attachment-image').boundingBox())!
  // V6: the box has the picture's own shape (its size comes from the server), narrower than 400.
  expect(box.width).toBeLessThan(400)
  expect(Math.abs(box.height - (box.width * pngHeight) / pngWidth)).toBeLessThanOrEqual(1)
  await expectNoSideScroll(phone.page)

  // The lightbox fits the screen and closes with its button.
  await phone.page.getByTestId('attachment-image').tap()
  const lightbox = phone.page.getByTestId('lightbox')
  await expect(lightbox).toBeVisible()
  const image = (await lightbox.locator('img').boundingBox())!
  expect(image.x).toBeGreaterThanOrEqual(0)
  expect(image.x + image.width).toBeLessThanOrEqual(390)
  await expect(phone.page.getByTestId('lightbox-close')).toBeInViewport({ ratio: 1 })
  await phone.page.getByTestId('lightbox-close').tap()
  await expect(lightbox).toHaveCount(0)

  // Settings: opened from the drawer, every control on screen or reachable by scrolling the dialog.
  await phone.page.getByTestId('btn-drawer').tap()
  await joinVoice(phone)
  await phone.page.getByTestId('btn-settings').tap()
  const dialog = phone.page.getByTestId('settings-dialog')
  await expect(dialog).toBeVisible()
  const frame = (await dialog.boundingBox())!
  expect(frame.x).toBeGreaterThanOrEqual(0)
  expect(frame.x + frame.width).toBeLessThanOrEqual(390)
  expect(frame.y).toBeGreaterThanOrEqual(0)
  expect(frame.y + frame.height).toBeLessThanOrEqual(844)
  await expect(phone.page.getByTestId('settings-close')).toBeInViewport({ ratio: 1 })
  for (const [tab, id] of [
    ['goruntu', 'settings-camera'],
    ['ses', 'settings-mic'],
    ['ses', 'settings-output'],
    ['ses', 'settings-noise'],
    ['ses', 'settings-mode-ptt'],
  ] as const) {
    await settingsTab(phone.page, tab)
    const control = phone.page.getByTestId(id)
    await control.scrollIntoViewIfNeeded()
    await expect(control).toBeInViewport({ ratio: 1 })
  }
  await phone.page.getByTestId('settings-mode-ptt').tap()
  await phone.page.getByTestId('settings-ptt-bind').scrollIntoViewIfNeeded()
  await expect(phone.page.getByTestId('settings-ptt-bind')).toBeInViewport({ ratio: 1 })
  await expectWithinWidth(phone.page, 'settings-ptt-bind')
  await expectNoSideScroll(phone.page)
  await phone.page.getByTestId('settings-mode-activity').tap()
  await phone.page.getByTestId('settings-close').tap()
  await expect(dialog).toHaveCount(0)
})
