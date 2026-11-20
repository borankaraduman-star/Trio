/**
 * V9: the live demos on /indir. Each one advances by itself, stops when it is
 * off screen or the tab is hidden, answers its control, and stands still under
 * reduced motion with its steps by hand. Frames across time are saved for a
 * person to judge the motion.
 */
import { test, expect, type Locator, type Page } from '@playwright/test'
import { FakeGitHub, UA, serverWithFake } from '../lib/downloads'
import { demoStep, openLanding } from '../lib/landing'

const fake = new FakeGitHub()

test.beforeAll(async () => {
  await fake.start()
  await serverWithFake(fake)
})
test.afterAll(async () => {
  await fake.stop()
})

/** The steps a demo goes through in `ms`, sampled every 150 ms. */
async function stepsSeen(demo: Locator, ms: number): Promise<Set<number>> {
  const seen = new Set<number>()
  const end = Date.now() + ms
  while (Date.now() < end) {
    seen.add(await demoStep(demo))
    await demo.page().waitForTimeout(150)
  }
  return seen
}

async function bringIntoView(page: Page, demo: Locator) {
  await demo.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }))
  await expect(demo).toHaveAttribute('data-playing', 'true')
}

test('every demo advances by itself while on screen', async ({ browser }) => {
  const v = await openLanding(browser, { userAgent: UA.windows })
  const { page } = v
  for (const name of ['hero', 'voice', 'music', 'phone']) {
    const demo = page.locator(`[data-demo="${name}"]`)
    await bringIntoView(page, demo)
    expect((await stepsSeen(demo, 4500)).size, `${name} moved`).toBeGreaterThanOrEqual(2)
  }
  // The hero's messages arrive: more of them after a while than at the start.
  const hero = page.locator('[data-demo="hero"]')
  await bringIntoView(page, hero)
  await expect.poll(() => hero.locator('.dw-msg').count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(5)
  await v.close()
})

test('a demo stops off screen and while the tab is hidden, and goes on when it is back', async ({ browser }) => {
  const v = await openLanding(browser, { userAgent: UA.windows })
  const { page } = v
  const voice = page.locator('[data-demo="voice"]')
  await bringIntoView(page, voice)
  await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }))
  await expect(voice).toHaveAttribute('data-playing', 'false')
  const held = await demoStep(voice)
  expect(await stepsSeen(voice, 3500)).toEqual(new Set([held]))
  // Its CSS loops stop too.
  const running = await voice.evaluate(
    (el) => el.getAnimations({ subtree: true }).filter((a) => a.playState === 'running').length,
  )
  expect(running).toBe(0)
  await bringIntoView(page, voice)
  expect((await stepsSeen(voice, 4000)).size).toBeGreaterThanOrEqual(2)

  // The tab goes to the background.
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect(voice).toHaveAttribute('data-playing', 'false')
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect(voice).toHaveAttribute('data-playing', 'true')

  // The visitor's own pause button.
  await voice.getByTestId('demo-pause').click()
  await expect(voice).toHaveAttribute('data-playing', 'false')
  await expect(voice.getByTestId('demo-pause')).toHaveText('Oynat')
  const paused = await demoStep(voice)
  expect(await stepsSeen(voice, 3000)).toEqual(new Set([paused]))
  await voice.getByTestId('demo-pause').click()
  await expect(voice).toHaveAttribute('data-playing', 'true')
  await v.close()
})

