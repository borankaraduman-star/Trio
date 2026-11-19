/**
 * CONTRACT-V4 C and A2 through the real UI: avatars (cropped and re-encoded in
 * the browser, EXIF gone), renames, the server's name and icon, the versions
 * line and the "Yenilikler" card, at desktop and phone width.
 */
import fs from 'node:fs'
import path from 'node:path'
import { freshServer, WEB_DIR } from '../lib/server'
import {
  apiAvatar,
  avatarsOf,
  closeSettings,
  drawPicture,
  expectDecoded,
  fetchPicture,
  hasExif,
  openSettings,
  uploadThroughCropper,
  withExifGps,
} from '../lib/identity'
import {
  api,
  apiJoin,
  expect,
  expectConnected,
  expectHearing,
  joinVoice,
  newContext,
  personViaApi,
  personViaUi,
  sendThroughUi,
  test,
  threePeople,
  type Person,
} from '../lib/trio'

const WEB_VERSION = (JSON.parse(fs.readFileSync(path.join(WEB_DIR, 'package.json'), 'utf8')) as { version: string }).version

test.beforeEach(async () => {
  await freshServer()
})

test('an avatar: cropped and re-encoded without EXIF, seen by everyone everywhere, removed for everyone', async ({ browser, trio }) => {
  test.setTimeout(120_000)
  const [ayse, mehmet, zeynep] = await threePeople(browser, trio)
  await sendThroughUi(ayse, 'eski mesajım')
  await sendThroughUi(mehmet, 'araya bir mesaj')
  for (const person of [ayse, mehmet, zeynep]) await joinVoice(person)

  // A phone photo: a big JPEG with a GPS block in it.
  const photo = withExifGps(
    await drawPicture(ayse.page, { width: 1600, height: 1200, background: '#3e6e85', disc: '#ee997f', band: '#f2f1ed', type: 'image/jpeg' }),
  )
  expect(hasExif(photo)).toBe(true)
  // The browser still reads it as a picture.
  await openSettings(ayse)
  const { status, body } = await uploadThroughCropper(ayse, 'avatar', { name: 'IMG_2041.jpg', mimeType: 'image/jpeg', buffer: photo }, async () => {
    await ayse.page.getByTestId('cropper-zoom').fill('1.5')
    await expect(ayse.page.getByTestId('cropper-canvas')).toHaveAttribute('data-zoom', '1.500')
  })
  expect(status).toBe(200)
  await expect(ayse.page.getByTestId('cropper')).toHaveCount(0)
  const url = (body.user as { avatar_url: string }).avatar_url
  expect(url).toMatch(new RegExp(`^/api/avatars/${ayse.user.id}/[0-9a-f]{32}\\.(webp|jpg)$`))

  // What was stored: 256 × 256, made from pixels — no EXIF, no GPS.
  const stored = await fetchPicture(ayse.page, url)
  expect(stored.width).toBe(256)
  expect(stored.height).toBe(256)
  expect(stored.type).toMatch(/^image\/(webp|jpeg)$/)
  expect(hasExif(stored.bytes)).toBe(false)
  expect(stored.bytes.includes(Buffer.from('GPS'))).toBe(false)
  // Chromium encodes WebP, so the fallback is not taken here.
  expect(stored.type).toBe('image/webp')

  await expectDecoded(ayse.page.getByTestId('avatar').locator('.avatar-img'))
  await closeSettings(ayse)
  await sendThroughUi(ayse, 'yeni mesajım')

  for (const viewer of [mehmet, zeynep, ayse]) {
    const where = avatarsOf(viewer.page, ayse.user.id)
    await expectDecoded(where.member.locator('img'))
    await expect(where.messages).toHaveCount(2)
    for (const message of await where.messages.all()) await expectDecoded(message.locator('img'))
    await expectDecoded(where.voice.locator('img'))
    await expect(where.member.locator('img')).toHaveAttribute('src', url)
  }
  await expectDecoded(ayse.page.locator('.user-panel .avatar img'))

  // In the voice room the speaking ring goes around the picture (the fake microphone beeps).
  await expectHearing(mehmet, ayse)
  await expect(mehmet.page.locator(`[data-testid="voice-user-${ayse.user.id}"][data-speaking="true"] .avatar.speaking.has-image`)).toBeVisible({
    timeout: 20_000,
  })

  // The same file again changes nothing: the same URL.
  await apiAvatar(ayse.token, { name: 'again.webp', mimeType: 'image/webp', buffer: stored.bytes })
  const again = await api<{ user: { avatar_url: string } }>(ayse.token, '/api/me')
  expect(again.user.avatar_url).toBe(url)
  await expectDecoded(avatarsOf(mehmet.page, ayse.user.id).member.locator('img'))

  // Removed: initials again, for everyone, everywhere.
  await openSettings(ayse)
  const removed = ayse.page.waitForResponse((r) => new URL(r.url()).pathname === '/api/me/avatar' && r.request().method() === 'DELETE')
  await ayse.page.getByTestId('avatar-remove').click()
  expect((await removed).status()).toBe(200)
  await closeSettings(ayse)
  for (const viewer of [mehmet, zeynep, ayse]) {
    const where = avatarsOf(viewer.page, ayse.user.id)
    await expect(where.member).toHaveAttribute('data-avatar', 'initial')
    await expect(where.member).toHaveText('A')
    await expect(where.messages.locator('img')).toHaveCount(0)
    await expect(where.voice).toHaveAttribute('data-avatar', 'initial')
  }
  expect((await fetch(new URL(url, ayse.page.url()))).status).toBe(404)
})

