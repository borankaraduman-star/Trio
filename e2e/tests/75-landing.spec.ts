/**
 * V9: /indir as Trio's public site. Layout at three widths, the hero that does
 * not jump, the primary button per system, the keyboard order, link previews,
 * and the screenshots the owner looks at.
 */
import { test, expect } from '@playwright/test'
import { FakeGitHub, UA, serverWithFake } from '../lib/downloads'
import { horizontalOverflow, openLanding, scrollThrough } from '../lib/landing'
import { baseUrl } from '../lib/server'

const fake = new FakeGitHub()

test.beforeAll(async () => {
  await fake.start()
})
test.afterAll(async () => {
  await fake.stop()
})
test.beforeEach(async () => {
  fake.mode = 'ok'
  fake.signing = null
  await serverWithFake(fake)
})

const shot = (name: string) => `screenshots/${name}`

test('390, 768 and 1440: nothing wider than the screen, the hero demo in place, screenshots', async ({ browser }) => {
  for (const [width, height, name] of [
    [390, 844, 'v9-landing-390.png'],
    [768, 1024, 'v9-landing-768.png'],
    [1440, 900, null],
  ] as const) {
    const v = await openLanding(browser, { userAgent: UA.windows, width, height })
    const { page } = v
    await expect(page.getByTestId('indir-primary')).toBeVisible()
    await expect(page.locator('[data-demo="hero"] .dw')).toBeVisible()
    expect(await horizontalOverflow(page), `overflow at ${width}`).toBeLessThanOrEqual(0)
    await scrollThrough(page)
    expect(await horizontalOverflow(page), `overflow at ${width} after scrolling`).toBeLessThanOrEqual(0)
    if (name) {
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
      await page.waitForTimeout(400)
      await page.screenshot({ path: shot(name), fullPage: true })
    }
    await v.close()
  }
})

test('the hero does not jump: its box is fixed before the files arrive, and CLS stays near zero', async ({
  browser,
}) => {
  const v = await openLanding(browser, { userAgent: UA.windows, width: 1440, height: 900 })
  const { page } = v
  const stage = page.locator('.hero-stage')
  await expect(stage).toBeVisible()
  // Layout boxes (offset sizes), not the painted ones: the entrance scales the stage for a moment.
  const box = () => stage.evaluate((el: HTMLElement) => ({ w: el.offsetWidth, h: el.offsetHeight, top: el.offsetTop }))
  const before = await box()
  await expect(page.getByTestId('indir-primary')).toBeVisible()
  await page.waitForTimeout(2500) // the entrance and a few demo steps
  expect(await box()).toEqual(before)
  // The demo window has an explicit height; the messages arriving inside it move nothing outside.
  const cls = await page.evaluate(() => (window as unknown as { __cls: number }).__cls)
  expect(cls).toBeLessThan(0.05)
  await page.screenshot({ path: shot('v9-landing-hero.png') })
  await v.close()
})

test('the primary button is the visitor’s system; a phone gets the browser instead', async ({ browser }) => {
  for (const [ua, platform] of [
    [UA.windows, 'windows'],
    [UA.linux, 'linux'],
  ] as const) {
    const v = await openLanding(browser, { userAgent: ua })
    await expect(v.page.getByTestId('indir-primary')).toHaveAttribute('data-platform', platform)
    await expect(v.page.getByTestId('indir-primary')).toHaveAttribute('href', `/indir/dosya/${platform}`)
    await v.close()
  }
  const mac = await openLanding(browser, { userAgent: UA.mac })
  expect(['mac-arm64', 'mac-x64']).toContain(await mac.page.getByTestId('indir-primary').getAttribute('data-platform'))
  await mac.close()
  const phone = await openLanding(browser, { userAgent: UA.iphone, width: 390, height: 844, isMobile: true })
  await expect(phone.page.getByTestId('indir-phone')).toBeVisible()
  await expect(phone.page.getByTestId('indir-primary')).toHaveCount(0)
  expect(await horizontalOverflow(phone.page)).toBeLessThanOrEqual(0)
  await phone.close()
})

