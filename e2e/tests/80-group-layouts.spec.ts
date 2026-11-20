/**
 * CONTRACT-V10-GROUPS §3: the layouts with fifteen members. Accounts are
 * seeded through the API; a few browsers look at them at 1440 and 390 px.
 * Screenshots `v10-groups-*.png` (looked at, not compared).
 */
import path from 'node:path'
import { freshServer } from '../lib/server'
import { crowd, GROUP_NAMES, seedAccounts } from '../lib/groups'
import { expect, GENEL, joinVoice, SOHBET, test } from '../lib/trio'
import { openDrawer, SCREENSHOTS, settingsTab } from '../lib/v7phone'
import { openSettings } from '../lib/ops'

const WIDE = { viewport: { width: 1440, height: 900 } }
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
const shot = (name: string) => path.join(SCREENSHOTS, `v10-groups-${name}.png`)

test.beforeEach(async () => {
  await freshServer({ TRIO_VOICE_ROOM_MAX: '10' })
})

test('fifteen members: presence, member list, @ suggestions, Yönetim, a busy voice room', async ({ browser, trio }) => {
  test.setTimeout(300_000)
  // Ayşe (owner, 1440), Zeynep at 390, and six more in the room; seven accounts offline.
  const people = await crowd(browser, trio, 8, (i) => (i === 1 ? PHONE : WIDE), ['Ayşe', 'Zeynep', 'Mehmet', 'Ali', 'Berk', 'Cem', 'Deniz', 'Ece'])
  const [ayse, zeynep] = people
  await seedAccounts(GROUP_NAMES.filter((name) => !people.some((p) => p.name === name)))
  await ayse.page.reload()
  await expect(ayse.page.locator('aside.members li.member')).toHaveCount(15)

  // The member list: online first with its count, everybody reachable by scrolling.
  const members = ayse.page.locator('aside.members')
  await expect(members).toContainText('Çevrimiçi')
  for (const person of people) await expect(ayse.page.getByTestId(`member-${person.user.id}`)).toBeAttached()

  // Seven people in Sohbet (Zeynep stays out): the sidebar lists them with the count.
  for (const person of people) if (person !== zeynep) await joinVoice(person)
  await expect(ayse.page.locator('[data-testid^="voice-user-"]')).toHaveCount(7)
  await expect(ayse.page.getByTestId(`room-count-${SOHBET}`)).toHaveText('7/10')
  await ayse.page.screenshot({ path: shot('sidebar-1440') })

  // @ suggestions: filtered, keyboard navigable, inserted whole.
  await ayse.page.getByTestId(`channel-${GENEL}`).click()
  const composer = ayse.page.getByTestId('composer')
  await composer.fill('selam @')
  await composer.press('End')
  const list = ayse.page.getByTestId('mention-list')
  await expect(list).toBeVisible()
  await expect(list.getByRole('option')).toHaveCount(8)
  await composer.pressSequentially('me')
  await expect(list.getByRole('option')).toHaveText([/Mehmet/, /Mert/])
  await ayse.page.screenshot({ path: shot('mention-1440') })
  await composer.press('ArrowDown')
  await expect(list.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true')
  await composer.press('Enter')
  await expect(composer).toHaveValue('selam @Mert ')
  await expect(list).toHaveCount(0)
  await composer.pressSequentially('ve @işı')
  await expect(list.getByRole('option')).toHaveText([/Işıl/])
  await composer.press('Tab')
  await expect(composer).toHaveValue('selam @Mert ve @Işıl ')
  // Escape closes the list without touching the text; Enter then sends.
  await composer.pressSequentially('@')
  await expect(list).toBeVisible()
  await composer.press('Escape')
  await expect(list).toHaveCount(0)
  await composer.press('Backspace')
  await composer.press('Enter')
  await expect(ayse.page.getByTestId('message').filter({ hasText: 'selam @Mert ve @Işıl' })).toHaveAttribute('data-status', 'sent')

  // Zeynep at 390: the pill, the drawer's presence (online and offline groups), the busy room.
  const zp = zeynep.page
  await expect(zp.getByTestId('presence-pill')).toHaveAttribute('data-online', '8')
  await openDrawer(zp)
  await expect(zp.getByTestId(`room-count-${SOHBET}`)).toHaveText('7/10')
  await zp.screenshot({ path: shot('drawer-390') })
  const presence = zp.getByTestId('drawer-presence')
  await presence.scrollIntoViewIfNeeded()
  await expect(presence).toContainText('Çevrimiçi — 8')
  await expect(presence).toContainText('Çevrimdışı — 7')
  await expect(presence.locator('[data-testid^="drawer-member-"]')).toHaveCount(15)
  await zp.screenshot({ path: shot('presence-390') })
  // The last of the fifteen can be scrolled to and is not covered.
  const last = presence.locator('[data-testid^="drawer-member-"]').last()
  await last.scrollIntoViewIfNeeded()
  await expect(last).toBeInViewport()

  // Yönetim with fifteen: search, sort, and the quotas added up honestly.
  await openSettings(ayse.page, 'yonetim')
  const owner = ayse.page.getByTestId('owner-section')
  await expect(owner.getByTestId('owner-user')).toHaveCount(15)
  await expect(owner.getByTestId('owner-quota-total')).toContainText('15 kişi × 1 GB kota')
  await owner.getByTestId('owner-people-search').fill('e')
  const names = await owner.getByTestId('owner-user').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-name')))
  expect(names.length).toBeGreaterThan(0)
  expect(names.length).toBeLessThan(15)
  for (const name of names) expect(name!.toLocaleLowerCase('tr-TR')).toContain('e')
  await owner.getByTestId('owner-people-search').fill('')
  await owner.getByTestId('owner-people-sort').selectOption('name')
  const sorted = await owner.getByTestId('owner-user').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-name')!))
  expect(sorted).toEqual([...sorted].sort((a, b) => a.localeCompare(b, 'tr')))
  await owner.getByTestId('owner-people').scrollIntoViewIfNeeded()
  await ayse.page.screenshot({ path: shot('owner-1440') })
  await settingsTab(ayse.page, 'yonetim')
})

test('the call stage with eight cameras and a shared screen, at 1440 and 390', async ({ browser, trio }) => {
  test.setTimeout(420_000)
  const names = ['Ayşe', 'Mehmet', 'Zeynep', 'Ali', 'Berk', 'Cem', 'Deniz', 'Ece', 'Fatih']
  const people = await crowd(browser, trio, 9, (i) => (i === 8 ? PHONE : WIDE), names)
  const [ayse, mehmet] = people
  const phone = people[8]
  await seedAccounts(GROUP_NAMES.filter((name) => !names.includes(name)))
  for (const person of people.slice(0, 8)) await joinVoice(person)
  // The phone joins through its drawer.
  await openDrawer(phone.page)
  await phone.page.getByTestId(`channel-${SOHBET}`).tap()
  await expect(phone.page.locator('.voice-status strong')).toHaveText('Ses bağlı')
  await phone.page.locator('.backdrop').tap({ position: { x: 370, y: 400 } })

  // Mehmet shares his screen, then eight cameras (everybody at a desk). The
  // share first: under the CI-like throttle a picker answer behind eight
  // encoders took longer than ten seconds.
  await mehmet.page.getByTestId('btn-screen').click()
  await expect(mehmet.page.getByTestId('btn-screen')).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 })
  for (const person of people.slice(0, 8)) {
    await person.page.getByTestId('btn-camera').click()
    await expect(person.page.getByTestId('btn-camera')).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 })
  }

  // 1440: nine tiles (the screen, seven cameras, my own) fit the stage's nine.
  const stage = ayse.page.getByTestId('stage')
  await expect(stage).toHaveAttribute('data-count', '9', { timeout: 30_000 })
  await expect(stage).toHaveAttribute('data-shown', '9')
  await expect(ayse.page.getByTestId('stage-more')).toHaveCount(0)
  await expect(stage.locator('.call-tile').first()).toHaveAttribute('data-kind', 'screen')
  await ayse.page.waitForTimeout(3000)
  await ayse.page.screenshot({ path: shot('stage-1440') })

  // 390: four cells, the screen first, the rest behind "+N", which opens all of them.
  const ps = phone.page.getByTestId('stage')
  await expect(ps).toHaveAttribute('data-count', '9', { timeout: 30_000 })
  await expect(ps).toHaveAttribute('data-shown', '3')
  await expect(phone.page.getByTestId('stage-more')).toContainText('+6')
  await expect(ps.locator('.call-tile:not(.folded):not(.stage-more)').first()).toHaveAttribute('data-kind', 'screen')
  // Folded tiles are still playing (the screen's sound and the decode never stop for them).
  await expect
    .poll(() =>
      phone.page.evaluate(() => [...document.querySelectorAll<HTMLVideoElement>('.call-tile.folded video')].every((v) => !v.paused && v.readyState >= 2)),
    )
    .toBe(true)
  await phone.page.waitForTimeout(2000)
  await phone.page.screenshot({ path: shot('stage-390') })
  await phone.page.getByTestId('stage-more').tap()
  await expect(ps).toHaveAttribute('data-shown', '9')
  await expect(phone.page.getByTestId('stage-less')).toBeVisible()
  await phone.page.screenshot({ path: shot('stage-all-390') })
  await phone.page.getByTestId('stage-less').tap()
  await expect(ps).toHaveAttribute('data-shown', '3')

  // The call bar with everybody talking at once (the fake microphones beep together).
  const bar = phone.page.getByTestId('call-bar')
  await expect(bar).toBeVisible()
  await expect.poll(async () => (await bar.textContent()) ?? '', { timeout: 20_000 }).toMatch(/Konuşuyor: [^,]+, [^+]+ \+\d|Konuşuyor|kişi/)
  const line = (await bar.textContent()) ?? ''
  // Never a list of nine names: at most two and "+N".
  expect((line.match(/,/g) ?? []).length).toBeLessThanOrEqual(1)
  await phone.page.screenshot({ path: shot('call-bar-390') })

  // The people strip under the screen when cameras go off: the room's people as small tiles.
  for (const person of people.slice(2, 8)) await person.page.getByTestId('btn-camera').click()
  await expect(ayse.page.getByTestId('stage-people')).toBeVisible()
  await expect(ayse.page.locator('[data-testid^="stage-person-"]')).toHaveCount(7)
  await ayse.page.waitForTimeout(1500)
  await ayse.page.screenshot({ path: shot('stage-people-1440') })
})
