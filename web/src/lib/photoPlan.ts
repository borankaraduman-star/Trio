/**
 * What happens to a picked, pasted or dropped picture before it is uploaded
 * (CONTRACT-V6-MEDIA §1). Pure: the decisions and the size maths; the pixels
 * are moved by lib/photoProcess.ts.
 *
 * - A photo is scaled so its longest edge is at most 2048 px and encoded as
 *   WebP (quality 0.82; JPEG where the browser cannot encode WebP), and the
 *   result is used only when it is smaller than the original.
 * - GIFs are never touched (animation); a picture under 300 KB that already
 *   fits is left alone.
 * - A picture with transparency stays transparent: WebP keeps alpha, and when
 *   only JPEG is available the original is sent instead of a flattened copy.
 * - "Orijinali gönder" sends the file as picked.
 * - Re-encoding builds a new file from pixels, so EXIF (GPS, camera, time)
 *   is gone as a side effect.
 * - Independently, any image whose longest edge is over 960 px gets a 480 px
 *   preview for the message list and the gallery; a smaller one is shown
 *   as it is (a 480 px copy of it would be no lighter and blurrier).
 */

export const MAX_EDGE = 2048
export const SMALL_BYTES = 300 * 1024
export const QUALITY = 0.82
/** PNG sources are usually screenshots: text suffers first at lower quality. */
export const PNG_QUALITY = 0.9
export const PREVIEW_EDGE = 480
export const PREVIEW_MIN_SOURCE_EDGE = 960
export const PREVIEW_QUALITY = 0.75
/** The server refuses a larger preview (422 INVALID_PREVIEW). */
export const PREVIEW_MAX_BYTES = 200 * 1024

/** Types the browser may be able to decode and that are worth re-encoding. */
const PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'])

export interface Size {
  width: number
  height: number
}

/** `width × height` scaled to fit `max` on its longest edge (never enlarged); at least 1 px a side. */
export function fitWithin(width: number, height: number, max: number): Size {
  const longest = Math.max(width, height)
  if (longest <= max) return { width, height }
  const scale = max / longest
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

/** The type to treat a file as: the browser's, or from the name when the browser says nothing. */
export function photoType(file: { type: string; name: string }): string | null {
  const type = file.type.toLowerCase()
  if (type) return PHOTO_TYPES.has(type) ? type : null
  const ext = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase()
  const byExt: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    heic: 'image/heic',
    heif: 'image/heif',
  }
  return (ext && byExt[ext]) || null
}

/** Before decoding: is this file one we try to decode at all (for a smaller copy or a preview)? */
export function worthDecoding(file: { type: string; name: string }): boolean {
  return photoType(file) !== null
}

export interface PhotoPlan {
  /** Re-encode at `target`. */
  downscale: boolean
  target: Size
  quality: number
  /** A preview's size, or null for none. */
  preview: Size | null
}

/** Once the picture is decoded (its shown size known): what to make of it. */
export function planPhoto(input: { type: string; size: number; width: number; height: number; sendOriginal: boolean }): PhotoPlan {
  const { type, size, width, height, sendOriginal } = input
  const longest = Math.max(width, height)
  const small = size < SMALL_BYTES && longest <= MAX_EDGE
  const downscale = !sendOriginal && type !== 'image/gif' && !small
  return {
    downscale,
    target: fitWithin(width, height, MAX_EDGE),
    quality: type === 'image/png' ? PNG_QUALITY : QUALITY,
    preview: longest > PREVIEW_MIN_SOURCE_EDGE ? fitWithin(width, height, PREVIEW_EDGE) : null,
  }
}

/**
 * Which encoding to use for the smaller copy: WebP when it really encodes
 * (a browser without a WebP encoder answers with a PNG), else JPEG — unless
 * the picture has transparency, which JPEG would paint over: then none.
 */
export function chooseEncoding(webpWorks: boolean, hasAlpha: boolean): 'image/webp' | 'image/jpeg' | null {
  if (webpWorks) return 'image/webp'
  return hasAlpha ? null : 'image/jpeg'
}

/** The re-encoded copy is used only when it is really smaller. */
export function keepSmaller(originalBytes: number, encodedBytes: number): boolean {
  return encodedBytes > 0 && encodedBytes < originalBytes
}

/** "IMG_2041.JPG" → "IMG_2041.webp": the name follows the new type. */
export function renamed(name: string, type: string): string {
  const ext = type === 'image/webp' ? 'webp' : type === 'image/jpeg' ? 'jpg' : null
  if (!ext) return name
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  return `${stem}.${ext}`
}

/** Any pixel of an RGBA buffer that is not fully opaque. */
export function hasTransparency(rgba: ArrayLike<number>): boolean {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) return true
  return false
}

/** Per device: "Orijinali gönder" is off until the person turns it on. */
const ORIGINAL_KEY = 'trio.sendOriginal'

export function loadSendOriginal(storage: Pick<Storage, 'getItem'> | null = safeLocalStorage()): boolean {
  try {
    return storage?.getItem(ORIGINAL_KEY) === '1'
  } catch {
    return false
  }
}

export function saveSendOriginal(value: boolean, storage: Pick<Storage, 'setItem' | 'removeItem'> | null = safeLocalStorage()): void {
  try {
    if (value) storage?.setItem(ORIGINAL_KEY, '1')
    else storage?.removeItem(ORIGINAL_KEY)
  } catch {
    // Private mode: remembered for this page only.
  }
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}
