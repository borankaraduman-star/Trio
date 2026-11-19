import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useFocusTrap } from './useFocusTrap'

/** Where a popover opens from: a button's or a pointer's rectangle (viewport coordinates). */
export interface AnchorRect {
  top: number
  bottom: number
  left: number
  right: number
}

export function rectOf(element: Element): AnchorRect {
  const box = element.getBoundingClientRect()
  return { top: box.top, bottom: box.bottom, left: box.left, right: box.right }
}

/** At phone width every popover is a bottom sheet instead. */
export const SHEET_QUERY = '(max-width: 680px)'

export function isSheetWidth(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(SHEET_QUERY).matches
}

const MARGIN = 8

/**
 * A focus-trapping layer: next to `anchor` on a wide screen (flipped and
 * clamped to stay inside the window), a bottom sheet over a dimmed backdrop at
 * phone width.
 */
export function Popover({
  anchor,
  onClose,
  label,
  className = '',
  testId,
  children,
}: {
  anchor: AnchorRect | null
  onClose: () => void
  label: string
  className?: string
  testId?: string
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [sheet] = useState(() => anchor === null || isSheetWidth())
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  useFocusTrap(ref, onClose)

  useLayoutEffect(() => {
    const element = ref.current
    if (!element || sheet || !anchor) return
    const { width, height } = element.getBoundingClientRect()
    const below = anchor.bottom + MARGIN
    const top = below + height <= window.innerHeight - MARGIN ? below : Math.max(MARGIN, anchor.top - MARGIN - height)
    const left = Math.min(Math.max(MARGIN, anchor.right - width), window.innerWidth - width - MARGIN)
    setPosition({ top, left })
  }, [anchor, sheet])

  const body = (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      data-testid={testId}
      className={`msg-popover ${sheet ? 'sheet' : 'floating'} ${className}`}
      style={sheet ? undefined : { top: position?.top ?? -9999, left: position?.left ?? -9999 }}
    >
      {sheet && <div className="msg-sheet-handle" aria-hidden="true" />}
      {children}
    </div>
  )
  return sheet ? <div className="msg-sheet-backdrop">{body}</div> : body
}
