/**
 * Moving the pixels of lib/photoPlan.ts: decode (with the EXIF orientation
 * applied), scale, encode. Runs inside the photo worker (OffscreenCanvas), or
 * on the page when no worker can do it. Never throws: a picture this browser
 * cannot decode (HEIC on Chromium) answers `{ decoded: false }` and goes up
 * unchanged.
 */
import { chooseEncoding, hasTransparency, keepSmaller, planPhoto, PREVIEW_MAX_BYTES, PREVIEW_QUALITY, type Size } from './photoPlan'

export interface ProcessRequest {
  file: Blob
  /** The type lib/photoPlan.ts `photoType` decided. */
  type: string
  sendOriginal: boolean
}

export type ProcessResult =
  | { decoded: false }
  | {
      decoded: true
      /** The shown size (orientation applied). */
      width: number
      height: number
      /** The smaller copy, or null to send the original. */
      encoded: Blob | null
      preview: Blob | null
      /** Whether a smaller copy WOULD be made with "Orijinali gönder" off (the chip's toggle shows then). */
      reducible: boolean
    }

interface Surface {
  canvas: OffscreenCanvas | HTMLCanvasElement
  context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D
}

function surface(size: Size): Surface | null {
  let canvas: OffscreenCanvas | HTMLCanvasElement
  if (typeof OffscreenCanvas === 'function') canvas = new OffscreenCanvas(size.width, size.height)
  else if (typeof document !== 'undefined') {
    canvas = document.createElement('canvas')
    canvas.width = size.width
    canvas.height = size.height
  } else return null
  const context = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null
  if (!context) return null
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  return { canvas, context }
}

async function encode(canvas: OffscreenCanvas | HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  try {
    if ('convertToBlob' in canvas) return await canvas.convertToBlob({ type, quality })
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality))
  } catch {
    return null
  }
}

/** The output type a canvas REALLY produces for WebP (Safari < 17 answers with PNG). */
async function webpWorks(): Promise<boolean> {
  const probe = surface({ width: 2, height: 2 })
  if (!probe) return false
  const blob = await encode(probe.canvas, 'image/webp', 0.8)
  return blob !== null && blob.type === 'image/webp'
}

let webpSupport: Promise<boolean> | null = null

function draw(bitmap: ImageBitmap, size: Size): Surface | null {
  const target = surface(size)
  if (!target) return null
  target.context.drawImage(bitmap, 0, 0, size.width, size.height)
  return target
}

export async function processPhoto(request: ProcessRequest): Promise<ProcessResult> {
  let bitmap: ImageBitmap
  try {
    // 'from-image': a phone photo stored sideways with an EXIF "rotate" stands up.
    bitmap = await createImageBitmap(request.file, { imageOrientation: 'from-image' })
  } catch {
    return { decoded: false }
  }
  try {
    const { width, height } = bitmap
    if (!(width > 0 && height > 0)) return { decoded: false }
    const plan = planPhoto({ type: request.type, size: request.file.size, width, height, sendOriginal: request.sendOriginal })
    const reducible = planPhoto({ type: request.type, size: request.file.size, width, height, sendOriginal: false }).downscale
    webpSupport ??= webpWorks()
    const webp = await webpSupport

    let encoded: Blob | null = null
    if (plan.downscale) {
      const scaled = draw(bitmap, plan.target)
      if (scaled) {
        // Only a PNG (or WebP) can carry alpha; looked at only when JPEG is the fallback.
        const alpha =
          !webp && request.type !== 'image/jpeg'
            ? hasTransparency(scaled.context.getImageData(0, 0, plan.target.width, plan.target.height).data)
            : false
        const type = chooseEncoding(webp, alpha)
        const blob = type ? await encode(scaled.canvas, type, plan.quality) : null
        if (blob && blob.type === type && keepSmaller(request.file.size, blob.size)) encoded = blob
      }
    }

    let preview: Blob | null = null
    if (plan.preview) {
      const small = draw(bitmap, plan.preview)
      if (small) {
        const type = webp ? 'image/webp' : 'image/jpeg'
        if (type === 'image/jpeg') {
          // JPEG has no alpha: the app's own background behind a transparent picture.
          small.context.globalCompositeOperation = 'destination-over'
          small.context.fillStyle = '#1a1d24'
          small.context.fillRect(0, 0, plan.preview.width, plan.preview.height)
        }
        for (const quality of [PREVIEW_QUALITY, 0.6, 0.45]) {
          const blob = await encode(small.canvas, type, quality)
          if (blob && blob.type === type && blob.size <= PREVIEW_MAX_BYTES) {
            preview = blob
            break
          }
        }
      }
    }
    return { decoded: true, width, height, encoded, preview, reducible }
  } finally {
    bitmap.close()
  }
}