test('pictures the browser cannot use are refused in Turkish, and nothing is sent', async ({ browser, trio }) => {
  const ayse = trio.add(await personViaApi(browser, 'Ayşe'))
  await openSettings(ayse)
  const puts: string[] = []
  ayse.page.on('request', (request) => {
    if (request.method() === 'PUT') puts.push(request.url())
  })
  await ayse.page.getByTestId('avatar-input').setInputFiles({
    name: 'IMG_0001.HEIC',
    mimeType: 'image/heic',
    buffer: Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(2000, 7)]),
  })
  await expect(ayse.page.getByTestId('avatar-error')).toContainText('HEIC biçimindeki fotoğraflar bu tarayıcıda açılamıyor')
  await expect(ayse.page.getByTestId('cropper')).toHaveCount(0)
  await ayse.page.getByTestId('avatar-input').setInputFiles({ name: 'notlar.txt', mimeType: 'text/plain', buffer: Buffer.from('merhaba') })
  await expect(ayse.page.getByTestId('avatar-error')).toHaveText('Bu dosya bir görsel değil. JPEG, PNG ya da WebP seç.')
  await ayse.page.getByTestId('avatar-input').setInputFiles({ name: 'bozuk.png', mimeType: 'image/png', buffer: Buffer.alloc(500, 3) })
  await expect(ayse.page.getByTestId('avatar-error')).toHaveText('Bu görsel bu tarayıcıda açılamıyor; JPEG, PNG ya da WebP dene.')
  // Escape closes the cropper only, never the settings behind it.
  const png = await drawPicture(ayse.page, { width: 300, height: 200, background: '#37766c', disc: '#ee997f', band: '#111318' })
  await ayse.page.getByTestId('avatar-input').setInputFiles({ name: 'a.png', mimeType: 'image/png', buffer: png })
  await expect(ayse.page.getByTestId('cropper')).toBeVisible()
  await ayse.page.getByTestId('cropper-canvas').focus()
  await ayse.page.keyboard.press('Escape')
  await expect(ayse.page.getByTestId('cropper')).toHaveCount(0)
  await expect(ayse.page.getByTestId('settings-dialog')).toBeVisible()
  expect(puts).toEqual([])
})

