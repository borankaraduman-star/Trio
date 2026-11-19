/**
 * CONTRACT-V7-PHONE §3: on a phone the stage collapses to a one-line pill,
 * remembered per device. Collapsing is a layout choice only: the screen keeps
 * arriving and decoding, the sharer still counts the phone as watching, and
 * nothing renegotiates. A wide screen has no collapse control.
 */
import path from 'node:path'
import { freshServer } from '../lib/server'
import { expect, expectHearing, expectScreensDecoding, joinVoice, personViaApi, SOHBET, test } from '../lib/trio'
import { countNegotiations, negotiationCounts, screenIn } from '../lib/v6voice'
import { DESKTOP, joinVoiceOnPhone, PHONE, SCREENSHOTS } from '../lib/v7phone'

test.beforeEach(async () => {
  await freshServer()
})

const window_ = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test('phone: a collapsed stage gives the chat back, keeps the screen flowing, and is remembered', async ({ browser, trio }) => {
  test.setTimeout(150_000)
  const ayse = trio.add(await personViaApi(browser, 'Ayşe', DESKTOP))
  const mehmet = trio.add(await personViaApi(browser, 'Mehmet', PHONE))
  const page = mehmet.page

  await joinVoice(ayse)
  await joinVoiceOnPhone(mehmet, SOHBET)
  await ayse.page.getByTestId('btn-screen').click()
  await expectScreensDecoding(page, 1)
  await expect(ayse.page.getByTestId('local-watchers')).toHaveAttribute('data-count', '1')

  const frame = page.getByTestId('stage-frame')
  await expect(frame).toHaveAttribute('data-collapsed', 'false')
  const collapse = page.getByTestId('stage-collapse')
  await expect(collapse).toBeInViewport({ ratio: 1 })
  const stageHeight = (await page.getByTestId('stage').boundingBox())!.height
  expect(stageHeight).toBeGreaterThan(150)
  await page.screenshot({ path: path.join(SCREENSHOTS, 'v7-phone-stage-open.png') })

  await countNegotiations(page)
  await countNegotiations(ayse.page)
  await collapse.tap()
  await expect(frame).toHaveAttribute('data-collapsed', 'true')
  const pill = page.getByTestId('stage-expand')
  await expect(pill).toBeInViewport({ ratio: 1 })
  await expect(pill).toContainText('Ayşe ekranı')
  expect((await pill.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  await expect(page.getByTestId('remote-video')).toBeHidden()
  // The pill is much shorter than the stage was: the messages get the room.
  expect((await pill.boundingBox())!.height).toBeLessThan(stageHeight / 3)
  await expect(page.getByTestId('composer')).toBeInViewport({ ratio: 1 })
  await page.screenshot({ path: path.join(SCREENSHOTS, 'v7-phone-stage-collapsed.png') })

  // Still received and decoded while hidden, still counted as watching, nothing renegotiated.
  const before = await screenIn(mehmet, ayse)
  await window_(2000)
  const after = await screenIn(mehmet, ayse)
  expect(after.bytes - before.bytes, 'screen bytes received while collapsed').toBeGreaterThan(10_000)
  expect(after.frames - before.frames, 'screen frames decoded while collapsed').toBeGreaterThan(5)
  await expect(ayse.page.getByTestId('local-watchers')).toHaveAttribute('data-count', '1')
  expect((await negotiationCounts(page)).offers).toBe(0)
  expect((await negotiationCounts(ayse.page)).offers).toBe(0)
  await expectHearing(mehmet, ayse)

  // Remembered on this device: after a reload and a rejoin it is still collapsed.
  expect(await page.evaluate(() => localStorage.getItem('trio.v7.stageCollapsed'))).toBe('1')
  await page.reload()
  await joinVoiceOnPhone(mehmet, SOHBET)
  await expect(page.getByTestId('stage-frame')).toHaveAttribute('data-collapsed', 'true')
  await expect(page.getByTestId('stage-expand')).toContainText('Ayşe ekranı')

  // Open again: the tile is back and decoding.
  await page.getByTestId('stage-expand').tap()
  await expect(page.getByTestId('stage-frame')).toHaveAttribute('data-collapsed', 'false')
  await expectScreensDecoding(page, 1)
  expect(await page.evaluate(() => localStorage.getItem('trio.v7.stageCollapsed'))).toBeNull()

  // A wide screen never offers it (and a stored choice does not hide its stage).
  await ayse.page.evaluate(() => localStorage.setItem('trio.v7.stageCollapsed', '1'))
  await expect(ayse.page.getByTestId('stage-collapse')).toHaveCount(0)
  await expect(ayse.page.getByTestId('local-video')).toBeVisible()
})
