/**
 * Helpers for the V6 media specs (45–49): real pictures made in a page, an EXIF
 * segment with an orientation and a GPS position, reading what the server
 * stored, and the attachments API.
 */
import type { Locator, Page } from '@playwright/test'
import { baseUrl } from './server'
import { expect, type Person } from './trio'

/**
 * A JPEG of `width × height` drawn in the page: noise (so it is a few MB, like
 * a phone photo) with a solid red band along the LEFT edge of the stored
 * pixels. With EXIF orientation 6 ("rotate 90° clockwise to show") that band
 * is the TOP of the picture as shown.
 */
export async function noisyJpeg(page: Page, width: number, height: number, quality = 0.92): Promise<Buffer> {
  const base64 = await page.evaluate(
    async ([w, h, q]) => {
      const canvas = new OffscreenCanvas(w, h)
      const g = canvas.getContext('2d')!
      const image = g.createImageData(w, h)
      const data = image.data
      let seed = 12345
      for (let i = 0; i < data.length; i += 4) {
        seed = (seed * 1103515245 + 12345) >>> 0
        data[i] = 60 + (seed & 0x7f)
        data[i + 1] = 90 + ((seed >> 8) & 0x7f)
        data[i + 2] = 120 + ((seed >> 16) & 0x7f)
        data[i + 3] = 255
      }
      g.putImageData(image, 0, 0)
      g.fillStyle = '#ff0000'
      g.fillRect(0, 0, Math.round(w / 10), h)
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: q })
      const bytes = new Uint8Array(await blob.arrayBuffer())
      let binary = ''
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      return btoa(binary)
    },
    [width, height, quality] as const,
  )
  return Buffer.from(base64, 'base64')
}

/** A PNG drawn in the page; `transparent` leaves the right half fully transparent. */
export async function drawnPng(page: Page, width: number, height: number, transparent = false): Promise<Buffer> {
  const base64 = await page.evaluate(
    async ([w, h, t]) => {
      const canvas = new OffscreenCanvas(w, h)
      const g = canvas.getContext('2d')!
      const image = g.createImageData(w, h)
      let seed = 7
      for (let i = 0; i < image.data.length; i += 4) {
        seed = (seed * 1103515245 + 12345) >>> 0
        const x = (i / 4) % w
        const y = Math.floor(i / 4 / w)
        // A photo-like picture: smooth gradients with a little grain.
        image.data[i] = Math.round((x * 230) / w) + (seed >>> 29)
        image.data[i + 1] = Math.round((y * 230) / h) + ((seed >>> 26) & 7)
        image.data[i + 2] = 160
        image.data[i + 3] = t && x >= w / 2 ? 0 : 255
      }
      g.putImageData(image, 0, 0)
      const blob = await canvas.convertToBlob({ type: 'image/png' })
      const bytes = new Uint8Array(await blob.arrayBuffer())
      let binary = ''
      for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      return btoa(binary)
    },
    [width, height, transparent] as const,
  )
  return Buffer.from(base64, 'base64')
}

/** An EXIF APP1 segment: IFD0 Orientation + a GPS IFD (41° 0' 30" N, 28° 58' 40" E — İstanbul). */
export function exifSegment(orientation: number): Buffer {
  // TIFF little-endian; offsets are from the start of the TIFF header.
  const entries: Buffer[] = []
  const entry = (tag: number, type: number, count: number, value: number) => {
    const b = Buffer.alloc(12)
    b.writeUInt16LE(tag, 0)
    b.writeUInt16LE(type, 2)
    b.writeUInt32LE(count, 4)
    if (type === 3 && count === 1) b.writeUInt16LE(value, 8)
    else b.writeUInt32LE(value, 8)
    return b
  }
  const ifd0Offset = 8
  const ifd0Size = 2 + 2 * 12 + 4
  const gpsOffset = ifd0Offset + ifd0Size
  const gpsCount = 4
  const gpsSize = 2 + gpsCount * 12 + 4
  const ratOffset = gpsOffset + gpsSize
  entries.push(entry(0x0112, 3, 1, orientation), entry(0x8825, 4, 1, gpsOffset))
  const ifd0 = Buffer.concat([Buffer.from([2, 0]), ...entries, Buffer.alloc(4)])
  const rationals = (values: number[]) => {
    const b = Buffer.alloc(values.length * 8)
    values.forEach((v, i) => {
      b.writeUInt32LE(v, i * 8)
      b.writeUInt32LE(1, i * 8 + 4)
    })
    return b
  }
  const lat = rationals([41, 0, 30])
  const lon = rationals([28, 58, 40])
  const gpsEntries = [
    (() => {
      const b = entry(0x0001, 2, 2, 0)
      b.write('N\0', 8, 'latin1')
      return b
    })(),
    entry(0x0002, 5, 3, ratOffset),
    (() => {
      const b = entry(0x0003, 2, 2, 0)
      b.write('E\0', 8, 'latin1')
      return b
    })(),
    entry(0x0004, 5, 3, ratOffset + 24),
  ]
  const gps = Buffer.concat([Buffer.from([gpsCount, 0]), ...gpsEntries, Buffer.alloc(4)])
  const tiff = Buffer.concat([Buffer.from('II*\0', 'latin1'), Buffer.from([8, 0, 0, 0]), ifd0, gps, lat, lon])
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff])
  const header = Buffer.alloc(4)
  header.writeUInt8(0xff, 0)
  header.writeUInt8(0xe1, 1)
  header.writeUInt16BE(body.length + 2, 2)
  return Buffer.concat([header, body])
}

