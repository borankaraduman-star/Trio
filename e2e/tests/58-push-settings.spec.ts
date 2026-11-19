/**
 * Ayarlar › Bildirimler (CONTRACT-V6-PUSH §6): what each permission state
 * says, the iPhone-in-Safari case with its "Ana ekrana ekle" card, channel
 * levels from the settings and from a channel's context menu, quiet hours —
 * all stored on the server — and the screenshots `v6-push-settings.png`
 * (desktop), `v6-push-settings-390.png` and `v6-push-install-ios.png`.
 */
import path from 'node:path'
import type { BrowserContext, Page } from '@playwright/test'
import { CHROMIUM_ARGS } from '../playwright.config'
import { baseUrl, E2E_DIR, freshServer } from '../lib/server'
import { api, apiJoin, expect, GENEL, personWithSession, SOHBET, test, type Person } from '../lib/trio'
import { FakePushService, fakeSubscriptionScript, NEW_HEADLESS } from '../lib/push'

test.use({ launchOptions: { ...NEW_HEADLESS, args: CHROMIUM_ARGS } })

const OUT = path.join(E2E_DIR, 'screenshots')
const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'

async function openSettings(person: Person): Promise<Page> {
  const page = person.page
  const drawer = page.getByTestId('btn-drawer')
  if (await drawer.isVisible()) await drawer.click()
  await page.getByTestId('btn-settings').click()
  await expect(page.getByTestId('settings-notify')).toBeVisible()
  return page
}

type Prefs = { channels: Record<string, string>; quiet: { enabled: boolean; start: string; end: string; tz: string }; calls: boolean; calls_break_quiet: boolean; voice_rooms: boolean }
const prefsOf = async (person: Person) => (await api<{ prefs: Prefs }>(person.token, '/api/push/prefs')).prefs

test('each permission state explains itself; the iPhone in Safari gets the home-screen steps', async ({ browser, trio }) => {
  await freshServer()
  // Not asked yet. (Headless Chromium reports an un-asked permission as
  // "denied", so the page is told "default", as a real first visit is.)
  const fresh = trio.add(
    await personWithSession(browser, 'Ayşe', await apiJoin('Ayşe'), {
      viewport: { width: 390, height: 844 },
      prepare: async (context) => {
        await context.addInitScript(() => Object.defineProperty(Notification, 'permission', { get: () => 'default' }))
      },
    }),
  )
  let page = await openSettings(fresh)
  await expect(page.getByTestId('notify-state')).toHaveAttribute('data-state', 'default')
  await expect(page.getByTestId('notify-allow')).toBeVisible()
  await expect(page.getByTestId('notify-here')).toHaveCount(0)

  // Denied: how to turn it back on, and nothing to click that cannot work.
  const denied = trio.add(
    await personWithSession(browser, 'Mehmet', await apiJoin('Mehmet'), {
      viewport: { width: 390, height: 844 },
      prepare: async (context) => {
        await context.addInitScript(() => Object.defineProperty(Notification, 'permission', { get: () => 'denied' }))
      },
    }),
  )
  page = await openSettings(denied)
  await expect(page.getByTestId('notify-state')).toHaveAttribute('data-state', 'denied')
  await expect(page.getByTestId('notify-state')).toContainText('site ayarları')
  await expect(page.getByTestId('notify-allow')).toHaveCount(0)

  // An iPhone, in Safari (not from the home screen).
  const iphone = await browser.newContext({
    baseURL: baseUrl(),
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    userAgent: IPHONE_UA,
    locale: 'tr-TR',
    timezoneId: 'Europe/Istanbul',
  })
  const zeynep = trio.add(await personOn(iphone, 'Zeynep'))
  const card = zeynep.page.getByTestId('install-card')
  await expect(card).toHaveAttribute('data-mode', 'ios')
  await expect(card).toContainText('Ana Ekrana Ekle')
  await zeynep.page.screenshot({ path: path.join(OUT, 'v6-push-install-ios.png') })
  page = await openSettings(zeynep)
  await expect(page.getByTestId('notify-state')).toHaveAttribute('data-state', 'ios-needs-home-screen')
  await expect(page.getByTestId('notify-state')).toContainText('ana ekrana eklenip')
  await page.getByTestId('settings-close').click()
  await card.getByTestId('install-card-ok').click()
  await expect(card).toHaveCount(0)
  await zeynep.page.reload()
  await expect(zeynep.page.getByTestId('composer')).toBeVisible()
  await expect(card).toHaveCount(0) // remembered
})

async function personOn(context: BrowserContext, name: string): Promise<Person> {
  const session = await apiJoin(name)
  await context.addInitScript(
    ([t, u]) => {
      localStorage.setItem('trio.token', t)
      localStorage.setItem('trio.user', u)
    },
    [session.token, JSON.stringify(session.user)] as const,
  )
  const page = await context.newPage()
  await page.goto('/')
  await expect(page.getByTestId('composer')).toBeVisible()
  return { name, context, page, user: session.user, token: session.token }
}

