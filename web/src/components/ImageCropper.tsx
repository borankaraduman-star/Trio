import { createPortal } from 'react-dom'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { clampCrop, initialCrop, maxZoom, panBy, sourceRect, zoomTo, type Crop } from '../lib/crop'
import { encodeSquare, type DecodedImage } from '../lib/imageEncode'

/**
 * A square cropper drawn on a canvas (CONTRACT-V4 C): drag to move the
 * picture (mouse or one finger), pinch or the wheel or the slider to zoom, the
 * arrow keys and +/- from the keyboard. "Kaydet" scales the square to
 * 256 × 256 and encodes it in the browser. Uses no URL at all: the decoded
 * bitmap is drawn straight into the canvas.
 */
/** A rounded square path (CanvasRenderingContext2D.roundRect is too new for some engines). */
function roundedSquare(context: CanvasRenderingContext2D, side: number, radius: number): void {
  context.moveTo(radius, 0)
  context.arcTo(side, 0, side, side, radius)
  context.arcTo(side, side, 0, side, radius)
  context.arcTo(0, side, 0, 0, radius)
  context.arcTo(0, 0, side, 0, radius)
  context.closePath()
}

export function ImageCropper({
  image,
  shape,
  title,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  image: DecodedImage
  /** How the result is shown: a circle (an avatar) or a rounded square (the server's icon). */
  shape: 'circle' | 'rounded'
  title: string
  busy: boolean
  error: string | null
  onCancel: () => void
  /** The encoded square, or null when this browser could not encode one. */
  onConfirm: (encoded: { blob: Blob; ext: string } | null) => void
}) {
  const size = { width: image.width, height: image.height }
  const [crop, setCrop] = useState<Crop>(() => initialCrop(size))
  const [viewSize, setViewSize] = useState(280)
  const [encoding, setEncoding] = useState(false)
  const frame = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const cropRef = useRef(crop)
  cropRef.current = crop
  const top = maxZoom(size)

  // The view is as wide as its frame allows (phone width included).
  useLayoutEffect(() => {
    const element = frame.current
    if (!element) return
    const measure = () => setViewSize(Math.max(120, Math.round(element.clientWidth)))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const element = canvas.current
    const context = element?.getContext('2d')
    if (!element || !context) return
    const ratio = window.devicePixelRatio || 1
    const pixels = Math.round(viewSize * ratio)
    if (element.width !== pixels) element.width = pixels
    if (element.height !== pixels) element.height = pixels
    const rect = sourceRect(crop, size)
    context.imageSmoothingQuality = 'high'
    context.clearRect(0, 0, pixels, pixels)
    context.drawImage(image.source, rect.sx, rect.sy, rect.size, rect.size, 0, 0, pixels, pixels)
    // What will not be kept is dimmed: outside the circle, or outside the rounded square's corners.
    context.save()
    context.fillStyle = 'rgba(17, 19, 24, 0.62)'
    context.beginPath()
    context.rect(0, 0, pixels, pixels)
    if (shape === 'circle') {
      const radius = pixels / 2 - 1
      context.moveTo(pixels / 2 + radius, pixels / 2)
      context.arc(pixels / 2, pixels / 2, radius, 0, Math.PI * 2, true)
    } else {
      roundedSquare(context, pixels, pixels * 0.22)
    }
    context.fill('evenodd')
    context.restore()
  }, [crop, viewSize, image, shape])

  const localPoint = (event: { clientX: number; clientY: number }) => {
    const box = canvas.current?.getBoundingClientRect()
    return box ? { x: event.clientX - box.left, y: event.clientY - box.top } : { x: 0, y: 0 }
  }

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // A pointer the engine no longer knows: the drag still works without capture.
    }
    pointers.current.set(event.pointerId, localPoint(event))
  }

  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const map = pointers.current
    const previous = map.get(event.pointerId)
    if (!previous) return
    const point = localPoint(event)
    if (map.size === 1) {
      setCrop((current) => panBy(current, point.x - previous.x, point.y - previous.y, viewSize, size))
    } else if (map.size === 2) {
      // A pinch: zoom by how much the fingers spread, around their middle, and follow the middle.
      const other = [...map.entries()].find(([id]) => id !== event.pointerId)?.[1]
      if (other) {
        const before = Math.hypot(previous.x - other.x, previous.y - other.y)
        const after = Math.hypot(point.x - other.x, point.y - other.y)
        const midBefore = { x: (previous.x + other.x) / 2, y: (previous.y + other.y) / 2 }
        const midAfter = { x: (point.x + other.x) / 2, y: (point.y + other.y) / 2 }
        setCrop((current) => {
          const zoomed = before > 0 ? zoomTo(current, current.zoom * (after / before), size, viewSize, midBefore) : current
          return panBy(zoomed, midAfter.x - midBefore.x, midAfter.y - midBefore.y, viewSize, size)
        })
      }
    }
    map.set(event.pointerId, point)
  }

  const onPointerEnd = (event: PointerEvent<HTMLCanvasElement>) => {
    pointers.current.delete(event.pointerId)
  }

  // Keyboard users land on the picture (arrows move it, +/- zoom).
  useEffect(() => {
    canvas.current?.focus({ preventScroll: true })
  }, [])

  // The wheel needs a listener that may cancel scrolling (React's is passive).
  useEffect(() => {
    const element = canvas.current
    if (!element) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const point = localPoint(event)
      setCrop((current) => zoomTo(current, current.zoom * Math.exp(-event.deltaY * 0.0015), size, viewSize, point))
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [viewSize, image])

  const confirm = useCallback(async () => {
    if (busy || encoding) return
    setEncoding(true)
    try {
      onConfirm(await encodeSquare(image.source, sourceRect(cropRef.current, size)))
    } catch {
      onConfirm(null)
    } finally {
      setEncoding(false)
    }
  }, [busy, encoding, image, onConfirm])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = 12
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [step, 0],
      ArrowRight: [-step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    }
    if (event.key === 'Escape') {
      // Only the cropper closes, not the settings behind it.
      event.preventDefault()
      event.stopPropagation()
      if (!busy) onCancel()
    } else if (event.target === canvas.current && moves[event.key]) {
      event.preventDefault()
      const [dx, dy] = moves[event.key]
      setCrop((current) => panBy(current, dx, dy, viewSize, size))
    } else if (event.target === canvas.current && (event.key === '+' || event.key === '=' || event.key === '-')) {
      event.preventDefault()
      const factor = event.key === '-' ? 1 / 1.15 : 1.15
      setCrop((current) => zoomTo(current, current.zoom * factor, size, viewSize))
    }
  }

  const working = busy || encoding

  // On the page itself, not inside the settings dialog (whose box would contain a fixed overlay).
  return createPortal(
    <div className="cropper-backdrop" data-testid="cropper">
      <div
        className="cropper"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cropper-title"
        onKeyDown={onKeyDown}
      >
        <h2 id="cropper-title">{title}</h2>
        <p className="cropper-hint">Görseli sürükleyerek yerleştir, yakınlaştırmak için kaydırıcıyı ya da iki parmağını kullan.</p>
        <div ref={frame} className={`cropper-frame ${shape}`}>
          <canvas
            ref={canvas}
            className="cropper-canvas"
            data-testid="cropper-canvas"
            data-zoom={crop.zoom.toFixed(3)}
            data-cx={crop.cx.toFixed(1)}
            data-cy={crop.cy.toFixed(1)}
            style={{ width: viewSize, height: viewSize }}
            tabIndex={0}
            role="img"
            aria-label="Kırpma alanı: oklarla kaydır, + ve - ile yakınlaştır"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerEnd}
            onPointerCancel={onPointerEnd}
            onLostPointerCapture={onPointerEnd}
          />
        </div>
        <label className="cropper-zoom">
          <span>Yakınlaştır</span>
          <input
            type="range"
            data-testid="cropper-zoom"
            min={1}
            max={top}
            step={0.01}
            value={crop.zoom}
            disabled={top <= 1}
            onChange={(event) => setCrop((current) => clampCrop(zoomTo(current, Number(event.target.value), size, viewSize), size))}
          />
        </label>
        {error && (
          <p className="form-error" role="alert" data-testid="cropper-error">
            {error}
          </p>
        )}
        <div className="cropper-actions">
          <button type="button" className="ghost" data-testid="cropper-cancel" disabled={working} onClick={onCancel}>
            Vazgeç
          </button>
          <button type="button" className="primary" data-testid="cropper-save" disabled={working} onClick={() => void confirm()}>
            {working ? 'Kaydediliyor…' : 'Kaydet'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
