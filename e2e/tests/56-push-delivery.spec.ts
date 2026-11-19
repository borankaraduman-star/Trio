/**
 * CONTRACT-V6-PUSH §3-§5 end to end, against a fake push service (lib/push.ts):
 * subscribing from Ayarlar › Bildirimler sends the server a valid subscription,
 * "Deneme bildirimi gönder" reaches the service, and a message reaches it only
 * while Ayşe is NOT looking at the app — encrypted, decryptable with her keys,
 * with the expected title, body and tag. A mention breaks through "Yalnız @ben";
 * a room opening is announced. At 390 px.
 */
import { CHROMIUM_ARGS } from '../playwright.config'
import { baseUrl, freshServer } from '../lib/server'
import { api, apiJoin, expect, GENEL, joinVoice, personViaApi, personWithSession, SOHBET, test, type Person } from '../lib/trio'
import { send } from '../lib/messages'
import { AWAY_SCRIPT, FakePushService, fakeSubscriptionScript, NEW_HEADLESS, setAway, verifyVapid, type FakeDevice } from '../lib/push'
import { settingsTab } from '../lib/v7phone'

test.use({ launchOptions: { ...NEW_HEADLESS, args: CHROMIUM_ARGS } })

const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 }
let service: FakePushService

test.beforeEach(async () => {
  service = new FakePushService()
  await service.start()
  await freshServer({ TRIO_TEST_PUSH_SERVICE: service.origin })
})

test.afterEach(async () => {
  await service.stop()
})

async function openSettings(person: Person): Promise<void> {
  const drawer = person.page.getByTestId('btn-drawer')
  if (await drawer.isVisible()) await drawer.click()
  await person.page.getByTestId('btn-settings').click()
  await settingsTab(person.page, 'bildirimler')
  await expect(person.page.getByTestId('settings-notify')).toBeVisible()
}

async function subscribedPerson(browser: Parameters<typeof personWithSession>[0], name: string, device: FakeDevice): Promise<Person> {
  return personWithSession(browser, name, await apiJoin(name), {
    ...PHONE,
    prepare: async (context) => {
      await context.grantPermissions(['notifications'], { origin: baseUrl() })
      await context.addInitScript(fakeSubscriptionScript(device))
      await context.addInitScript(AWAY_SCRIPT)
    },
  })
}

test('subscribe, test notification, and a message pushed only while not viewing', async ({ browser, trio }) => {
  const phone = service.device('ayse')
  const ayse = trio.add(await subscribedPerson(browser, 'Ayşe', phone))
  const mehmet = trio.add(await personViaApi(browser, 'Mehmet'))

  await openSettings(ayse)
  const page = ayse.page
  await expect(page.getByTestId('notify-state')).toHaveAttribute('data-state', 'granted')
  await page.getByTestId('notify-here').click()
  await expect(page.getByTestId('notify-device')).toHaveAttribute('data-here', 'true')
  await expect(page.getByTestId('notify-device')).toContainText('Linux · Chrome')
  // The server holds a well-formed subscription for this device.
  const listed = await api<{ subscriptions: { id: number; label: string; ua_family: string }[] }>(ayse.token, '/api/push/subscriptions')
  expect(listed.subscriptions).toEqual([expect.objectContaining({ label: 'Linux · Chrome', ua_family: 'chrome' })])

  // "Deneme bildirimi gönder": the service got it, and the page says so.
  await page.getByTestId('notify-test').click()
  await expect(page.getByTestId('notify-test-result')).toContainText('Bildirim servisi kabul etti (HTTP 201)')
  await expect.poll(() => service.to(phone).length).toBe(1)
  const testPush = service.to(phone)[0]
  expect(phone.decrypt(testPush.body)).toMatchObject({ kind: 'test', title: 'Trio — deneme bildirimi', tag: 'test' })
  const { public_key: key } = await api<{ public_key: string }>(ayse.token, '/api/push/key')
  const claims = verifyVapid(testPush.headers.authorization, key)
  expect(claims.aud).toBe(service.origin)
  expect(testPush.headers['content-encoding']).toBe('aes128gcm')
  await page.getByTestId('settings-close').click()

  // Looking at the app: nothing is pushed.
  await send(mehmet.page, 'bakarken yazdım')
  await expect(ayse.page.getByTestId('message').filter({ hasText: 'bakarken yazdım' })).toHaveCount(1)
  // Not looking (another app in front): pushed.
  await setAway(ayse.page, true)
  await send(mehmet.page, 'şimdi bakmıyorsun')
  await expect.poll(() => service.to(phone).length).toBe(2)
  const pushed = service.to(phone)[1]
  expect(pushed.body.length).toBeLessThanOrEqual(4096)
  expect(pushed.headers.ttl).toBe(String(6 * 3600))
  expect(phone.decrypt(pushed.body)).toMatchObject({
    kind: 'message',
    title: 'Mehmet — #genel',
    body: 'şimdi bakmıyorsun',
    tag: `ch-${GENEL}`,
    channel_id: GENEL,
  })
  // Back: the earlier message was never pushed, and nothing new is.
  await setAway(ayse.page, false)
  await send(mehmet.page, 'yine bakıyorsun')
  await expect(ayse.page.getByTestId('message').filter({ hasText: 'yine bakıyorsun' })).toHaveCount(1)
  await setAway(ayse.page, true)
  await send(mehmet.page, 'son')
  await expect.poll(() => service.to(phone).length).toBe(3)
  expect(service.to(phone).map((r) => (phone.decrypt(r.body) as { body: string }).body)).toEqual([
    'Bu cihaza bildirimler ulaşıyor.',
    'şimdi bakmıyorsun',
    'son',
  ])
})

test('"Yalnız @ben" lets only a mention through; a room opening is announced', async ({ browser, trio }) => {
  const phone = service.device('ayse')
  const ayse = trio.add(await subscribedPerson(browser, 'Ayşe', phone))
  const mehmet = trio.add(await personViaApi(browser, 'Mehmet'))
  await openSettings(ayse)
  await ayse.page.getByTestId('notify-here').click()
  await expect(ayse.page.getByTestId('notify-device')).toHaveAttribute('data-here', 'true')
  await ayse.page.getByTestId(`notify-level-${GENEL}`).selectOption('mentions')
  await expect
    .poll(async () => (await api<{ prefs: { channels: Record<string, string> } }>(ayse.token, '/api/push/prefs')).prefs.channels)
    .toEqual({ [String(GENEL)]: 'mentions' })
  await ayse.page.getByTestId('settings-close').click()
  await setAway(ayse.page, true)

  await send(mehmet.page, 'sıradan bir mesaj')
  await send(mehmet.page, '@ayşe akşam geliyor musun?')
  await expect.poll(() => service.to(phone).length).toBe(1)
  expect(phone.decrypt(service.to(phone)[0].body)).toMatchObject({
    kind: 'mention',
    renotify: true,
    body: '@ayşe akşam geliyor musun?',
  })

  await joinVoice(mehmet, SOHBET)
  await expect.poll(() => service.to(phone).length).toBe(2)
  expect(phone.decrypt(service.to(phone)[1].body)).toEqual({
    v: 1,
    kind: 'voice',
    title: 'Mehmet ses odasına girdi',
    body: '🔊 Sohbet',
    tag: `voice-${SOHBET}`,
    channel_id: SOHBET,
  })
})
