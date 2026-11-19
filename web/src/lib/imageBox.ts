/**
 * The box an inline image takes before it has loaded (CONTRACT-V6-MEDIA §2).
 * With the original's size known, the box is exactly the picture's shape fitted
 * into 400 × 300 (never enlarged), so nothing moves when the bytes arrive and
 * the scroll anchor (lib/scrollAnchor.ts) holds. Without it, the old fixed
 * 400 × 300 letterbox (styles-v2.css `.attachment-box`).
 */
import type { CSSProperties } from 'react'

export const BOX_WIDTH = 400
export const BOX_HEIGHT = 300

/** The picture fitted into `maxWidth × maxHeight`, in whole pixels; null when the size is unknown. */
export function fitBox(
  width: number | null | undefined,
  height: number | null | undefined,
  maxWidth = BOX_WIDTH,
  maxHeight = BOX_HEIGHT,
): { width: number; height: number } | null {
  if (!width || !height || width < 1 || height < 1 || !Number.isFinite(width) || !Number.isFinite(height)) return null
  const scale = Math.min(1, maxWidth / width, maxHeight / height)
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/**
 * The inline style for a sized box: its fitted width (narrower on a phone,
 * `100%` caps it) and the picture's aspect ratio for the height.
 */
export function attachmentBoxStyle(attachment: { width?: number | null; height?: number | null }): CSSProperties | null {
  const box = fitBox(attachment.width, attachment.height)
  if (!box || !attachment.width || !attachment.height) return null
  return { width: `min(${box.width}px, 100%)`, height: 'auto', aspectRatio: `${attachment.width} / ${attachment.height}` }
}
