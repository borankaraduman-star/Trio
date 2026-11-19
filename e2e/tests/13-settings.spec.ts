import type { Page } from '@playwright/test'
import { CHROMIUM_ARGS } from '../playwright.config'
import { expectTileDecoding, localDescriptions, sentAudioTrackIds } from '../lib/media'
import { freshServer } from '../lib/server'
import { expect, expectConnected, expectHearing, joinVoice, test, threePeople } from '../lib/trio'
import { settingsTab } from '../lib/v7phone'

// Three fake cameras (and, as always, two fake microphones and outputs
// besides the defaults). The second fake camera of Chromium 153 shows in a
// <video> but gives a WebRTC encoder no frames at all (measured: 0 frames
// encoded, in a bare loopback too), so the switch goes to the third.
test.use({
  launchOptions: {
    args: CHROMIUM_ARGS.map((arg) =>
      arg === '--use-fake-device-for-media-stream' ? '--use-fake-device-for-media-stream=device-count=3' : arg,
    ),
  },
})

test.beforeEach(async () => {
  await freshServer()
})

/** Labels of the live microphone and camera tracks the page opened. */
async function liveDevices(page: Page): Promise<{ mic: string[]; camera: string[] }> {
  return page.evaluate(() => {
    const w = window as unknown as { __trioMicTracks: MediaStreamTrack[]; __trioCameraTracks: MediaStreamTrack[] }
    const live = (tracks: MediaStreamTrack[]) => tracks.filter((t) => t.readyState === 'live').map((t) => t.label)
    return { mic: live(w.__trioMicTracks), camera: live(w.__trioCameraTracks) }
  })
}

/** The label of the camera track this page SENDS (every connection sends the same one). */
async function sentCamera(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    (window as unknown as { __trioPcs: RTCPeerConnection[] }).__trioPcs
      .filter((pc) => pc.connectionState !== 'closed')
      .flatMap((pc) => pc.getSenders().filter((s) => s.track?.kind === 'video').map((s) => s.track!.label)),
  )
}

const options = (page: Page, testId: string) =>
  page.getByTestId(testId).locator('option').evaluateAll((list) => list.map((o) => o.textContent))

