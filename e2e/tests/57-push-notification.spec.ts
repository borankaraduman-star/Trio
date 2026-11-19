/**
 * CONTRACT-V6-PUSH §6, the service worker's half: a push delivered to it
 * (CDP `ServiceWorker.deliverPushMessage`, what the browser does when the push
 * service hands one over) shows a notification with the payload's title and
 * tag, a second one for the same channel collapses into "2 yeni mesaj", a
 * click focuses the open window and sends it to that channel, looking at the
 * app clears the message notifications, and a window the worker had to open
 * (`/?open=<id>`) lands on the channel. At 390 px.
 */
import { CHROMIUM_ARGS } from '../playwright.config'
import { baseUrl, freshServer } from '../lib/server'
import { api, apiJoin, expect, GENEL, personWithSession, SOHBET, test } from '../lib/trio'
import { AWAY_SCRIPT, deliverPush, NEW_HEADLESS, setAway, shownNotifications } from '../lib/push'

test.use({ launchOptions: { ...NEW_HEADLESS, args: CHROMIUM_ARGS } })

test.beforeEach(async () => {
  await freshServer()
})

test('a push shows a notification; same channel collapses; a click routes to the channel', async ({ browser, trio }) => {
  const session = await apiJoin('Ayşe')
  const { channel } = await api<{ channel: { id: number } }>(session.token, '/api/channels', {
    method: 'POST',
    body: { name: 'oyun', kind: 'text' },
  })
  const ayse = trio.add(
    await personWithSession(browser, 'Ayşe', session, {
      viewport: { width: 390, height: 844 },
      prepare: async (context) => {
        await context.grantPermissions(['notifications'], { origin: baseUrl() })
        await context.addInitScript(AWAY_SCRIPT)
      },
    }),
  )
  const { page, context } = ayse
  await expect(page.locator('.main-header h1')).toHaveText('genel')
  await setAway(page, true)

  const message = (body: string, extra: Record<string, unknown> = {}) => ({
    v: 1,
    kind: 'message',
    title: 'Mehmet — #oyun',
    author: 'Mehmet',
    channel: 'oyun',
    body,
    tag: `ch-${channel.id}`,
    channel_id: channel.id,
    message_id: 9,
    ...extra,
  })
  await deliverPush(context, page, baseUrl(), message('akşam maç var mı?'))
  await expect.poll(() => shownNotifications(page)).toEqual([
    { title: 'Mehmet — #oyun', body: 'akşam maç var mı?', tag: `ch-${channel.id}`, data: { kind: 'message', channel_id: channel.id, message_id: 9, count: 1 } },
  ])
  await deliverPush(context, page, baseUrl(), message('ben hazırım'))
  await expect
    .poll(async () => (await shownNotifications(page)).map((n) => [n.title, n.body, n.data?.count]))
    .toEqual([['#oyun', '2 yeni mesaj · Mehmet: ben hazırım', 2]])
  // Another kind keeps its own tag.
  await deliverPush(context, page, baseUrl(), {
    v: 1,
    kind: 'ring',
    title: 'Trio — sesli çağrı',
    body: 'Mehmet seni Sohbet odasına çağırıyor',
    tag: `ring-${SOHBET}`,
    channel_id: SOHBET,
    renotify: true,
  })
  await expect.poll(async () => (await shownNotifications(page)).map((n) => n.tag).sort()).toEqual([`ch-${channel.id}`, `ring-${SOHBET}`].sort())
  // A payload that is not ours still shows something (Safari revokes push otherwise).
  await deliverPush(context, page, baseUrl(), 'not json at all')
  await expect.poll(async () => (await shownNotifications(page)).map((n) => n.title)).toContain('Trio')

  // The click: the worker's own handler, with the notification it showed.
  const worker = context.serviceWorkers().find((w) => w.url() === `${baseUrl()}/sw.js`)
  expect(worker).toBeTruthy()
  await worker!.evaluate(async (tag) => {
    const scope = self as unknown as {
      registration: ServiceWorkerRegistration
      dispatchEvent(event: Event): boolean
      NotificationEvent: new (type: string, init: { notification: Notification }) => Event
    }
    const [notification] = await scope.registration.getNotifications({ tag })
    scope.dispatchEvent(new scope.NotificationEvent('notificationclick', { notification }))
  }, `ch-${channel.id}`)
  await expect(page.locator('.main-header h1')).toHaveText('oyun')
  await expect.poll(async () => (await shownNotifications(page)).map((n) => n.tag)).not.toContain(`ch-${channel.id}`)

  // Looking at the app again: the message notifications go (the ring stays).
  await deliverPush(context, page, baseUrl(), message('bir daha', { tag: `ch-${GENEL}`, channel_id: GENEL, title: 'Mehmet — #genel' }))
  await expect.poll(async () => (await shownNotifications(page)).map((n) => n.tag)).toContain(`ch-${GENEL}`)
  await setAway(page, false)
  await expect.poll(async () => (await shownNotifications(page)).map((n) => n.tag).filter((t) => t.startsWith('ch-'))).toEqual([])
  expect((await shownNotifications(page)).map((n) => n.tag)).toContain(`ring-${SOHBET}`)

  // A window the worker opened: /?open=<id> lands there and the address is cleaned.
  await page.getByTestId('btn-drawer').click()
  await page.getByTestId(`channel-${GENEL}`).click()
  await expect(page.locator('.main-header h1')).toHaveText('genel')
  await page.goto(`/?open=${channel.id}&kind=message`)
  await expect(page.locator('.main-header h1')).toHaveText('oyun')
  await expect.poll(() => new URL(page.url()).search).toBe('')
})