test('keyboard: download, then the browser link, then the platform list', async ({ browser }) => {
  const v = await openLanding(browser, { userAgent: UA.windows })
  const { page } = v
  await expect(page.getByTestId('indir-primary')).toBeVisible()
  await expect(page.getByTestId('indir-files')).toBeVisible()
  const order: string[] = []
  for (let i = 0; i < 60 && !order.includes('file'); i++) {
    await page.keyboard.press('Tab')
    const what = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null
      if (!el) return ''
      if (el.dataset.testid === 'indir-primary') return 'primary'
      if (el.dataset.testid === 'indir-browser') return 'browser'
      if (el.closest('[data-testid="indir-files"]')) return 'file'
      return ''
    })
    if (what && !order.includes(what)) order.push(what)
  }
  expect(order).toEqual(['primary', 'browser', 'file'])
  // The focused primary button shows a focus ring.
  await page.getByTestId('indir-primary').focus()
  const outline = await page.getByTestId('indir-primary').evaluate((el) => getComputedStyle(el).outlineStyle)
  expect(outline).not.toBe('none')
  await v.close()
})

test('link previews: meta tags with absolute addresses, the 1200×630 image served from here', async ({ request }) => {
  const html = await (await request.get(`${baseUrl()}/indir`)).text()
  const origin = baseUrl()
  expect(html).toContain(`<meta property="og:image" content="${origin}/og/trio-og.png"`)
  expect(html).toContain(`<meta property="og:url" content="${origin}/indir"`)
  expect(html).toContain('<meta name="twitter:card" content="summary_large_image"')
  expect(html).toContain('<meta name="robots" content="noindex, nofollow"')
  expect(html).toMatch(/<meta property="og:title" content="[^"]+"/)
  expect(html).toMatch(/<meta name="description" content="[^"]{60,}"/)
  const image = await request.get(`${origin}/og/trio-og.png`)
  expect(image.status()).toBe(200)
  expect(image.headers()['content-type']).toBe('image/png')
  const bytes = await image.body()
  // PNG: the IHDR chunk holds width and height, big-endian, at bytes 16 and 20.
  expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG')
  expect(bytes.readUInt32BE(16)).toBe(1200)
  expect(bytes.readUInt32BE(20)).toBe(630)
})

test('screenshots: features and download sections at 1440', async ({ browser }) => {
  const v = await openLanding(browser, { userAgent: UA.windows, width: 1440, height: 900 })
  const { page } = v
  await expect(page.getByTestId('indir-files')).toBeVisible()
  await scrollThrough(page)
  await page.locator('#oda').scrollIntoViewIfNeeded()
  await page.evaluate(() => document.getElementById('oda')?.scrollIntoView({ block: 'start', behavior: 'instant' }))
  await page.waitForTimeout(3000)
  await page.screenshot({ path: shot('v9-landing-features.png') })
  await page.evaluate(() => document.getElementById('indir')?.scrollIntoView({ block: 'start', behavior: 'instant' }))
  await page.waitForTimeout(600)
  await page.screenshot({ path: shot('v9-landing-download.png') })
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
  await page.waitForTimeout(300)
  await page.screenshot({ path: shot('v9-landing-full-1440.png'), fullPage: true })
  await v.close()
})

test('the join screen: same hand as the page, every door still there', async ({ browser }) => {
  const v = await openLanding(browser, { userAgent: UA.windows, width: 1280, height: 860, path: '/' })
  const { page } = v
  await expect(page.getByTestId('join-form')).toBeVisible()
  await expect(page.getByTestId('join-mode-invite')).toBeVisible()
  await expect(page.getByTestId('join-mode-link')).toBeVisible()
  await expect(page.getByTestId('download-link')).toHaveAttribute('href', '/indir')
  await page.waitForTimeout(900) // the card's arrival
  await page.screenshot({ path: shot('v9-join.png') })
  await v.close()
  const narrow = await openLanding(browser, { userAgent: UA.android, width: 390, height: 844, isMobile: true, path: '/' })
  await expect(narrow.page.getByTestId('join-form')).toBeVisible()
  expect(await horizontalOverflow(narrow.page)).toBeLessThanOrEqual(0)
  await narrow.close()
})
