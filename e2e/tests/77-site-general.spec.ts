/**
 * V10: Trio is for any group that runs its own server, and /indir is its
 * public site. Search engines may read the site and not the app; the two
 * readers (invited, or setting up a server) each have a keyboard path; the
 * demos show a group, not three friends; and no "three friends" sentence is
 * left anywhere in the built client except the changelog's history.
 */
import fs from 'node:fs'
import path from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import { FakeGitHub, UA, serverWithFake } from '../lib/downloads'
import { openLanding, scrollThrough } from '../lib/landing'
import { baseUrl, WEB_DIR } from '../lib/server'

const fake = new FakeGitHub()

test.beforeAll(async () => {
  await fake.start()
  await serverWithFake(fake)
})
test.afterAll(async () => {
  await fake.stop()
})

const shot = (name: string) => `screenshots/${name}`

test('robots.txt, sitemap.xml, canonical and JSON-LD are served, absolute and valid', async ({ request }) => {
  const origin = baseUrl()
  const robots = await request.get(`${origin}/robots.txt`)
  expect(robots.status()).toBe(200)
  expect(robots.headers()['content-type']).toMatch(/^text\/plain/)
  const rules = (await robots.text()).split('\n')
  expect(rules[0]).toBe('User-agent: *')
  for (const rule of ['Allow: /indir', 'Disallow: /api/', 'Disallow: /ws', 'Disallow: /indir/dosya/'])
    expect(rules).toContain(rule)
  expect(rules).not.toContain('Disallow: /')
  expect(rules).toContain(`Sitemap: ${origin}/sitemap.xml`)

  const sitemap = await request.get(`${origin}/sitemap.xml`)
  expect(sitemap.status()).toBe(200)
  expect(sitemap.headers()['content-type']).toMatch(/^application\/xml/)
  const xml = await sitemap.text()
  expect(xml).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>/)
  expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')
  expect([...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])).toEqual([`${origin}/indir`])

  const html = await (await request.get(`${origin}/indir`)).text()
  expect(html).toContain('<html lang="tr">')
  expect(html).toContain(`<link rel="canonical" href="${origin}/indir"`)
  expect(html).toContain('<title>Trio — grubunun sohbeti, kendi sunucunda</title>')
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
  expect(blocks).toHaveLength(1)
  const data = JSON.parse(blocks[0][1]) as Record<string, unknown>
  expect(data['@context']).toBe('https://schema.org')
  expect(data['@type']).toBe('SoftwareApplication')
  expect(data.name).toBe('Trio')
  expect(data.url).toBe(`${origin}/indir`)
  expect(data.image).toBe(`${origin}/og/trio-og.png`)
  expect(data.inLanguage).toBe('tr')
  expect(data.isAccessibleForFree).toBe(true)
  expect(String(data.description).length).toBeGreaterThan(60)
  // Only true fields: no ratings, no reviews, no price.
  for (const key of ['aggregateRating', 'review', 'offers']) expect(data).not.toHaveProperty(key)
  // The image it names is there.
  expect((await request.get(String(data.image))).status()).toBe(200)
})

test('the site is indexable; the app shell, a sign-in screen, is not', async ({ request }) => {
  const origin = baseUrl()
  const site = await request.get(`${origin}/indir`)
  expect(site.headers()['x-robots-tag']).toBeUndefined()
  const siteHtml = await site.text()
  expect(siteHtml).toContain('<meta name="robots" content="index, follow"')
  expect(siteHtml).not.toMatch(/noindex/)
  for (const path of ['/', '/kanal/1']) {
    const shell = await request.get(`${origin}${path}`)
    expect(shell.status()).toBe(200)
    expect(shell.headers()['x-robots-tag']).toBe('noindex')
    expect(await shell.text()).toContain('<meta name="robots" content="noindex"')
  }
})

