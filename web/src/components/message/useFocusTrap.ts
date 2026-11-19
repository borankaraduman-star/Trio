import { useEffect, useRef, type RefObject } from 'react'

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * A dialog, menu or sheet: the focus moves into it, Tab cycles inside it, Esc
 * closes it, a press outside closes it, and the focus goes back to where it
 * was when it closes.
 */
export function useFocusTrap(
  ref: RefObject<HTMLElement>,
  onClose: () => void,
  options: { initial?: RefObject<HTMLElement>; outsideCloses?: boolean } = {},
): void {
  const { initial, outsideCloses = true } = options
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const previous = document.activeElement as HTMLElement | null
    const first = initial?.current ?? element.querySelector<HTMLElement>(FOCUSABLE) ?? element
    first.focus({ preventScroll: true })

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        close.current()
        return
      }
      if (event.key !== 'Tab') return
      const items = [...element.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((item) => item.offsetParent !== null)
      if (items.length === 0) {
        event.preventDefault()
        return
      }
      const firstItem = items[0]
      const lastItem = items[items.length - 1]
      if (event.shiftKey && document.activeElement === firstItem) {
        event.preventDefault()
        lastItem.focus()
      } else if (!event.shiftKey && document.activeElement === lastItem) {
        event.preventDefault()
        firstItem.focus()
      }
    }
    const onDown = (event: PointerEvent) => {
      if (outsideCloses && !element.contains(event.target as Node)) close.current()
    }
    // On the document: a button inside that went away (an unpinned item) leaves the focus on <body>.
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('pointerdown', onDown, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('pointerdown', onDown, true)
      if (previous && document.contains(previous)) previous.focus({ preventScroll: true })
    }
  }, [ref, initial, outsideCloses])
}