/** `jpeg` with `segment` right after its SOI marker. */
export function withSegment(jpeg: Buffer, segment: Buffer): Buffer {
  return Buffer.concat([jpeg.subarray(0, 2), segment, jpeg.subarray(2)])
}

/** The chunk ids of a RIFF/WebP file ("VP8 ", "VP8X", "EXIF", "XMP "...). */
export function webpChunks(data: Buffer): string[] {
  const chunks: string[] = []
  let pos = 12
  while (pos + 8 <= data.length) {
    const id = data.toString('latin1', pos, pos + 4)
    const size = data.readUInt32LE(pos + 4)
    chunks.push(id)
    pos += 8 + size + (size & 1)
  }
  return chunks
}

export interface WireAttachment {
  id: string
  filename: string
  content_type: string
  size: number
  url: string
  preview_url: string | null
  width: number | null
  height: number | null
  voice: { duration_ms: number; waveform: number[] } | null
}

/** The newest message's attachments in a channel, through the API. */
export async function lastAttachments(token: string, channelId: number): Promise<WireAttachment[]> {
  const response = await fetch(`${baseUrl()}/api/channels/${channelId}/messages?limit=1`, { headers: { Authorization: `Bearer ${token}` } })
  const page = (await response.json()) as { messages: { attachments: WireAttachment[] }[] }
  return page.messages[0]?.attachments ?? []
}

export async function fetchBytes(path: string): Promise<{ status: number; type: string | null; bytes: Buffer }> {
  const response = await fetch(`${baseUrl()}${path}`)
  return { status: response.status, type: response.headers.get('content-type'), bytes: Buffer.from(await response.arrayBuffer()) }
}

/** Every chip of the composer is uploaded. */
export async function chipsDone(page: Page, count: number): Promise<void> {
  await expect(page.getByTestId('pending-attachment')).toHaveCount(count, { timeout: 30_000 })
  await expect(page.locator('[data-testid="pending-attachment"][data-status="done"]')).toHaveCount(count, { timeout: 30_000 })
}

/** Send what the composer holds (attachments, optional text) and wait for it to be stored. */
export async function sendComposer(person: Person, text = ''): Promise<void> {
  const page = person.page
  if (text) await page.getByTestId('composer').fill(text)
  await page.getByTestId('composer-send').click()
  await expect(page.getByTestId('pending-attachment')).toHaveCount(0)
  await expect(page.getByTestId('message').last()).toHaveAttribute('data-status', 'sent')
}

/** What a page decodes for an image element: natural size, and the colour near its top and bottom. */
export async function decodedImage(img: Locator): Promise<{ w: number; h: number; top: number[]; bottom: number[] } | null> {
  if ((await img.count()) === 0) return null
  return img.first().evaluate((element: HTMLImageElement) => {
    if (!element.complete || element.naturalWidth === 0) return null
    const canvas = new OffscreenCanvas(element.naturalWidth, element.naturalHeight)
    const g = canvas.getContext('2d')!
    g.drawImage(element, 0, 0)
    const at = (x: number, y: number) => [...g.getImageData(Math.floor(x), Math.floor(y), 1, 1).data]
    return {
      w: element.naturalWidth,
      h: element.naturalHeight,
      top: at(element.naturalWidth / 2, element.naturalHeight * 0.03),
      bottom: at(element.naturalWidth / 2, element.naturalHeight * 0.97),
    }
  })
}

/**
 * A photo made IN the page (`noisyJpeg`'s picture, `segment` spliced in after
 * SOI) and kept as `window.__photo`, a File: handing a large buffer to the page
 * through Playwright (`setInputFiles`) itself blocks the page's thread for
 * most of a second, which would be measured as the app's stall.
 */
export async function photoInPage(page: Page, width: number, height: number, segment: Buffer, name: string): Promise<number> {
  return page.evaluate(
    async ([w, h, seg, fileName]) => {
      const canvas = new OffscreenCanvas(w, h)
      const g = canvas.getContext('2d')!
      const image = g.createImageData(w, h)
      const data = image.data
      let seed = 12345
      for (let i = 0; i < data.length; i += 4) {
        seed = (seed * 1103515245 + 12345) >>> 0
        data[i] = 60 + (seed & 0x7f)
        data[i + 1] = 90 + ((seed >> 8) & 0x7f)
        data[i + 2] = 120 + ((seed >> 16) & 0x7f)
        data[i + 3] = 255
      }
      g.putImageData(image, 0, 0)
      g.fillStyle = '#ff0000'
      g.fillRect(0, 0, Math.round(w / 10), h)
      const jpeg = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 })).arrayBuffer())
      const extra = Uint8Array.from(atob(seg), (c) => c.charCodeAt(0))
      const file = new File([jpeg.subarray(0, 2), extra, jpeg.subarray(2)], fileName, { type: 'image/jpeg' })
      ;(window as unknown as { __photo: File }).__photo = file
      return file.size
    },
    [width, height, segment.toString('base64'), name] as const,
  )
}

/** Drop `window.__photo` onto the chat, as a drag from the desktop would. */
export async function dropPhoto(page: Page): Promise<void> {
  await page.evaluate(() => {
    const data = new DataTransfer()
    data.items.add((window as unknown as { __photo: File }).__photo)
    const main = document.querySelector('main')!
    main.dispatchEvent(new DragEvent('dragenter', { dataTransfer: data, bubbles: true, cancelable: true }))
    main.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }))
  })
}