test('a rename is live for everyone, on old messages too; a taken name is refused', async ({ browser, trio }) => {
  const [ayse, mehmet, zeynep] = await threePeople(browser, trio)
  await sendThroughUi(mehmet, 'bu eski bir mesaj')

  await openSettings(mehmet)
  await mehmet.page.getByTestId('rename-input').fill('  Memo  ')
  const renamed = mehmet.page.waitForResponse((r) => new URL(r.url()).pathname === '/api/me' && r.request().method() === 'PATCH')
  await mehmet.page.getByTestId('rename-save').click()
  expect((await renamed).status()).toBe(200)
  await expect(mehmet.page.getByTestId('rename-saved')).toBeVisible()
  await expect(mehmet.page.getByTestId('rename-input')).toHaveValue('Memo')
  await closeSettings(mehmet)

  for (const viewer of [ayse, zeynep, mehmet]) {
    await expect(viewer.page.getByTestId(`member-${mehmet.user.id}`)).toContainText('Memo')
    await expect(viewer.page.locator(`[data-testid="message"][data-author-id="${mehmet.user.id}"] [data-testid="message-author"]`)).toHaveText(
      'Memo',
    )
  }
  await expect(mehmet.page.locator('.user-panel-name strong')).toHaveText('Memo')
  // What this device remembers follows the name.
  expect(await mehmet.page.evaluate(() => localStorage.getItem('trio.lastName'))).toBe('Memo')
  expect(await mehmet.page.evaluate(() => JSON.parse(localStorage.getItem('trio.user') ?? '{}').name)).toBe('Memo')
  await mehmet.page.reload()
  await expectConnected(mehmet.page)
  await expect(mehmet.page.locator('.user-panel-name strong')).toHaveText('Memo')

  // Another user's name, in another case: refused, worded as on the join screen.
  await openSettings(zeynep)
  await zeynep.page.getByTestId('rename-input').fill('AYŞE')
  await zeynep.page.getByTestId('rename-save').click()
  await expect(zeynep.page.getByTestId('rename-error')).toHaveText('Bu isim alınmış, başka bir isim dene.')
  await zeynep.page.getByTestId('rename-input').fill('x'.repeat(33))
  await zeynep.page.getByTestId('rename-save').click()
  await expect(zeynep.page.getByTestId('rename-error')).toHaveText('İsim 1–32 karakter olmalı.')
  await expect(ayse.page.getByTestId(`member-${zeynep.user.id}`)).toContainText('Zeynep')
  // The name Mehmet left is free again.
  await zeynep.page.getByTestId('rename-input').fill('Mehmet')
  await zeynep.page.getByTestId('rename-save').click()
  await expect(zeynep.page.getByTestId('rename-saved')).toBeVisible()
  await expect(ayse.page.getByTestId(`member-${zeynep.user.id}`)).toContainText('Mehmet')
})

test('the server name and icon change live for all three, survive a reload, and keep the (n) title', async ({ browser, trio }) => {
  test.setTimeout(120_000)
  const [ayse, mehmet, zeynep] = await threePeople(browser, trio)
  const { channel: oyun } = await api<{ channel: { id: number } }>(ayse.token, '/api/channels', {
    method: 'POST',
    body: { name: 'oyun', kind: 'text' },
  })
  for (const person of [ayse, mehmet, zeynep]) {
    await expect(person.page.getByTestId('server-name')).toHaveText('Trio')
    await expect(person.page).toHaveTitle('Trio')
    await expect(person.page.getByTestId(`channel-${oyun.id}`)).toBeVisible()
  }

  await openSettings(zeynep)
  await expect(zeynep.page.getByTestId('settings-server')).toContainText('herkes değiştirebilir')
  await zeynep.page.getByTestId('server-rename-input').fill('Bizim Ev')
  await zeynep.page.getByTestId('server-rename-save').click()
  await expect(zeynep.page.getByTestId('server-rename-saved')).toBeVisible()
  const icon = await drawPicture(zeynep.page, { width: 640, height: 480, background: '#ee997f', disc: '#111318', band: '#69b9aa' })
  const { status, body } = await uploadThroughCropper(zeynep, 'server-icon-field', { name: 'ikon.png', mimeType: 'image/png', buffer: icon })
  expect(status).toBe(200)
  const iconUrl = (body.server as { icon_url: string }).icon_url
  expect(iconUrl).toMatch(/^\/api\/server\/icon\/[0-9a-f]{32}\.(webp|jpg)$/)
  const stored = await fetchPicture(zeynep.page, iconUrl)
  expect([stored.width, stored.height]).toEqual([256, 256])
  await closeSettings(zeynep)

  for (const person of [ayse, mehmet, zeynep]) {
    await expect(person.page.getByTestId('server-name')).toHaveText('Bizim Ev')
    await expect(person.page).toHaveTitle('Bizim Ev')
    await expectDecoded(person.page.getByTestId('server-icon'))
  }

  // Unread in another channel: the count stays in front of the name (the desktop badge reads it).
  await mehmet.page.getByTestId(`channel-${oyun.id}`).click()
  await sendThroughUi(mehmet, 'oyun kanalında bir şey')
  await expect(ayse.page).toHaveTitle('(1) Bizim Ev')
  await expect(zeynep.page).toHaveTitle('(1) Bizim Ev')

  await ayse.page.reload()
  await expectConnected(ayse.page)
  await expect(ayse.page.getByTestId('server-name')).toHaveText('Bizim Ev')
  await expectDecoded(ayse.page.getByTestId('server-icon'))
  await expect(ayse.page).toHaveTitle('(1) Bizim Ev')
  await ayse.page.getByTestId(`channel-${oyun.id}`).click()
  await expect(ayse.page).toHaveTitle('Bizim Ev')

  // The icon removed: the Trio mark again, for everyone.
  await openSettings(mehmet)
  await mehmet.page.getByTestId('server-icon-field-remove').click()
  await closeSettings(mehmet)
  for (const person of [ayse, mehmet, zeynep]) {
    await expect(person.page.getByTestId('server-icon')).toHaveCount(0)
    await expect(person.page.locator('.sidebar-header .brand-mark')).toBeVisible()
  }
  expect((await api<{ server: { name: string; icon_url: null } }>(ayse.token, '/api/server')).server).toEqual({
    name: 'Bizim Ev',
    icon_url: null,
  })
})

