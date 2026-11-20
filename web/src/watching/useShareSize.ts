import { useEffect, useRef, type RefObject } from 'react'
import { viewSizeFor, type ViewSize } from '../lib/multishare'
import { viewSizes } from './sizes'

let sources = 0

/**
 * Reports how large `ref`'s video shows `userId`'s screen (CONTRACT-V12-WATCHING §3):
 * its height in device pixels while it is on the screen, `thumb` while it is
 * mounted but folded/collapsed/scrolled away, nothing while the page is hidden
 * (or the picture is in the browser's picture-in-picture, which reports itself).
 * `fixed` overrides the measurement (the theatre is always `full`).
 */
export function useShareSize(
  userId: number | null,
  ref: RefObject<HTMLElement | null>,
  shown: boolean,
  fixed: ViewSize | null = null,
): void {
  const key = useRef<string>('')
  if (key.current === '') key.current = `place-${(sources += 1)}`

  useEffect(() => {
    if (userId === null) return
    const element = ref.current
    if (!element) return
    const source = key.current
    let onScreen = true
    let pip = false
    const measure = () => {
      if (document.visibilityState === 'hidden' && !pip) {
        viewSizes.report(userId, source, null)
        return
      }
      if (pip) {
        const win = (element as HTMLVideoElement & { __trioPipWindow?: { height: number } }).__trioPipWindow
        viewSizes.report(userId, source, viewSizeFor(win?.height ?? 360, window.devicePixelRatio || 1, true))
        return
      }
      if (fixed) {
        viewSizes.report(userId, source, fixed)
        return
      }
      const fullscreen = document.fullscreenElement !== null && (document.fullscreenElement === element || document.fullscreenElement.contains(element))
      if (fullscreen) {
        viewSizes.report(userId, source, 'full')
        return
      }
      const rect = element.getBoundingClientRect()
      const visible = shown && onScreen && rect.height > 0
      viewSizes.report(userId, source, viewSizeFor(rect.height, window.devicePixelRatio || 1, visible))
    }
    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
    resize?.observe(element)
    const seen =
      typeof IntersectionObserver === 'function'
        ? new IntersectionObserver((entries) => {
            onScreen = entries.some((entry) => entry.isIntersecting)
            measure()
          })
        : null
    seen?.observe(element)
    const video = element instanceof HTMLVideoElement ? element : element.querySelector('video')
    const enterPip = (event: Event) => {
      pip = true
      const win = (event as Event & { pictureInPictureWindow?: EventTarget & { height: number } }).pictureInPictureWindow
      if (video && win) {
        ;(element as HTMLElement & { __trioPipWindow?: unknown }).__trioPipWindow = win
        win.addEventListener('resize', measure)
      }
      measure()
    }
    const leavePip = () => {
      pip = false
      measure()
    }
    video?.addEventListener('enterpictureinpicture', enterPip)
    video?.addEventListener('leavepictureinpicture', leavePip)
    document.addEventListener('visibilitychange', measure)
    document.addEventListener('fullscreenchange', measure)
    measure()
    return () => {
      resize?.disconnect()
      seen?.disconnect()
      video?.removeEventListener('enterpictureinpicture', enterPip)
      video?.removeEventListener('leavepictureinpicture', leavePip)
      document.removeEventListener('visibilitychange', measure)
      document.removeEventListener('fullscreenchange', measure)
      viewSizes.report(userId, source, null)
    }
  }, [userId, ref, shown, fixed])
}
