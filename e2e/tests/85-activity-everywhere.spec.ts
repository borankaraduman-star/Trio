/**
 * CONTRACT-V11-ACTIVITY, the owner's words: "ne dinlediği / ne oynadığım
 * sadece sesli sohbette değil, kanallarda da görünsün". Ayşe runs a (fake)
 * desktop app that plays a game AND listens to Spotify; Mehmet (1440) and
 * Zeynep (a phone) see both where people are listed: the member panel, under
 * the text channel she has open, the header's "Burada", the phone drawer, the
 * voice row. Turning "Ne dinlediğimi göster" off removes it within a second.
 * Screenshots `v11-activity-*.png`.
 */
import path from 'node:path'
import type { Page } from '@playwright/test'
import { freshServer } from '../lib/server'
import { crowd } from '../lib/groups'
import { expect, GENEL, joinVoice, test, type Person } from '../lib/trio'
import { openDrawer, SCREENSHOTS } from '../lib/v7phone'
import { AWAY_SCRIPT } from '../lib/push'
import { openSettings } from '../lib/ops'
import { fakeDesktop, play, pushGame, SONG, wow } from '../lib/v11activity'

const shot = (name: string) => path.join(SCREENSHOTS, `v11-activity-${name}.png`)
const away = async (c: import('@playwright/test').BrowserContext) => void (await c.addInitScript(AWAY_SCRIPT))
const AYSE = {
  viewport: { width: 1440, height: 900 },
  prepare: async (c: import('@playwright/test').BrowserContext) => {
    await away(c)
    await fakeDesktop(c, { acked: true })
  },
}
const WIDE = { viewport: { width: 1440, height: 900 }, prepare: away }
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, prepare: away }

test.beforeEach(async () => {
  await freshServer()
})

const listening = (page: Page, prefix: string, id: number) => page.getByTestId(`${prefix}-listening-${id}`)
const game = (page: Page, prefix: string, id: number) => page.getByTestId(`${prefix}-activity-${id}`)

async function open(person: Person, channelId: number): Promise<void> {
  await person.page.getByTestId(`channel-${channelId}`).click()
  await expect(person.page.getByTestId(`channel-${channelId}`)).toHaveAttribute('aria-current', 'page')
}

test('a game and a song show wherever Ayşe is listed; off removes the song within a second', async ({ browser, trio }) => {
  test.setTimeout(180_000)
  const [ayse, mehmet, zeynep] = await crowd(browser, trio, 3, (i) => [AYSE, WIDE, PHONE][i]!)
  const id = ayse.user.id
  await open(ayse, GENEL)
  await open(mehmet, GENEL)

  // Not in a voice room, not sharing anything: a game and a song.
  await pushGame(ayse.page, wow('Orgrimmar'))
  await play(ayse.page, SONG)
  const line = 'mor ve ötesi — Bir Derdim Var'
  await expect(listening(mehmet.page, 'member', id)).toHaveAttribute('title', /Spotify ile dinliyor/)
  for (const page of [ayse.page, mehmet.page]) {
    await expect(game(page, 'member', id)).toHaveText('WoW Forever · 37 · Orgrimmar')
    await expect(listening(page, 'member', id)).toHaveText(line)
  }
  // The song is the second line, under the game.
  const gameBox = (await game(mehmet.page, 'member', id).boundingBox())!
  const songBox = (await listening(mehmet.page, 'member', id).boundingBox())!
  expect(songBox.y).toBeGreaterThan(gameBox.y)

  // Under the text channel she has open: one short piece (the game), the song in its tooltip.
  const under = mehmet.page.getByTestId(`viewer-activity-${GENEL}-${id}`)
  await expect(under).toHaveText('WoW Forever')
  await expect(under).toHaveAttribute('title', /Bir Derdim Var/)
  await expect(mehmet.page.getByTestId('here-line')).toHaveAttribute('title', /Ayşe — WoW Forever · 37 · Orgrimmar · dinliyor: Spotify/)
  await mehmet.page.screenshot({ path: shot('1440') })

  // The phone drawer.
  await openDrawer(zeynep.page)
  const presence = zeynep.page.getByTestId('drawer-presence')
  await presence.scrollIntoViewIfNeeded()
  await expect(listening(zeynep.page, 'drawer', id)).toHaveText(line)
  await expect(game(zeynep.page, 'drawer', id)).toHaveText('WoW Forever · 37 · Orgrimmar')
  await zeynep.page.screenshot({ path: shot('390-drawer') })

  // In a voice room: the room's name AND the activity in the drawer; both lines on the voice row.
  await joinVoice(ayse)
  await expect(zeynep.page.getByTestId(`drawer-member-${id}`)).toHaveAttribute('data-voice-channel', /\d+/)
  await expect(listening(zeynep.page, 'drawer', id)).toHaveText(line)
  await expect(listening(mehmet.page, 'voice', id)).toHaveText(line)
  await expect(game(mehmet.page, 'voice', id)).toHaveText('WoW Forever · 37 · Orgrimmar')
  await mehmet.page.screenshot({ path: shot('1440-voice') })

  // Only the song (out of the game): the short piece under the channel is the song.
  await pushGame(ayse.page, null)
  await expect(game(mehmet.page, 'member', id)).toHaveCount(0)
  await expect(under).toHaveText('mor ve ötesi — Bir Derdim Var')

  // "Ne dinlediğimi göster" off: gone for the others within a second.
  await openSettings(ayse.page, 'hesap')
  await ayse.page.getByTestId('settings-listen-share').uncheck()
  const off = Date.now()
  await expect(listening(mehmet.page, 'member', id)).toHaveCount(0, { timeout: 1000 })
  console.log(`[85] the song left another page after ${Date.now() - off} ms`)
  await expect(listening(mehmet.page, 'voice', id)).toHaveCount(0)
  await expect(under).toHaveCount(0)
  await expect(listening(zeynep.page, 'drawer', id)).toHaveCount(0)
})

test('a track change reaches the others; a pause the shell reports clears it; a reload sends it again', async ({ browser, trio }) => {
  const [ayse, mehmet] = await crowd(browser, trio, 2, (i) => [AYSE, WIDE][i]!)
  const id = ayse.user.id
  await play(ayse.page, SONG)
  await expect(listening(mehmet.page, 'member', id)).toHaveText('mor ve ötesi — Bir Derdim Var')
  await play(ayse.page, { title: 'Cevapsız Sorular', artist: 'maNga', app: 'Spotify' })
  // A new song waits at most the 5 s listening gap.
  await expect(listening(mehmet.page, 'member', id)).toHaveText('maNga — Cevapsız Sorular', { timeout: 7000 })
  await play(ayse.page, null)
  await expect(listening(mehmet.page, 'member', id)).toHaveCount(0, { timeout: 4000 })
  await play(ayse.page, SONG)
  await expect(listening(mehmet.page, 'member', id)).toHaveCount(1, { timeout: 7000 })
  await ayse.page.reload()
  await expect(ayse.page.getByTestId('composer')).toBeVisible()
  await play(ayse.page, SONG)
  await expect(listening(mehmet.page, 'member', id)).toHaveText('mor ve ötesi — Bir Derdim Var')
})