test('under the real CSP: the JSON-LD is in the page, nothing is blocked, the outline is sound', async ({
  browser,
}) => {
  const v = await openLanding(browser, { userAgent: UA.windows })
  const { page } = v
  await expect(page.getByTestId('indir-primary')).toBeVisible()
  // The data block is in the DOM and parses there too (a browser does not execute it).
  const parsed = await page.evaluate(() => {
    const el = document.querySelector('script[type="application/ld+json"]')
    return el ? (JSON.parse(el.textContent ?? '') as { '@type': string }) : null
  })
  expect(parsed?.['@type']).toBe('SoftwareApplication')
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('tr')
  // One h1, then h2s; no h3 before the first h2, and no level skipped.
  const levels = await page.evaluate(() =>
    [...document.querySelectorAll('main h1, main h2, main h3, main h4')].map((h) => Number(h.tagName[1])),
  )
  expect(levels.filter((l) => l === 1)).toHaveLength(1)
  expect(levels[0]).toBe(1)
  for (let i = 1; i < levels.length; i++) expect(levels[i] - levels[i - 1]).toBeLessThanOrEqual(1)
  expect(await page.locator('h1').textContent()).toContain('kendi sunucunda')
  await v.close() // asserts no CSP violation
})

async function tabTo(page: Page, testId: string, max = 80): Promise<number> {
  for (let i = 1; i <= max; i++) {
    await page.keyboard.press('Tab')
    if (await page.evaluate((id) => (document.activeElement as HTMLElement | null)?.dataset.testid === id, testId))
      return i
  }
  throw new Error(`${testId} not reached by Tab`)
}

test('keyboard: the invited reader reaches the download first, the other one the server set-up', async ({
  browser,
}) => {
  const v = await openLanding(browser, { userAgent: UA.windows })
  const { page } = v
  await expect(page.getByTestId('indir-primary')).toBeVisible()
  // (a) Invited: the primary button comes before the set-up link.
  const toPrimary = await tabTo(page, 'indir-primary')
  const toOwn = toPrimary + (await tabTo(page, 'indir-own-server'))
  expect(toPrimary).toBeLessThan(toOwn)
  await expect(page.getByTestId('indir-own-server')).toHaveText(/Kendi sunucunu kur/)
  // (b) Setting up: Enter goes to the section, and the next stop is inside it, the README's steps.
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/#sunucu$/)
  await expect(page.locator('#sunucu')).toBeInViewport()
  await tabTo(page, 'own-setup-guide', 4)
  const guide = page.getByTestId('own-setup-guide')
  await expect(guide).toHaveAttribute('href', 'https://github.com/borankaraduman-star/Trio#kendi-sunucunu-kur')
  const outline = await guide.evaluate((el) => getComputedStyle(el).outlineStyle)
  expect(outline).not.toBe('none')
  // The section says what it takes and how big a group it is for, honestly.
  const own = page.getByTestId('own-server')
  await expect(own.locator('.own-steps > li')).toHaveCount(5)
  await expect(own).toContainText('10–15 kişilik')
  await expect(own).toContainText('8 kişiye kadar')
  await expect(own).toContainText('TRIO_INVITE_CODE')
  await expect(own).toContainText('/data')
  // The nav reaches it too, and the join screen has its way here.
  await expect(page.locator('.top-nav a[href="#sunucu"]')).toHaveText('Kendi sunucun')
  await v.close()

  const join = await openLanding(browser, { userAgent: UA.windows, path: '/' })
  await expect(join.page.getByTestId('join-form')).toBeVisible()
  await expect(join.page.getByTestId('join-about')).toHaveText('Trio nedir?')
  await expect(join.page.getByTestId('join-about')).toHaveAttribute('href', '/indir')
  await expect(join.page.locator('.join-lead')).not.toContainText('Arkadaş')
  await join.close()
})

test('the demos show a group: more than three people across them, five in the voice room', async ({ browser }) => {
  const v = await openLanding(browser, { userAgent: UA.windows, reducedMotion: 'reduce' })
  const { page } = v
  const names = new Set<string>()
  const add = async (selector: string) => {
    for (const text of await page.locator(selector).allTextContents()) names.add(text.replace(/\(sen\)/, '').trim())
  }
  await add('[data-demo="hero"] .dw-msg-meta b')
  // A voice-list row is an avatar (its initial) and the name, a text node.
  for (const name of await page
    .getByTestId('hero-voice-list')
    .locator('li')
    .evaluateAll((rows) => rows.map((row) => row.lastChild?.textContent ?? '')))
    names.add(name.trim())
  await add('[data-demo="voice"] .vr-name')
  await add('[data-demo="music"] .mu-who b')
  expect(await page.getByTestId('hero-voice-list').locator('li').count()).toBe(5)
  expect(await page.locator('[data-demo="voice"] .vr-tile').count()).toBe(5)
  expect(await page.locator('[data-demo="music"] .mu-row').count()).toBeGreaterThan(3)
  names.delete('')
  expect([...names].sort()).toEqual(['Barış', 'Deniz', 'Ece', 'Melis', 'Ozan', 'Selin'])
  // The server picture: five devices on one server, not three.
  const devices = page.getByTestId('vignette-server').locator('[data-device]')
  await expect(devices).toHaveCount(5)
  await v.close()
})

