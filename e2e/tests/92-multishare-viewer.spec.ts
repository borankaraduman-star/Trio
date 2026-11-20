/**
 * CONTRACT-V12-WATCHING §3–§5: two people share, the third follows both.
 *
 * - "Sen de paylaş": the second sharer is told plainly that sharing too does
 *   not stop the first (button, tooltip, one-line tip once);
 * - Yan yana / Odak, the arrows, the layout remembered;
 * - "only pay for what you watch": every place reports how large it shows a
 *   share and the SHARER encodes that size for that one viewer — read from
 *   the sharer's sender parameters and outbound statistics, never assumed;
 * - Hafif izleme and Sadece ses: video bytes to that viewer stop, the share's
 *   sound keeps flowing;
 * - none of it renegotiates (offers counted before and after).
 */
import { freshServer } from '../lib/server'
import { crowd } from '../lib/groups'
import { expect, joinVoice, test, type Person } from '../lib/trio'
import { NEGOTIATION_PROBE, negotiationLog } from '../lib/v8music'
import { expectDecodingFrom, screenReceive, screenSend, SCREEN_WITH_TONE } from '../lib/v12multishare'
import { SCREENSHOTS } from '../lib/v7phone'
import path from 'node:path'

test.beforeEach(async () => {
  await freshServer()
})

const prepare = async (context: import('@playwright/test').BrowserContext) => {
  await context.addInitScript(NEGOTIATION_PROBE)
  await context.addInitScript(SCREEN_WITH_TONE)
}

/** The sharer's encoding towards `viewer`, read until `check` holds. */
async function towards(sharer: Person, viewer: Person, check: (s: Awaited<ReturnType<typeof screenSend>>[number]) => boolean, what: string) {
  let last: Awaited<ReturnType<typeof screenSend>>[number] | undefined
  await expect
    .poll(
      async () => {
        last = (await screenSend(sharer, 1500)).find((s) => s.viewer === viewer.user.id)
        return last !== undefined && check(last)
      },
      { timeout: 20_000, message: what },
    )
    .toBe(true)
  return last!
}

/** The share's sound (audio bytes) reaching `viewer` from `sharer`'s screen stream. */
async function shareAudioBytes(viewer: Person, sharer: Person): Promise<number> {
  return viewer.page.evaluate(async (sharerId) => {
    const video = document.querySelector<HTMLVideoElement>(`figure.call-tile.screen[data-user-id="${sharerId}"] video`)
    const track = (video?.srcObject as MediaStream | null)?.getAudioTracks()[0]
    if (!track) return -1
    for (const pc of (window as unknown as { __trioPcs: RTCPeerConnection[] }).__trioPcs) {
      const receiver = pc.getReceivers().find((r) => r.track === track)
      if (!receiver) continue
      let bytes = 0
      ;(await receiver.getStats()).forEach((s) => {
        if (s.type === 'inbound-rtp' && s.kind === 'audio') bytes = s.bytesReceived
      })
      return bytes
    }
    return -1
  }, sharer.user.id)
}