test('the demos answer the visitor: chat, mute, volumes, phone view, share profile', async ({ browser }) => {
  const v = await openLanding(browser, { userAgent: UA.windows })
  const { page } = v

  // Write into the hero's chat; Ozan answers.
  const hero = page.locator('[data-demo="hero"]')
  await page.getByTestId('hero-composer').fill('Ben de geliyorum, kahve bende')
  await page.getByTestId('hero-composer').press('Enter')
  await expect(hero.getByTestId('hero-visitor-message').first()).toContainText('Ben de geliyorum, kahve bende')
  await expect(hero.getByTestId('hero-visitor-message')).toHaveCount(2, { timeout: 5000 })
  await expect(page.getByTestId('hero-composer')).toHaveValue('')

  // Mute yourself; Ozan's volume to 150 %.
  const voice = page.locator('[data-demo="voice"]')
  await bringIntoView(page, voice)
  await voice.getByTestId('voice-mute').click()
  await expect(voice).toHaveAttribute('data-muted', 'true')
  await expect(voice.getByTestId('voice-mute')).toHaveAttribute('aria-pressed', 'true')
  await expect(voice.getByTestId('voice-tile-Deniz').locator('.vr-muted')).toHaveCount(1)
  await expect
    .poll(() => voice.getByTestId('voice-tile-Deniz').getAttribute('data-speaking'), { timeout: 12_000 })
    .toBe('false')
  await voice.getByTestId('voice-volume').fill('150')
  await expect(voice.locator('.vr-slider output')).toHaveText('%150')

  // The music's level for yourself.
  const music = page.locator('[data-demo="music"]')
  await bringIntoView(page, music)
  await music.getByTestId('music-volume').fill('80')
  await expect(music.getByTestId('music-level')).toHaveText('%80')
  await expect(music).toHaveAttribute('data-level', '80')
  await music.getByTestId('music-volume').fill('0')
  await expect(music.getByTestId('music-level')).toHaveText('Sessiz')

  // The phone: the app, then the lock screen.
  const phone = page.locator('[data-demo="phone"]')
  await bringIntoView(page, phone)
  await phone.getByTestId('phone-show-app').click()
  await expect(phone).toHaveAttribute('data-view', 'app')
  await expect(phone.getByTestId('phone-callbar')).toContainText('Konuşuyor:')
  await phone.getByTestId('phone-show-lock').click()
  await expect(phone).toHaveAttribute('data-view', 'lock')
  await expect(phone.locator('.ph-note')).toHaveCount(3)

  // Screen-share profiles.
  const share = page.getByTestId('vignette-share')
  await share.getByTestId('share-profile-game').click()
  await expect(share).toHaveAttribute('data-profile', 'game')
  await expect(share.getByTestId('share-profile-hint')).toContainText('60 kare/sn')
  await v.close()
})

test('reduced motion: nothing moves, each demo shows its whole picture and steps by hand', async ({ browser }) => {
  const v = await openLanding(browser, { userAgent: UA.windows, reducedMotion: 'reduce' })
  const { page } = v
  await expect(page.getByTestId('indir')).toHaveAttribute('data-motion', 'reduced')
  for (const name of ['hero', 'voice', 'music', 'phone']) {
    const demo = page.locator(`[data-demo="${name}"]`)
    await demo.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }))
    await expect(demo).toHaveAttribute('data-reduced', 'true')
    await expect(demo).toHaveAttribute('data-playing', 'false')
    const last = Number(await demo.getAttribute('data-last'))
    expect(await demoStep(demo)).toBe(last)
    expect(await stepsSeen(demo, 1500)).toEqual(new Set([last]))
    // By hand: back one step, then forward again.
    await demo.getByRole('button', { name: /önceki adım/ }).click()
    expect(await demoStep(demo)).toBe(last - 1)
    await demo.getByRole('button', { name: /sonraki adım/ }).click()
    expect(await demoStep(demo)).toBe(last)
  }
  // The hero's complete picture: every message, the photo, the reaction.
  await expect(page.locator('[data-demo="hero"] .dw-msg')).toHaveCount(6)
  await expect(page.locator('[data-demo="hero"] .dw-reaction')).toBeVisible()
  await page.waitForTimeout(500)
  const running = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length)
  expect(running).toBe(0)
  // Nothing is left hidden for a reveal that never comes.
  const hidden = await page.evaluate(
    () => [...document.querySelectorAll('[data-reveal]')].filter((el) => getComputedStyle(el).opacity !== '1').length,
  )
  expect(hidden).toBe(0)
  await v.close()
})

test('frames across time of each demo, for a person to judge', async ({ browser }) => {
  test.setTimeout(120_000)
  const v = await openLanding(browser, { userAgent: UA.windows, width: 1440, height: 900 })
  const { page } = v
  for (const name of ['hero', 'voice', 'music', 'phone']) {
    const demo = page.locator(`[data-demo="${name}"]`)
    await bringIntoView(page, demo)
    await demo.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }))
    await page.waitForTimeout(1200) // its reveal has finished
    let elapsed = 0
    for (const t of [0, 1, 3, 6]) {
      await page.waitForTimeout((t - elapsed) * 1000)
      elapsed = t
      await demo.screenshot({ path: `screenshots/v9-frames-${name}-${t}s.png` })
    }
  }
  await v.close()
})
