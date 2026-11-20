/**
 * CONTRACT-V12-MULTISHARE §5 and §4 on a phone:
 *
 * - `TRIO_SCREEN_SHARES_MAX`: at the cap the share button says so and a click
 *   names who is sharing, without opening the picker; two people starting
 *   the last free share in the same moment: the server lets exactly one in,
 *   the other is told why and sends nobody a picture (no negotiation);
 * - a phone viewer with two and three shares: the stage stacks them, the
 *   call bar says who is sharing, the collapse keeps them decoding.
 */
import path from 'node:path'
import { freshServer } from '../lib/server'
import { crowd } from '../lib/groups'
import { expect, joinVoice, SOHBET, test } from '../lib/trio'
import { joinVoiceOnPhone, PHONE, SCREENSHOTS } from '../lib/v7phone'
import { NEGOTIATION_PROBE, negotiationLog } from '../lib/v8music'
import { expectDecodingFrom } from '../lib/v12multishare'

const probe = { prepare: async (context: import('@playwright/test').BrowserContext) => void (await context.addInitScript(NEGOTIATION_PROBE)) }

test('the share cap: said on the button, refused politely, one winner in a race', async ({ browser, trio }) => {
  test.setTimeout(240_000)
  await freshServer({ TRIO_SCREEN_SHARES_MAX: '2' })
  const [ayse, mehmet, zeynep, ali] = await crowd(browser, trio, 4, probe)
  for (const person of [ayse, mehmet, zeynep, ali]) await joinVoice(person)

  await ayse.page.getByTestId('btn-screen').click()
  await expectDecodingFrom(zeynep, [ayse.user.id])

  // Mehmet and Ali want the last place at once: the server decides.
  const before = await Promise.all([mehmet, ali].map((p) => negotiationLog(p.page)))
  await Promise.all([mehmet.page.getByTestId('btn-screen').click(), ali.page.getByTestId('btn-screen').click()])
  await expect
    .poll(async () => {
      const pressed = await Promise.all([mehmet, ali].map((p) => p.page.getByTestId('btn-screen').getAttribute('aria-pressed')))
      return pressed.filter((value) => value === 'true').length
    }, { timeout: 20_000 })
    .toBe(1)
  const mehmetWon = (await mehmet.page.getByTestId('btn-screen').getAttribute('aria-pressed')) === 'true'
  const [winner, loser] = mehmetWon ? [mehmet, ali] : [ali, mehmet]
  await expect(loser.page.locator('.voice-error')).toContainText('en çok 2 kişi ekran paylaşabilir')
  await expect(loser.page.locator('.voice-error')).toContainText(`Şu an paylaşanlar: Ayşe ve ${winner.name}`)
  await expectDecodingFrom(zeynep, [ayse.user.id, winner.user.id])
  // The loser never sent anybody a picture: no local preview, no offer for it.
  await expect(loser.page.getByTestId('local-video')).toHaveCount(0)
  await loser.page.waitForTimeout(2000)
  const loserLog = await negotiationLog(loser.page)
  expect(loserLog.offers).toBe(before[mehmetWon ? 1 : 0].offers)
  await expect(zeynep.page.locator(`figure.call-tile.screen[data-user-id="${loser.user.id}"]`)).toHaveCount(0)

  // Now the button itself says it is full, and a click opens no picker.
  await expect(zeynep.page.getByTestId('btn-screen')).toHaveAttribute('data-full', 'true')
  await expect(zeynep.page.getByTestId('btn-screen')).toHaveAttribute('aria-label', 'Ekran paylaşımı dolu (2/2)')
  await expect(zeynep.page.getByTestId('stage-share-too')).toHaveAttribute('aria-disabled', 'true')
  await zeynep.page.getByTestId('btn-screen').click()
  await expect(zeynep.page.locator('.voice-error')).toContainText('Biri durdurunca paylaşabilirsin')
  await expect(zeynep.page.getByTestId('local-video')).toHaveCount(0)

  // One stops: the place is free again.
  await ayse.page.getByTestId('btn-screen').click()
  await expect(zeynep.page.getByTestId('btn-screen')).toHaveAttribute('aria-label', 'Sen de paylaş')
  await zeynep.page.getByTestId('btn-screen').click()
  await expectDecodingFrom(ayse, [winner.user.id, zeynep.user.id])
  for (const person of [ayse, mehmet, zeynep, ali]) expect((await negotiationLog(person.page)).rollbacks).toBe(0)
})

test('a phone viewer with two and three shares', async ({ browser, trio }) => {
  test.setTimeout(240_000)
  await freshServer()
  const people = await crowd(browser, trio, 4, (i) => (i === 3 ? PHONE : {}))
  const [ayse, mehmet, zeynep, phone] = people
  for (const person of [ayse, mehmet, zeynep]) await joinVoice(person)
  await joinVoiceOnPhone(phone, SOHBET)
  await ayse.page.getByTestId('btn-screen').click()
  await mehmet.page.getByTestId('btn-screen').click()
  await expectDecodingFrom(phone, [ayse.user.id, mehmet.user.id])
  await expect(phone.page.getByTestId('call-bar-talking')).toHaveAttribute('data-sharing', 'true')
  // Nobody speaks in the fake microphone's gaps forever: read the sharing line when it shows.
  await expect(phone.page.getByTestId('stage-sharing-line')).toHaveText('Ayşe ve Mehmet ekran paylaşıyor')
  // Stacked, each as wide as the phone.
  const boxes = await phone.page.locator('.v12-main figure.call-tile.screen').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON()))
  expect(boxes).toHaveLength(2)
  expect(boxes[1].top).toBeGreaterThan(boxes[0].top + 50)
  for (const box of boxes) expect(box.width).toBeGreaterThan(330)
  await phone.page.screenshot({ path: path.join(SCREENSHOTS, 'v12-multishare-390-2.png') })

  await zeynep.page.getByTestId('btn-screen').click()
  await expectDecodingFrom(phone, [ayse.user.id, mehmet.user.id, zeynep.user.id])
  await expect(phone.page.getByTestId('stage-sharing-line')).toHaveText('Ayşe, Mehmet ve Zeynep ekran paylaşıyor')
  await phone.page.screenshot({ path: path.join(SCREENSHOTS, 'v12-multishare-390-3.png') })
  await phone.page.getByTestId('stage-mode-focus').click()
  await phone.page.screenshot({ path: path.join(SCREENSHOTS, 'v12-multishare-390-3-focus.png') })

  // Collapsed: hidden, still decoding (V7), and sent small (V12: nobody looks at it).
  await phone.page.getByTestId('stage-collapse').click()
  await expect(phone.page.getByTestId('stage-expand')).toBeVisible()
  await expectDecodingFrom(phone, [ayse.user.id, mehmet.user.id, zeynep.user.id])
})
