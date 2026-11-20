/**
 * CONTRACT-V11-ACTIVITY with fifteen people (CONTRACT-V10-GROUPS): twelve
 * accounts online from raw sockets, each playing and/or listening, seven of
 * them in #genel (stacked faces and "+n" under the row), a few long titles.
 * Three browsers look: 1440, 911 at 150 % and a phone. Their activities
 * change for a while: the message list's DOM is not touched and every line
 * keeps up. Screenshots `v11-activity-15-*.png`.
 */
import path from 'node:path'
import { freshServer } from '../lib/server'
import { crowd, GROUP_NAMES, seedAccounts } from '../lib/groups'
import { api, expect, GENEL, test } from '../lib/trio'
import { openDrawer, SCREENSHOTS } from '../lib/v7phone'
import { AWAY_SCRIPT } from '../lib/push'
import { activitySocket } from '../lib/v11activity'

const shot = (name: string) => path.join(SCREENSHOTS, `v11-activity-15-${name}.png`)
const away = async (c: import('@playwright/test').BrowserContext) => void (await c.addInitScript(AWAY_SCRIPT))
const WIDE = { viewport: { width: 1440, height: 900 }, prepare: away }
const LAPTOP = { viewport: { width: 911, height: 512 }, deviceScaleFactor: 1.5, prepare: away }
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, prepare: away }

test.beforeEach(async () => {
  await freshServer()
})

const now = () => Math.floor(Date.now() / 1000)
const LONG = 'Çok Uzun Bir Şarkı Adı (Akustik Canlı Kayıt, Harbiye Açıkhava 2019) — Yeniden Düzenlenmiş Sürüm'

function activityFor(i: number): Record<string, unknown> {
  switch (i % 4) {
    case 0:
      return { game: 'Counter-Strike 2', since: now() - 600, listening: { title: `Şarkı ${i}`, artist: 'Sanatçı', app: 'Spotify' } }
    case 1:
      return { listening: { title: i === 1 ? LONG : `Parça ${i}`, artist: 'Sezen Aksu', app: 'Apple Music' } }
    case 2:
      return {
        game: 'WoW Forever',
        since: now() - 3600,
        detail: { character: `Karakter${i}`, realm: '', level: 30 + i, class: 'MAGE', zone: 'Stormwind City', subzone: '', source: 'log' },
      }
    default:
      return { game: 'VALORANT', since: now() - 60 }
  }
}

test('fifteen people with activities: member panel, "+n" under a channel, the drawer; changes leave the message list alone', async ({ browser, trio }) => {
  test.setTimeout(240_000)
  const people = await crowd(browser, trio, 3, (i) => [WIDE, LAPTOP, PHONE][i]!, ['Ayşe', 'Mehmet', 'Zeynep'])
  const [ayse, mehmet, zeynep] = people
  const seeded = await seedAccounts(GROUP_NAMES.filter((name) => !people.some((p) => p.name === name)))
  const sockets = []
  for (const [i, account] of seeded.entries()) {
    sockets.push(await activitySocket(account.token, activityFor(i), i < 7 ? GENEL : null))
  }
  try {
    for (const p of [ayse, mehmet]) await p.page.getByTestId(`channel-${GENEL}`).click()
    await api(ayse.token, `/api/channels/${GENEL}/messages`, { method: 'POST', body: { content: 'akşam kim var?' } }).catch(() => undefined)

    const ap = ayse.page
    await expect(ap.locator('aside.members li.member')).toHaveCount(15)
    await expect(ap.locator('[data-testid^="member-listening-"]')).toHaveCount(6)
    await expect(ap.locator('[data-testid^="member-activity-"]')).toHaveCount(9)
    // Seven seeded + the three browsers in #genel: stacked faces, "+n", activities in the tooltip.
    const under = ap.getByTestId(`channel-viewers-${GENEL}`)
    await expect(under).toHaveAttribute('data-count', '10')
    await expect(ap.getByTestId(`channel-viewers-more-${GENEL}`)).toHaveText('+6')
    await expect(under).toHaveAttribute('title', /Ali — Counter-Strike 2 · dinliyor: Spotify · Sanatçı — Şarkı 0/)
    await expect(under).toHaveAttribute('aria-label', /Berk — dinliyor: Apple Music · Sezen Aksu — Çok Uzun/)
    // A long title is cut with an ellipsis, on one or two lines, never wider than the panel.
    const longLine = ap.getByTestId(`member-listening-${seeded[1]!.user.id}`)
    const panel = (await ap.getByTestId('members-panel').boundingBox())!
    const box = (await longLine.boundingBox())!
    expect(box.x + box.width).toBeLessThanOrEqual(panel.x + panel.width + 1)
    expect(box.height).toBeLessThan(40)
    await ap.screenshot({ path: shot('1440') })

    await expect(mehmet.page.locator('[data-testid^="member-listening-"]')).toHaveCount(6)
    await mehmet.page.screenshot({ path: shot('911') })

    await openDrawer(zeynep.page)
    const presence = zeynep.page.getByTestId('drawer-presence')
    await presence.scrollIntoViewIfNeeded()
    await expect(presence.locator('[data-testid^="drawer-listening-"]')).toHaveCount(6)
    await zeynep.page.screenshot({ path: shot('390') })

    // Churn: every seeded person changes their game every second for 5 s. The
    // message list's DOM does not move; the lines keep up.
    await ap.evaluate(() => {
      const list = document.querySelector('[data-testid="message-list"]')!
      const w = window as unknown as { __mutations: number }
      w.__mutations = 0
      new MutationObserver((records) => (w.__mutations += records.length)).observe(list, { subtree: true, childList: true, characterData: true, attributes: true })
    })
    for (let round = 0; round < 5; round++) {
      for (const socket of sockets) socket.send({ game: `Oyun ${round}`, since: now() })
      await ap.waitForTimeout(1000)
    }
    await expect(ap.locator('[data-testid^="member-activity-"]').filter({ hasText: 'Oyun 4' })).toHaveCount(12)
    expect(await ap.evaluate(() => (window as unknown as { __mutations: number }).__mutations)).toBe(0)
  } finally {
    for (const socket of sockets) socket.close()
  }
})
