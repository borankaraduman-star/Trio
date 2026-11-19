/**
 * The square cropper's geometry, as pure functions (components/ImageCropper.tsx
 * draws it). A crop is the point of the IMAGE at the centre of the view and a
 * zoom: at zoom 1 the square's side is the image's shorter side, at zoom z it
 * is that divided by z. Kept in image pixels, so it does not depend on how big
 * the view is on screen, and the same crop gives the output.
 */

export interface Crop {
  /** Image pixels, the centre of the visible square. */
  cx: number
  cy: number
  /** 1 = the whole shorter side fills the square. */
  zoom: number
}

export interface ImageSize {
  width: number
  height: number
}

export interface SourceRect {
  sx: number
  sy: number
  /** Side of the square, image pixels. */
  size: number
}

/** The furthest one can zoom in: an 8th of the shorter side, and never past 32 px of image. */
export function maxZoom(image: ImageSize): number {
  const shorter = Math.min(image.width, image.height)
  if (!(shorter > 0)) return 1
  return Math.max(1, Math.min(8, shorter / 32))
}

function clamp(value: number, low: number, high: number): number {
  if (Number.isNaN(value)) return low
  return Math.min(high, Math.max(low, value))
}

/** The side of the visible square in image pixels. */
export function cropSide(crop: Crop, image: ImageSize): number {
  return Math.min(image.width, image.height) / crop.zoom
}

/** Zoom within [1, max], and the square entirely inside the image. */
export function clampCrop(crop: Crop, image: ImageSize): Crop {
  const zoom = clamp(crop.zoom, 1, maxZoom(image))
  const half = Math.min(image.width, image.height) / zoom / 2
  return {
    zoom,
    cx: clamp(crop.cx, half, image.width - half),
    cy: clamp(crop.cy, half, image.height - half),
  }
}

/** Centred, the whole shorter side. */
export function initialCrop(image: ImageSize): Crop {
  return clampCrop({ cx: image.width / 2, cy: image.height / 2, zoom: 1 }, image)
}

/** The part of the image the square shows (what is drawn into the output). */
export function sourceRect(crop: Crop, image: ImageSize): SourceRect {
  const c = clampCrop(crop, image)
  const size = cropSide(c, image)
  return { sx: c.cx - size / 2, sy: c.cy - size / 2, size }
}

/** Dragging the picture by (dx, dy) view pixels in a view `viewSize` pixels wide. */
export function panBy(crop: Crop, dx: number, dy: number, viewSize: number, image: ImageSize): Crop {
  if (!(viewSize > 0)) return crop
  const perViewPixel = cropSide(crop, image) / viewSize
  // The picture follows the finger: the centre moves the other way.
  return clampCrop({ ...crop, cx: crop.cx - dx * perViewPixel, cy: crop.cy - dy * perViewPixel }, image)
}

/**
 * Zoom to `zoom`, keeping the image point under (fx, fy) — view pixels, e.g.
 * the pointer or the middle of a pinch — where it is. Without a focus, the centre.
 */
export function zoomTo(
  crop: Crop,
  zoom: number,
  image: ImageSize,
  viewSize: number,
  focus: { x: number; y: number } = { x: viewSize / 2, y: viewSize / 2 },
): Crop {
  if (!(viewSize > 0)) return clampCrop({ ...crop, zoom }, image)
  const before = sourceRect(crop, image)
  const nextZoom = clamp(zoom, 1, maxZoom(image))
  const pointX = before.sx + (focus.x / viewSize) * before.size
  const pointY = before.sy + (focus.y / viewSize) * before.size
  const side = Math.min(image.width, image.height) / nextZoom
  const sx = pointX - (focus.x / viewSize) * side
  const sy = pointY - (focus.y / viewSize) * side
  return clampCrop({ zoom: nextZoom, cx: sx + side / 2, cy: sy + side / 2 }, image)
}