test('no "three friends" sentence left in the built client, except the changelog’s history', () => {
  const dist = path.join(WEB_DIR, 'dist')
  const changelog = fs.readFileSync(path.join(WEB_DIR, 'src', 'changelog.ts'), 'utf8')
  const pattern = /üç arkadaş|üç beş arkadaş|three friends|üç kişiyiz|arkadaşının kurduğu|friends' server/giu
  // The changelog keeps its old entries word for word (they describe what was): those literals are allowed.
  // Each one: the string literal around a match, from its opening quote to the same quote again.
  const allowed = [...changelog.matchAll(pattern)].map((m) => {
    const quote = /['"`]/
    let start = m.index
    while (start > 0 && !quote.test(changelog[start - 1])) start--
    const end = changelog.indexOf(changelog[start - 1], m.index)
    return changelog.slice(start, end)
  })
  expect(allowed.length).toBeGreaterThan(0)
  const files: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(html|js|css|webmanifest|json|txt|svg)$/.test(entry.name)) files.push(full)
    }
  }
  walk(dist)
  expect(files.some((f) => f.endsWith('indir.html'))).toBe(true)
  const found: string[] = []
  for (const file of files) {
    let text = fs.readFileSync(file, 'utf8')
    for (const literal of allowed) text = text.split(literal).join('')
    for (const m of text.matchAll(pattern))
      found.push(`${path.relative(dist, file)}: …${text.slice(Math.max(0, m.index - 30), m.index + 40)}…`)
  }
  expect(found).toEqual([])
})

test('screenshots at 390, 768 and 1440, and the set-up section', async ({ browser }) => {
  test.setTimeout(120_000)
  for (const [width, height] of [
    [390, 844],
    [768, 1024],
    [1440, 900],
  ] as const) {
    const v = await openLanding(browser, {
      userAgent: width === 390 ? UA.android : UA.windows,
      width,
      height,
      isMobile: width === 390,
    })
    const { page } = v
    await expect(page.locator('[data-demo="hero"] .dw')).toBeVisible()
    await scrollThrough(page)
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
    await page.waitForTimeout(500)
    await page.screenshot({ path: shot(`v10-site-${width}.png`), fullPage: true })
    await page.screenshot({ path: shot(`v10-site-${width}-top.png`) })
    await page.evaluate(() => document.getElementById('sunucu')?.scrollIntoView({ block: 'start', behavior: 'instant' }))
    await page.waitForTimeout(500)
    await page.getByTestId('own-server').screenshot({ path: shot(`v10-site-own-${width}.png`) })
    await v.close()
    if (width === 1440) {
      // The hero's window in its last picture, at 2x: the source of the link-preview image (design/tools/build_og.py).
      const sharp = await openLanding(browser, { userAgent: UA.windows, width, height, deviceScaleFactor: 2 })
      const hero = sharp.page.locator('[data-demo="hero"]')
      await expect(hero.locator('.dw')).toBeVisible()
      for (let i = 0; i < 80 && (await hero.getAttribute('data-step')) !== (await hero.getAttribute('data-last')); i++)
        await sharp.page.waitForTimeout(500)
      await hero.getByTestId('demo-pause').click()
      await sharp.page.waitForTimeout(800)
      await hero.locator('.dw').screenshot({ path: shot('v10-site-hero-window.png') })
      await sharp.close()
    }
  }
  const join = await openLanding(browser, { userAgent: UA.windows, width: 1280, height: 860, path: '/' })
  await expect(join.page.getByTestId('join-about')).toBeVisible()
  await join.page.waitForTimeout(900)
  await join.page.screenshot({ path: shot('v10-site-join.png') })
  await join.close()
})