test('the settings footer shows the client and server versions; Yenilikler after an update only', async ({ browser, trio }) => {
  const ayse = trio.add(await personViaUi(browser, 'Ayşe'))
  const serverVersion = ((await (await fetch(new URL('/api/health', ayse.page.url()))).json()) as { version: string }).version
  await openSettings(ayse)
  const footer = ayse.page.getByTestId('settings-versions')
  await footer.scrollIntoViewIfNeeded()
  await expect(footer).toHaveText(new RegExp(`^Trio ${WEB_VERSION.replace(/\./g, '\\.')} \\([^)]+\\) · sunucu ${serverVersion.replace(/\./g, '\\.')}$`))
  await expect(footer).toHaveAttribute('data-server-version', serverVersion)
  await closeSettings(ayse)

  // A first visit: nothing to tell; the version is remembered as seen.
  await expect.poll(() => ayse.page.evaluate(() => localStorage.getItem('trio.seenVersion'))).toBe(WEB_VERSION)
  await expect(ayse.page.getByTestId('whats-new')).toHaveCount(0)
  await expect(ayse.page.getByTestId('whats-new-waiting')).toHaveCount(0)

  // "An update": this device last acknowledged 0.2.0.
  await ayse.page.evaluate(() => localStorage.setItem('trio.seenVersion', '0.2.0'))
  await ayse.page.reload()
  await expectConnected(ayse.page)
  const card = ayse.page.getByTestId('whats-new')
  await expect(card).toBeVisible()
  // Newer than 0.2.0: 0.4.0 in two parts (the voice work; messages and game status), 0.3.0 and 0.2.1.
  await expect(card.getByTestId('whats-new-entry')).toHaveCount(4)
  await expect(card.getByTestId('whats-new-entry').nth(1)).toHaveAttribute('data-version', WEB_VERSION)
  await expect(card).toContainText('Mesajlara tepki')
  await expect(card.getByTestId('whats-new-entry').first()).toHaveAttribute('data-version', WEB_VERSION)
  await expect(card).toContainText('Profil fotoğrafı')
  // It blocks nothing: typing and sending go on with it open.
  await sendThroughUi(ayse, 'kart açıkken yazdım')
  await card.getByTestId('whats-new-dismiss').click()
  await expect(card).toHaveCount(0)
  expect(await ayse.page.evaluate(() => localStorage.getItem('trio.seenVersion'))).toBe(WEB_VERSION)
  await ayse.page.reload()
  await expectConnected(ayse.page)
  await expect(ayse.page.getByTestId('whats-new-waiting')).toHaveCount(0)
  await expect(ayse.page.getByTestId('whats-new')).toHaveCount(0)
})

