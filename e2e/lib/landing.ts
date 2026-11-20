/**
 * V9: the public page /indir as a site, in the e2e suite. Opens it as a given
 * system, at a given width, with or without reduced motion, honouring the
 * suite's slow mode (TRIO_E2E_CPU_THROTTLE), and collects CSP violations.
 */
import type { Browser, BrowserContext, Locator, Page } from '@playwright/test'
import { expect } from '@playwright/test'
import { baseUrl } from './server'

export interface Landing {
  context: BrowserContext
  page: Page
  close(): Promise<void>
}

export async function openLanding(
  browser: Browser,
  options: {
    userAgent: string
    width?: number
    height?: number
    isMobile?: boolean
    reducedMotion?: 'reduce' | 'no-preference'
    path?: string
    deviceScaleFactor?: number
  },
): Promise<Landing> {
  const context = await browser.newContext({
    baseURL: baseUrl(),
    userAgent: options.userAgent,
    viewport: { width: options.width ?? 1440, height: options.height ?? 900 },
    isMobile: options.isMobile,
    deviceScaleFactor: options.deviceScaleFactor,
    hasTouch: options.isMobile,
    reducedMotion: options.reducedMotion ?? 'no-preference',
    locale: 'tr-TR',
    timezoneId: 'Europe/Istanbul',
  })
  const csp: string[] = []
  await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      console.error(`CSP-VIOLATION ${event.effectiveDirective} ${event.blockedURI}`)
    })
    // Layout shifts, summed as CLS counts them (no input in the last 500 ms).
    ;(window as unknown as { __cls: number }).__cls = 0
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as unknown as { value: number; hadRecentInput: boolean }[]) {
        if (!entry.hadRecentInput) (window as unknown as { __cls: number }).__cls += entry.value
      }
    }).observe({ type: 'layout-shift', buffered: true })
  })
  context.on('console', (message) => {
    if (message.type() === 'error' && /CSP-VIOLATION|Content Security Policy/.test(message.text()))
      csp.push(message.text())
  })
  const page = await context.newPage()
  const throttle = Number(process.env.TRIO_E2E_CPU_THROTTLE ?? 0)
  if (throttle > 1) {
    const cdp = await context.newCDPSession(page)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle })
  }
  await page.goto(options.path ?? '/indir')
  return {
    context,
    page,
    async close() {
      await context.close()
      expect(csp, 'no CSP violation on the page').toEqual([])
    },
  }
}

/** A demo's current step (its root's data-step). */
export async function demoStep(demo: Locator): Promise<number> {
  return Number(await demo.getAttribute('data-step'))
}

/** Scroll the whole page through once, so every scroll reveal has run. */
export async function scrollThrough(page: Page): Promise<void> {
  const height = await page.evaluate(() => document.documentElement.scrollHeight)
  const viewport = page.viewportSize()?.height ?? 800
  for (let y = 0; y < height; y += Math.round(viewport * 0.6)) {
    await page.evaluate((top) => window.scrollTo({ top, behavior: 'instant' }), y)
    await page.waitForTimeout(120)
  }
  await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }))
  await page.waitForTimeout(1000)
}

export async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
}