test('settings: devices switch live in a call, the output device is used, everything persists across a reload', async ({ browser, trio }) => {
  test.setTimeout(150_000)
  const people = await threePeople(browser, trio)
  const [ayse, mehmet, zeynep] = people
  for (const person of people) await joinVoice(person)
  await ayse.page.getByTestId('btn-camera').click()
  for (const viewer of [mehmet, zeynep]) await expectTileDecoding(viewer.page, `remote-camera-${ayse.user.id}`, 'camera', 'Ayşe')
  expect(await liveDevices(ayse.page)).toEqual({ mic: ['Fake Default Audio Input'], camera: ['fake_device_0'] })

  await ayse.page.getByTestId('btn-settings').click()
  const dialog = ayse.page.getByTestId('settings-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('heading', { name: 'Ayarlar' })).toBeVisible()
  expect(await options(ayse.page, 'settings-mic')).toEqual(['Sistem varsayılanı', 'Fake Audio Input 1', 'Fake Audio Input 2'])
  await settingsTab(ayse.page, 'goruntu')
  expect(await options(ayse.page, 'settings-camera')).toEqual(['Sistem varsayılanı', 'fake_device_0', 'fake_device_1', 'fake_device_2'])
  await settingsTab(ayse.page, 'ses')
  expect(await options(ayse.page, 'settings-output')).toEqual(['Sistem varsayılanı', 'Fake Audio Output 1', 'Fake Audio Output 2'])

  const tracks = await sentAudioTrackIds(ayse.page)
  const sdp = await localDescriptions(ayse.page)

  // Microphone: the raw device changes, the sent track and the negotiation do not.
  await ayse.page.getByTestId('settings-mic').selectOption({ label: 'Fake Audio Input 2' })
  await expect.poll(async () => (await liveDevices(ayse.page)).mic).toEqual(['Fake Audio Input 2'])
  expect(await sentAudioTrackIds(ayse.page)).toEqual(tracks)
  // Camera: replaceTrack, the tile keeps decoding for the others.
  await settingsTab(ayse.page, 'goruntu')
  await ayse.page.getByTestId('settings-camera').selectOption({ label: 'fake_device_2' })
  await expect.poll(async () => (await liveDevices(ayse.page)).camera).toEqual(['fake_device_2'])
  await expect.poll(() => sentCamera(ayse.page)).toEqual(['fake_device_2', 'fake_device_2'])
  expect(await localDescriptions(ayse.page)).toEqual(sdp)
  for (const viewer of [mehmet, zeynep]) {
    await expectTileDecoding(viewer.page, `remote-camera-${ayse.user.id}`, 'camera', 'Ayşe')
    await expectHearing(viewer, ayse)
  }

  // Output: every remote voice plays on the chosen device.
  await settingsTab(ayse.page, 'ses')
  const output = await ayse.page.getByTestId('settings-output').locator('option', { hasText: 'Fake Audio Output 1' }).getAttribute('value')
  await ayse.page.getByTestId('settings-output').selectOption({ label: 'Fake Audio Output 1' })
  for (const other of [mehmet, zeynep]) {
    await expect.poll(() => ayse.page.getByTestId(`remote-audio-${other.user.id}`).evaluate((el: HTMLAudioElement) => el.sinkId)).toBe(output)
  }
  await expectHearing(ayse, mehmet)

  // Push-to-talk with a key bound by pressing it; Esc cancels a binding.
  await ayse.page.getByTestId('settings-mode-ptt').check()
  await expect(ayse.page.getByTestId('settings-ptt-key')).toHaveText('` (Backquote)')
  await ayse.page.getByTestId('settings-ptt-bind').click()
  await expect(ayse.page.getByTestId('settings-ptt-bind')).toHaveText('Bir tuşa bas… (Esc: vazgeç)')
  await ayse.page.keyboard.press('KeyV')
  await expect(ayse.page.getByTestId('settings-ptt-key')).toHaveText('V')
  await ayse.page.getByTestId('settings-ptt-bind').click()
  await ayse.page.keyboard.press('Escape')
  await expect(ayse.page.getByTestId('settings-ptt-key')).toHaveText('V')
  await expect(dialog).toBeVisible()
  await expect(ayse.page.getByTestId('settings-transmitting')).toHaveAttribute('data-on', 'false')
  await ayse.page.getByTestId('settings-noise').uncheck()
  await ayse.page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)

  const stored = await ayse.page.evaluate(() => JSON.parse(localStorage.getItem('trio.settings')!))
  expect(stored).toMatchObject({
    inputMode: 'ptt',
    pttKey: 'KeyV',
    noiseSuppression: false,
    outputDeviceId: output,
    micDeviceLabel: 'Fake Audio Input 2',
    cameraDeviceLabel: 'fake_device_2',
    outputDeviceLabel: 'Fake Audio Output 1',
  })

  // After a reload: the same choices, and they are what the next call uses.
  // (This Chromium hands out new device ids on every load, as Chrome does for
  // a one-time permission: the choices are found again by their names.)
  await ayse.page.reload()
  await expectConnected(ayse.page)
  await ayse.page.getByTestId('btn-settings').click()
  await expect(ayse.page.getByTestId('settings-mode-ptt')).toBeChecked()
  await expect(ayse.page.getByTestId('settings-ptt-key')).toHaveText('V')
  await expect(ayse.page.getByTestId('settings-noise')).not.toBeChecked()
  await expect(ayse.page.getByTestId('settings-mic').locator('option:checked')).toHaveText('Fake Audio Input 2')
  await settingsTab(ayse.page, 'goruntu')
  await expect(ayse.page.getByTestId('settings-camera').locator('option:checked')).toHaveText('fake_device_2')
  await settingsTab(ayse.page, 'ses')
  await expect(ayse.page.getByTestId('settings-output').locator('option:checked')).toHaveText('Fake Audio Output 1')
  const outputNow = await ayse.page.getByTestId('settings-output').inputValue()
  await ayse.page.getByTestId('settings-close').click()

  await joinVoice(ayse)
  await expect(ayse.page.getByTestId('btn-settings')).toHaveAttribute('data-noise', 'off')
  await expect(ayse.page.getByTestId('btn-mute')).toHaveAttribute('data-transmitting', 'false')
  await ayse.page.getByTestId('btn-camera').click()
  await expect.poll(() => liveDevices(ayse.page)).toEqual({ mic: ['Fake Audio Input 2'], camera: ['fake_device_2'] })
  await expectTileDecoding(mehmet.page, `remote-camera-${ayse.user.id}`, 'camera', 'Ayşe')
  for (const other of [mehmet, zeynep]) {
    await expect.poll(() => ayse.page.getByTestId(`remote-audio-${other.user.id}`).evaluate((el: HTMLAudioElement) => el.sinkId)).toBe(outputNow)
  }
  // The bound key opens the microphone.
  await ayse.page.locator('.main-header h1').click()
  await ayse.page.keyboard.down('KeyV')
  await expect(ayse.page.getByTestId('btn-mute')).toHaveAttribute('data-transmitting', 'true')
  await expectHearing(mehmet, ayse)
  await ayse.page.keyboard.up('KeyV')
})