test('Yenilikler waits while the reload guard says the page is busy', async ({ browser, trio }) => {
  const session = await apiJoin('Ayşe')
  let online = false
  const context = await newContext(browser)
  await context.addInitScript(
    ([token, user]) => {
      if (!sessionStorage.getItem('trio.e2e.seeded')) {
        sessionStorage.setItem('trio.e2e.seeded', '1')
        localStorage.setItem('trio.token', token)
        localStorage.setItem('trio.user', user)
        // A device that used Trio before the card existed: a session and read marks, no seen version.
        localStorage.setItem('trio.lastRead', '{}')
      }
    },
    [session.token, JSON.stringify(session.user)] as const,
  )
  await context.routeWebSocket(/\/ws/, (ws) => {
    if (!online) {
      void ws.close({ code: 1011, reason: 'offline' })
      return
    }
    ws.connectToServer()
  })
  const page = await context.newPage()
  const person: Person = trio.add({ name: 'Ayşe', context, page, user: session.user, token: session.token })
  await page.goto('/')
  // Settings opened before the session is up: a dialog holds the card.
  await page.getByTestId('btn-settings').click()
  await expect(page.getByTestId('settings-dialog')).toBeVisible()
  online = true
  await expect(page.locator('.user-panel-name span')).toHaveText('Çevrimiçi', { timeout: 30_000 })
  const waiting = page.getByTestId('whats-new-waiting')
  await expect.poll(async () => Number(await waiting.getAttribute('data-held'))).toBeGreaterThanOrEqual(2)
  await expect(page.getByTestId('whats-new')).toHaveCount(0)
  await closeSettings(person)
  await expect(page.getByTestId('whats-new')).toBeVisible()
  await expect(page.getByTestId('whats-new-entry').first()).toHaveAttribute('data-version', WEB_VERSION)
  expect(await page.evaluate(() => localStorage.getItem('trio.seenVersion'))).toBeNull()
})

test('phone width: the cropper works by touch (drag, pinch, slider) and every section is reachable', async ({ browser, trio }) => {
  const phone = trio.add(
    await personViaApi(browser, 'Mehmet', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }),
  )
  const page = phone.page
  await page.getByTestId('btn-drawer').tap()
  await page.getByTestId('btn-settings').tap()
  await expect(page.getByTestId('settings-dialog')).toBeVisible()
  for (const id of ['avatar-choose', 'rename-input', 'settings-server', 'server-rename-input', 'settings-versions']) {
    const element = page.getByTestId(id)
    await element.scrollIntoViewIfNeeded()
    await expect(element).toBeInViewport()
    const box = await element.boundingBox()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(390)
  }

  const photo = await drawPicture(page, { width: 1200, height: 900, background: '#75507a', disc: '#85d9c5', band: '#f2f1ed' })
  await page.getByTestId('avatar-input').setInputFiles({ name: 'foto.png', mimeType: 'image/png', buffer: photo })
  const canvas = page.getByTestId('cropper-canvas')
  await expect(canvas).toBeVisible()
  const box = (await canvas.boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(390)
  await expect(page.getByTestId('cropper-save')).toBeInViewport()

  // Real touches through the browser's input pipeline (CDP), not synthetic events.
  const cdp = await phone.context.newCDPSession(page)
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', points: { x: number; y: number }[]) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p, id) => ({ ...p, id })) })

  // A pinch out zooms in.
  await touch('touchStart', [{ x: centre.x - 30, y: centre.y }, { x: centre.x + 30, y: centre.y }])
  for (let step = 1; step <= 6; step++) {
    await touch('touchMove', [{ x: centre.x - 30 - step * 12, y: centre.y }, { x: centre.x + 30 + step * 12, y: centre.y }])
  }
  await touch('touchEnd', [])
  await expect.poll(async () => Number(await canvas.getAttribute('data-zoom'))).toBeGreaterThan(1.5)

  // One finger drags the picture: to the right shows more of its left side.
  const cxBefore = Number(await canvas.getAttribute('data-cx'))
  await touch('touchStart', [centre])
  for (let step = 1; step <= 6; step++) await touch('touchMove', [{ x: centre.x + step * 10, y: centre.y }])
  await touch('touchEnd', [])
  await expect.poll(async () => Number(await canvas.getAttribute('data-cx'))).toBeLessThan(cxBefore)
  await cdp.detach()

  // The slider (the other way to zoom on a phone).
  await page.getByTestId('cropper-zoom').fill('1')
  await expect(canvas).toHaveAttribute('data-zoom', '1.000')

  const saved = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/me/avatar' && r.request().method() === 'PUT')
  await page.getByTestId('cropper-save').click()
  expect((await saved).status()).toBe(200)
  await expect(page.getByTestId('cropper')).toHaveCount(0)
  await expectDecoded(page.getByTestId('avatar').locator('.avatar-img'))
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
})
