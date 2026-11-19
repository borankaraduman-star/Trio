/**
 * Turning a picked picture into what the server takes for an avatar or the
 * server's icon (CONTRACT-V4 C): decoded in the browser, cropped to a square,
 * scaled to 256 × 256 and encoded again from canvas pixels. The new file is
 * built from pixels only, so EXIF (GPS, camera, time) never leaves the device.
 *
 * Nothing here needs a `blob:` or `data:` URL when `createImageBitmap` exists
 * (every current browser); the fallback uses an object URL, which the shell's
 * CSP allows for images (`img-src 'self' blob: data:`).
 */
import type { SourceRect } from './crop'

export const OUTPUT_SIZE = 256
/** The server's limit (`413 FILE_TOO_LARGE` past it). */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024
/** A picked file is only decoded up to this size (a 256 px result never needs more). */
export const MAX_PICKED_BYTES = 40 * 1024 * 1024

export interface DecodedImage {
  source: CanvasImageSource
  width: number
  height: number
  close: () => void
}

export class ImageDecodeError extends Error {
  constructor(readonly reason: 'not-image' | 'undecodable' | 'too-large') {
    super(reason)
    this.name = 'ImageDecodeError'
  }
}

/** HEIC/HEIF by type or name: most browsers cannot decode it. */
export function looksLikeHeic(file: { type: string; name: string }): boolean {
  return /hei[cf]/i.test(file.type) || /\.(heic|heif)$/i.test(file.name)
}

async function decodeWithElement(file: Blob): Promise<DecodedImage> {
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.decoding = 'async'
    image.src = url
    await image.decode()
    if (!(image.naturalWidth > 0)) throw new ImageDecodeError('undecodable')
    return { source: image, width: image.naturalWidth, height: image.naturalHeight, close: () => undefined }
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** Decode a picked file, with its EXIF orientation applied (a phone photo stands up). */
export async function decodeImage(file: File): Promise<DecodedImage> {
  if (file.size > MAX_PICKED_BYTES) throw new ImageDecodeError('too-large')
  if (file.type !== '' && !file.type.startsWith('image/')) throw new ImageDecodeError('not-image')
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
      if (bitmap.width > 0 && bitmap.height > 0) {
        return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() }
      }
      bitmap.close()
    } catch {
      // Unsupported format, or an old engine without options: try an element.
    }
  }
  try {
    return await decodeWithElement(file)
  } catch {
    throw new ImageDecodeError('undecodable')
  }
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob(resolve, type, quality)
    } catch {
      resolve(null)
    }
  })
}

/**
 * The encodings to try, best first. A browser that cannot encode WebP answers
 * `toBlob('image/webp')` with a PNG (Safari before 17) — so the RESULT's type
 * is what counts, checked at runtime, not a feature list.
 */
export const ENCODINGS: readonly { type: string; ext: string; quality: number }[] = [
  { type: 'image/webp', ext: 'webp', quality: 0.9 },
  { type: 'image/jpeg', ext: 'jpg', quality: 0.9 },
]

/** True when `toBlob` really produced the type asked for (not a silent PNG). */
export function isEncodedAs(blob: { type: string; size: number } | null, type: string): boolean {
  return blob !== null && blob.size > 0 && blob.type === type
}

/** Draw `rect` of `source` into a 256 × 256 square and encode it (WebP, else JPEG). */
export async function encodeSquare(
  source: CanvasImageSource,
  rect: SourceRect,
  size = OUTPUT_SIZE,
): Promise<{ blob: Blob; ext: string }> {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const context = canvas.getContext('2d')
  if (!context) throw new ImageDecodeError('undecodable')
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  // JPEG has no alpha: a transparent PNG gets the app's own background, not black.
  context.fillStyle = '#1a1d24'
  context.fillRect(0, 0, size, size)
  context.drawImage(source, rect.sx, rect.sy, rect.size, rect.size, 0, 0, size, size)
  for (const encoding of ENCODINGS) {
    const blob = await toBlob(canvas, encoding.type, encoding.quality)
    if (blob && isEncodedAs(blob, encoding.type)) return { blob, ext: encoding.ext }
  }
  throw new ImageDecodeError('undecodable')
}