test('two shares: Sen de paylaş, Yan yana and Odak, each viewer sent the size it shows, Hafif and Sadece ses', async ({ browser, trio }) => {
  test.setTimeout(300_000)
  const [ayse, mehmet, zeynep] = await crowd(browser, trio, 3, { prepare, viewport: { width: 1440, height: 900 } })
  for (const person of [ayse, mehmet, zeynep]) await joinVoice(person)

  await ayse.page.getByTestId('btn-screen').click()
  await expectDecodingFrom(mehmet, [ayse.user.id])

  // Mehmet is told he may share too, that it stops nobody, once.
  await expect(mehmet.page.getByTestId('stage-sharing-line')).toHaveText('Ayşe ekran paylaşıyor')
  await expect(mehmet.page.getByTestId('btn-screen')).toHaveAttribute('aria-label', 'Sen de paylaş')
  await expect(mehmet.page.getByTestId('btn-screen')).toHaveAttribute('title', /birden fazla kişi/)
  await expect(mehmet.page.getByTestId('multishare-tip')).toContainText('Ayşe paylaşmayı sürdürür')
  await expect(mehmet.page.getByTestId('stage-share-too')).toHaveText('Sen de paylaş')
  await mehmet.page.getByTestId('stage-share-too').click()
  await expect(mehmet.page.getByTestId('btn-screen')).toHaveAttribute('aria-pressed', 'true')
  await expect(mehmet.page.getByTestId('multishare-tip')).toHaveCount(0)
  // Ayşe's share goes on.
  await expectDecodingFrom(mehmet, [ayse.user.id])
  await expectDecodingFrom(zeynep, [ayse.user.id, mehmet.user.id])
  await expect(zeynep.page.getByTestId('stage-sharing-line')).toHaveText('Ayşe ve Mehmet ekran paylaşıyor')
  await expect(ayse.page.getByTestId('stage-sharing-line')).toHaveText('Mehmet ve Sen ekran paylaşıyor')

  // Yan yana: two equal tiles next to each other.
  const stage = zeynep.page.getByTestId('stage')
  await expect(stage).toHaveAttribute('data-layout', 'side')
  const boxes = await zeynep.page.locator('.v12-main figure.call-tile.screen').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON()))
  expect(boxes).toHaveLength(2)
  expect(Math.abs(boxes[0].width - boxes[1].width)).toBeLessThan(2)
  expect(Math.abs(boxes[0].top - boxes[1].top)).toBeLessThan(2)
  await zeynep.page.screenshot({ path: path.join(SCREENSHOTS, 'v12-multishare-1440-2-side.png') })

  // Two shares' sound at once (both fake captures carry a tone): both flow, each with its own volume.
  const sa = await shareAudioBytes(zeynep, ayse)
  const sm = await shareAudioBytes(zeynep, mehmet)
  await zeynep.page.waitForTimeout(1500)
  expect(await shareAudioBytes(zeynep, ayse)).toBeGreaterThan(sa + 2000)
  expect(await shareAudioBytes(zeynep, mehmet)).toBeGreaterThan(sm + 2000)
  await zeynep.page.getByTestId(`tile-menu-${ayse.user.id}`).click()
  await zeynep.page.getByTestId(`tile-share-volume-${ayse.user.id}`).fill('40')
  await zeynep.page.keyboard.press('Escape')
  const volumeOf = (id: number) => zeynep.page.locator(`figure.call-tile.screen[data-user-id="${id}"] video`).getAttribute('data-volume')
  await expect.poll(() => volumeOf(ayse.user.id)).toBe('0.4')
  expect(await volumeOf(mehmet.user.id)).toBe('1')

  const offersBefore = (await negotiationLog(ayse.page)).offers + (await negotiationLog(mehmet.page)).offers + (await negotiationLog(zeynep.page)).offers

  // Full size for both while side by side at 1440 (each tile ~ 600 lines? the sender says).
  const sideA = await towards(ayse, zeynep, (s) => s.maxBitrate !== null, 'Ayşe encodes for Zeynep')
  console.log(`[92] side by side at 1440: Ayşe→Zeynep maxBitrate ${sideA.maxBitrate} scale ${sideA.scale} ${Math.round(sideA.kbps)} kbit/s h ${sideA.height}`)

  // Odak: Ayşe large, Mehmet in the strip → Mehmet sends Zeynep a thumbnail.
  await zeynep.page.getByTestId('stage-mode-focus').click()
  await expect(stage).toHaveAttribute('data-layout', 'focus')
  const thumb = await towards(mehmet, zeynep, (s) => s.maxBitrate === 300_000 && (s.scale ?? 1) >= 2.9, 'Mehmet sends Zeynep a thumbnail')
  // ...while Ayşe (seen by Mehmet in Yan yana) is not affected for Mehmet.
  const forMehmet = (await screenSend(ayse, 1500)).find((s) => s.viewer === mehmet.user.id)!
  expect(forMehmet.maxBitrate).not.toBe(300_000)
  await zeynep.page.waitForTimeout(4000)
  const thumbOut = await towards(mehmet, zeynep, (s) => s.maxBitrate === 300_000, 'thumbnail settled')
  console.log(`[92] Odak strip: Mehmet→Zeynep ${Math.round(thumbOut.kbps)} kbit/s, ${Math.round(thumbOut.fps)} fps, h ${thumbOut.height}, scale ${thumb.scale}`)
  expect(thumbOut.fps).toBeLessThanOrEqual(13)
  expect(thumbOut.height).toBeLessThanOrEqual(362)
  await zeynep.page.screenshot({ path: path.join(SCREENSHOTS, 'v12-multishare-1440-2-focus.png') })

  // → moves the focus: Mehmet large, Ayşe small.
  await zeynep.page.locator('.v12-main figure.call-tile').focus()
  await zeynep.page.keyboard.press('ArrowRight')
  await expect(zeynep.page.locator('.v12-main figure.call-tile')).toHaveAttribute('data-user-id', String(mehmet.user.id))
  await towards(ayse, zeynep, (s) => s.maxBitrate === 300_000, 'Ayşe now sends Zeynep a thumbnail')
  await towards(mehmet, zeynep, (s) => s.maxBitrate !== 300_000, 'Mehmet now sends Zeynep more')
  await expectDecodingFrom(zeynep, [ayse.user.id, mehmet.user.id])

  // The layout is remembered on this device.
  expect(await zeynep.page.evaluate(() => JSON.parse(localStorage.getItem('trio.v12.watch') ?? '{}').stageMode)).toBe('focus')

  // Double click: the real fullscreen, and the full encoding.
  await zeynep.page.locator('.v12-main figure.call-tile').dblclick()
  await expect.poll(() => zeynep.page.evaluate(() => document.fullscreenElement?.getAttribute('data-user-id') ?? null)).toBe(String(mehmet.user.id))
  await towards(mehmet, zeynep, (s) => s.maxBitrate === 3_000_000 && (s.scale ?? 1) === 1, 'fullscreen is full size')
  // (A real Esc is the browser's; a test page leaves fullscreen itself.)
  await zeynep.page.evaluate(() => document.exitFullscreen())
  await expect.poll(() => zeynep.page.evaluate(() => document.fullscreenElement === null)).toBe(true)

  // Hafif izleme on the large one: a thumbnail even while large.
  await zeynep.page.getByTestId(`tile-menu-${mehmet.user.id}`).click()
  await zeynep.page.getByTestId(`tile-light-${mehmet.user.id}`).click()
  await towards(mehmet, zeynep, (s) => s.maxBitrate === 300_000, 'Hafif: a thumbnail for Zeynep')
  await expect(zeynep.page.getByTestId(`light-badge-${mehmet.user.id}`)).toBeVisible()
  await zeynep.page.waitForTimeout(4000)
  const full = await screenReceive(zeynep, 3000)
  console.log(`[92] Hafif: Zeynep receives Mehmet at ${Math.round(full[mehmet.user.id].kbps)} kbit/s, ${Math.round(full[mehmet.user.id].fps)} fps, h ${full[mehmet.user.id].height}`)

  // Sadece ses: no picture bytes, the share's sound goes on.
  await zeynep.page.getByTestId(`tile-menu-${mehmet.user.id}`).click()
  await zeynep.page.getByTestId(`tile-audio-${mehmet.user.id}`).click()
  await expect(zeynep.page.getByTestId(`audio-only-${mehmet.user.id}`)).toBeVisible()
  await towards(mehmet, zeynep, (s) => !s.active, 'Sadece ses: the picture to Zeynep is paused')
  await zeynep.page.waitForTimeout(1500)
  const a1 = await screenReceive(zeynep, 2500)
  expect(a1[mehmet.user.id].kbps).toBeLessThan(5)
  const s1 = await shareAudioBytes(zeynep, mehmet)
  await zeynep.page.waitForTimeout(1500)
  expect(await shareAudioBytes(zeynep, mehmet)).toBeGreaterThan(s1 + 2000)
  // Mehmet's audio still to Ayşe as a picture too.
  await expectDecodingFrom(ayse, [mehmet.user.id])
  // The sharer sees what each viewer is sent.
  await mehmet.page.getByTestId('btn-share-menu').click()
  await expect(mehmet.page.getByTestId('share-sending')).toContainText('Zeynep sadece ses')
  await mehmet.page.keyboard.press('Escape')

  // Back: frames again, fast.
  const back = Date.now()
  await zeynep.page.getByTestId(`audio-only-off-${mehmet.user.id}`).click()
  await expectDecodingFrom(zeynep, [mehmet.user.id])
  console.log(`[92] Sadece ses → picture again: decoding after ${Date.now() - back} ms`)

  // Not one renegotiation for any of it.
  const offersAfter = (await negotiationLog(ayse.page)).offers + (await negotiationLog(mehmet.page)).offers + (await negotiationLog(zeynep.page)).offers
  expect(offersAfter).toBe(offersBefore)
  for (const person of [ayse, mehmet, zeynep]) expect((await negotiationLog(person.page)).rollbacks).toBe(0)
})

