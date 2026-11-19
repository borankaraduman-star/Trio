import { describe, expect, it } from 'vitest'
import { clampCrop, initialCrop, maxZoom, panBy, sourceRect, zoomTo } from '../lib/crop'

const WIDE = { width: 1200, height: 800 }
const TALL = { width: 600, height: 900 }

describe('the crop', () => {
  it('starts centred on the whole shorter side', () => {
    expect(sourceRect(initialCrop(WIDE), WIDE)).toEqual({ sx: 200, sy: 0, size: 800 })
    expect(sourceRect(initialCrop(TALL), TALL)).toEqual({ sx: 0, sy: 150, size: 600 })
  })

  it('keeps the zoom between 1 and the maximum', () => {
    expect(clampCrop({ cx: 600, cy: 400, zoom: 0.2 }, WIDE).zoom).toBe(1)
    expect(clampCrop({ cx: 600, cy: 400, zoom: 99 }, WIDE).zoom).toBe(maxZoom(WIDE))
    expect(maxZoom(WIDE)).toBe(8)
    expect(maxZoom({ width: 64, height: 48 })).toBe(1.5)
    expect(maxZoom({ width: 20, height: 20 })).toBe(1)
    expect(clampCrop({ cx: Number.NaN, cy: 400, zoom: Number.NaN }, WIDE).zoom).toBe(1)
  })

  it('never lets the square leave the image', () => {
    const c = clampCrop({ cx: -500, cy: 5000, zoom: 2 }, WIDE)
    const rect = sourceRect(c, WIDE)
    expect(rect.sx).toBe(0)
    expect(rect.sy + rect.size).toBe(800)
    expect(rect.size).toBe(400)
  })

  it('pans with the finger, in image pixels per view pixel', () => {
    const start = { cx: 600, cy: 400, zoom: 2 } // a 400 px square
    // 100 view px in a 200 px view = 200 image px; dragging right shows what is left of it.
    const moved = panBy(start, 100, 0, 200, WIDE)
    expect(moved.cx).toBe(400)
    expect(moved.cy).toBe(400)
    // Past the edge it stops.
    expect(sourceRect(panBy(start, 10_000, 10_000, 200, WIDE), WIDE)).toEqual({ sx: 0, sy: 0, size: 400 })
  })

  it('zooms around the focus point, which stays under the finger', () => {
    const start = { cx: 600, cy: 400, zoom: 1 }
    const view = 300
    const focus = { x: 75, y: 150 }
    const before = sourceRect(start, WIDE)
    const point = before.sx + (focus.x / view) * before.size
    const zoomed = zoomTo(start, 2, WIDE, view, focus)
    const after = sourceRect(zoomed, WIDE)
    expect(zoomed.zoom).toBe(2)
    expect(after.sx + (focus.x / view) * after.size).toBeCloseTo(point, 6)
  })

  it('zooms around the centre without a focus, and clamps when zoomed out', () => {
    const zoomed = zoomTo({ cx: 600, cy: 400, zoom: 1 }, 4, WIDE, 300)
    expect(zoomed).toEqual({ cx: 600, cy: 400, zoom: 4 })
    const corner = zoomTo({ cx: 100, cy: 100, zoom: 8 }, 1, WIDE, 300, { x: 0, y: 0 })
    // The point under the focus (50, 50) stays where it can; the square cannot leave the image.
    expect(sourceRect(corner, WIDE)).toEqual({ sx: 50, sy: 0, size: 800 })
  })
})
