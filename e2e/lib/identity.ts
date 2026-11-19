/**
 * Helpers for the identity specs (CONTRACT-V4 C): real pictures drawn in a
 * page, a JPEG with an EXIF GPS block spliced in, uploading through Ayarlar,
 * and checks that a picture is really decoded.
 */
import type { Locator, Page } from '@playwright/test'
import { baseUrl } from './server'
import { expect, type Person } from './trio'

export interface Picture {
  name: string
  mimeType: string
  buffer: Buffer
}

/** A simple, recognisable picture drawn on a canvas in `page`: a background, a disc, a band. */
export async function drawPicture(
  page: Page,
  options: { width: number; height: number; background: string; disc: string; band: string; type?: 'image/png' | 'image/jpeg' },
): Promise<Buffer> {
  const base64 = await page.evaluate((o) => {
    const canvas = document.createElement('canvas')
    canvas.width = o.width
    canvas.height = o.height
    const g = canvas.getContext('2d')!
    g.fillStyle = o.background
    g.fillRect(0, 0, o.width, o.height)
    const r = Math.min(o.width, o.height) * 0.3
    g.fillStyle = o.band
    g.fillRect(0, o.height * 0.72, o.width, o.height * 0.28)
    g.fillStyle = o.disc
    g.beginPath()
    g.arc(o.width / 2, o.height * 0.42, r, 0, Math.PI * 2)
    g.fill()
    return canvas.toDataURL(o.type ?? 'image/png', 0.92).split(',')[1]
  }, options)
  return Buffer.from(base64, 'base64')
}

/**
 * A JPEG with an APP1 "Exif" segment holding a GPS IFD (latitude 41°N, the
 * kind of block a phone writes), inserted right after SOI. Browsers decode it
 * as an ordinary JPEG.
 */
export function withExifGps(jpeg: Buffer): Buffer {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('not a JPEG')
  // TIFF, big-endian. IFD0 at 8: one entry, GPSInfo (0x8825) → the GPS IFD at 26.
  const tiff = Buffer.alloc(26 + 2 + 3 * 12 + 4 + 24)
  tiff.write('MM', 0, 'ascii')
  tiff.writeUInt16BE(42, 2)
  tiff.writeUInt32BE(8, 4)
  tiff.writeUInt16BE(1, 8)
  tiff.writeUInt16BE(0x8825, 10)
  tiff.writeUInt16BE(4, 12) // LONG
  tiff.writeUInt32BE(1, 14)
  tiff.writeUInt32BE(26, 18)
  tiff.writeUInt32BE(0, 22) // no next IFD
  let at = 26
  tiff.writeUInt16BE(3, at)
  at += 2
  const dataAt = 26 + 2 + 3 * 12 + 4
  // GPSVersionID 2.3.0.0
  tiff.writeUInt16BE(0x0000, at); tiff.writeUInt16BE(1, at + 2); tiff.writeUInt32BE(4, at + 4)
  tiff.writeUInt8(2, at + 8); tiff.writeUInt8(3, at + 9)
  at += 12
  // GPSLatitudeRef "N"
  tiff.writeUInt16BE(0x0001, at); tiff.writeUInt16BE(2, at + 2); tiff.writeUInt32BE(2, at + 4)
  tiff.write('N\0', at + 8, 'ascii')
  at += 12
  // GPSLatitude 41/1, 0/1, 0/1
  tiff.writeUInt16BE(0x0002, at); tiff.writeUInt16BE(5, at + 2); tiff.writeUInt32BE(3, at + 4); tiff.writeUInt32BE(dataAt, at + 8)
  at += 12
  tiff.writeUInt32BE(0, at)
  const rationals = [41, 1, 0, 1, 0, 1]
  rationals.forEach((value, index) => tiff.writeUInt32BE(value, dataAt + index * 4))
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff])
  const header = Buffer.alloc(4)
  header.writeUInt16BE(0xffe1, 0)
  header.writeUInt16BE(payload.length + 2, 2)
  return Buffer.concat([jpeg.subarray(0, 2), header, payload, jpeg.subarray(2)])
}

/** Whether bytes carry an EXIF block (JPEG APP1 "Exif\0\0", or a WebP "EXIF" chunk). */
export function hasExif(bytes: Buffer): boolean {
  return bytes.includes(Buffer.from('Exif\0\0', 'binary')) || bytes.includes(Buffer.from('EXIF', 'ascii'))
}

export async function openSettings(person: Person): Promise<void> {
  const button = person.page.getByTestId('btn-settings')
  if (!(await button.isVisible())) await person.page.getByTestId('btn-drawer').click()
  await button.click()
  await expect(person.page.getByTestId('settings-dialog')).toBeVisible()
}

export async function closeSettings(person: Person): Promise<void> {
  await person.page.getByTestId('settings-close').click()
  await expect(person.page.getByTestId('settings-dialog')).toHaveCount(0)
}

/**
 * Pick `picture` in a picture field (`avatar` or `server-icon-field`), crop
 * as it opens (optionally after `adjust`), save; resolves with the JSON answer.
 */
export async function uploadThroughCropper(
  person: Person,
  field: 'avatar' | 'server-icon-field',
  picture: Picture,
  adjust?: () => Promise<void>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const page = person.page
  await page.getByTestId(`${field}-input`).setInputFiles(picture)
  await expect(page.getByTestId('cropper')).toBeVisible()
  await adjust?.()
  const path = field === 'avatar' ? '/api/me/avatar' : '/api/server/icon'
  const answer = page.waitForResponse((r) => new URL(r.url()).pathname === path && r.request().method() === 'PUT')
  await page.getByTestId('cropper-save').click()
  const response = await answer
  return { status: response.status(), body: (await response.json()) as Record<string, unknown> }
}

/** An `<img>` that has really been decoded (not merely present). */
export async function expectDecoded(image: Locator): Promise<void> {
  await expect(image).toHaveCount(1)
  await expect
    .poll(() => image.evaluate((img: HTMLImageElement) => (img.complete ? img.naturalWidth : 0)), {
      message: 'the picture should be decoded',
    })
    .toBeGreaterThan(0)
}

/** Every avatar picture `page` shows for `userId` in the member list, its messages and the voice room. */
export function avatarsOf(page: Page, userId: number) {
  return {
    member: page.getByTestId(`member-${userId}`).locator('.avatar'),
    messages: page.locator(`[data-testid="message"][data-author-id="${userId}"].with-header .avatar`),
    voice: page.getByTestId(`voice-user-${userId}`).locator('.avatar'),
  }
}

/** The bytes and the decoded size of a picture the server serves. */
export async function fetchPicture(page: Page, url: string): Promise<{ bytes: Buffer; width: number; height: number; type: string }> {
  const response = await fetch(`${baseUrl()}${url}`)
  expect(response.status).toBe(200)
  const bytes = Buffer.from(await response.arrayBuffer())
  const size = await page.evaluate(async (path) => {
    const blob = await (await fetch(path)).blob()
    const bitmap = await createImageBitmap(blob)
    const result = { width: bitmap.width, height: bitmap.height }
    bitmap.close()
    return result
  }, url)
  return { bytes, ...size, type: response.headers.get('content-type') ?? '' }
}

/** PUT a ready-made picture as somebody's avatar, through the API (for screenshots). */
export async function apiAvatar(token: string, picture: Picture): Promise<void> {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(picture.buffer)], { type: picture.mimeType }), picture.name)
  const response = await fetch(`${baseUrl()}/api/me/avatar`, { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: form })
  if (!response.ok) throw new Error(`avatar: ${response.status} ${await response.text()}`)
}