test('levels, the channel menu and quiet hours are stored on the server; screenshots', async ({ browser, trio }) => {
  const service = new FakePushService()
  await service.start()
  try {
    await freshServer({ TRIO_TEST_PUSH_SERVICE: service.origin })
    const phone = service.device('ayse')
    const ayse = trio.add(
      await personWithSession(browser, 'Ayşe', await apiJoin('Ayşe'), {
        deviceScaleFactor: 2,
        prepare: async (context) => {
          await context.grantPermissions(['notifications'], { origin: baseUrl() })
          await context.addInitScript(fakeSubscriptionScript(phone))
        },
      }),
    )
    const page = ayse.page
    // From the channel's context menu (right click in the sidebar).
    await page.getByTestId(`channel-${GENEL}`).click({ button: 'right' })
    const menu = page.getByTestId('channel-notify-menu')
    await expect(menu).toBeVisible()
    await expect(menu.getByTestId('channel-notify-all')).toHaveAttribute('aria-checked', 'true')
    await menu.getByTestId('channel-notify-none').click()
    await expect(menu).toHaveCount(0)
    await expect.poll(async () => (await prefsOf(ayse)).channels).toEqual({ [String(GENEL)]: 'none' })

    await openSettings(ayse)
    await expect(page.getByTestId(`notify-level-${GENEL}`)).toHaveValue('none')
    await page.getByTestId(`notify-level-${GENEL}`).selectOption('mentions')
    await page.getByTestId(`notify-level-${SOHBET}`).selectOption('none')
    await expect.poll(async () => (await prefsOf(ayse)).channels).toEqual({ [String(GENEL)]: 'mentions', [String(SOHBET)]: 'none' })
    // A voice room has no "@ben".
    await expect(page.getByTestId(`notify-level-${SOHBET}`).locator('option')).toHaveText(['Hepsi', 'Kapalı'])

    await page.getByTestId('notify-quiet').click()
    await expect(page.getByTestId('notify-quiet')).toBeChecked()
    await page.getByTestId('notify-quiet-start').fill('22:30')
    await page.getByTestId('notify-quiet-start').blur()
    await page.getByTestId('notify-calls-break-quiet').click()
    await expect(page.getByTestId('notify-calls-break-quiet')).toBeChecked()
    await expect
      .poll(async () => {
        const prefs = await prefsOf(ayse)
        return [prefs.quiet, prefs.calls_break_quiet]
      })
      .toEqual([{ enabled: true, start: '22:30', end: '08:00', tz: 'Europe/Istanbul' }, true])
    await page.getByTestId('notify-voice-rooms').click()
    await expect(page.getByTestId('notify-voice-rooms')).not.toBeChecked()
    await expect.poll(async () => (await prefsOf(ayse)).voice_rooms).toBe(false)

    await page.getByTestId('notify-here').click()
    await expect(page.getByTestId('notify-device')).toHaveAttribute('data-here', 'true')
    await page.getByTestId('notify-test').click()
    await expect(page.getByTestId('notify-test-result')).toHaveAttribute('data-ok', 'true')

    // After a reload everything reads back from the server.
    await page.reload()
    await expect(page.getByTestId('composer')).toBeVisible()
    await openSettings(ayse)
    await expect(page.getByTestId(`notify-level-${GENEL}`)).toHaveValue('mentions')
    await expect(page.getByTestId('notify-quiet-start')).toHaveValue('22:30')
    await expect(page.getByTestId('notify-here')).toBeChecked()
    await page.getByTestId('notify-test').click()
    await expect(page.getByTestId('notify-test-result')).toHaveAttribute('data-ok', 'true')

    const section = page.getByTestId('settings-notify')
    await section.scrollIntoViewIfNeeded()
    await section.screenshot({ path: path.join(OUT, 'v6-push-settings.png') })
    await page.setViewportSize({ width: 390, height: 844 })
    await section.scrollIntoViewIfNeeded()
    await section.screenshot({ path: path.join(OUT, 'v6-push-settings-390.png') })

    // Removing the device here turns "Bu cihazda bildir" off.
    const own = await page.getByTestId('notify-device').first().getAttribute('data-here')
    expect(own).toBe('true')
    await page.locator('[data-testid^="notify-device-remove-"]').first().click()
    await expect(page.getByTestId('notify-here')).not.toBeChecked()
    expect((await api<{ subscriptions: unknown[] }>(ayse.token, '/api/push/subscriptions')).subscriptions).toEqual([])
  } finally {
    await service.stop()
  }
})