test('three shares at 911 px (150 %) and on a phone: the layouts stay readable', async ({ browser, trio }) => {
  test.setTimeout(300_000)
  const people = await crowd(browser, trio, 4, (i) =>
    i === 3
      ? { viewport: { width: 911, height: 600 }, deviceScaleFactor: 1.5 }
      : i === 2
        ? { viewport: { width: 1440, height: 900 } }
        : {},
  )
  const [ayse, mehmet, zeynep, ali] = people
  for (const person of people) await joinVoice(person)
  for (const sharer of [ayse, mehmet]) await sharer.page.getByTestId('btn-screen').click()
  await expectDecodingFrom(ali, [ayse.user.id, mehmet.user.id])
  await ali.page.screenshot({ path: path.join(SCREENSHOTS, 'v12-multishare-911-2-side.png') })
  await zeynep.page.getByTestId('btn-screen').click()
  await expectDecodingFrom(ali, [ayse.user.id, mehmet.user.id, zeynep.user.id])
  await expect(ali.page.getByTestId('stage-sharing-line')).toHaveText('Ayşe, Mehmet ve Zeynep ekran paylaşıyor')
  await ali.page.screenshot({ path: path.join(SCREENSHOTS, 'v12-multishare-911-3-side.png') })
  await ali.page.getByTestId('stage-mode-focus').click()
  await ali.page.screenshot({ path: path.join(SCREENSHOTS, 'v12-multishare-911-3-focus.png') })
  await zeynep.page.screenshot({ path: path.join(SCREENSHOTS, 'v12-multishare-1440-3-side.png') })
  // 1–9 picks a screen.
  await ali.page.getByTestId('stage').focus()
  await ali.page.keyboard.press('3')
  await expect(ali.page.locator('.v12-main figure.call-tile')).toHaveAttribute('data-user-id', String(zeynep.user.id))
})
