/**
 * A long-press at phone width opens a bottom sheet while the finger is still
 * down. When the pressed row is in the lower part of the screen the sheet
 * comes up UNDER the finger, and lifting it then ends the touch with a click
 * on whatever item is there — the sheet closed itself on "Yanıtla" (seen in
 * the 35-message-voice-interplay spec). So from the moment the sheet opens
 * the click that ends that press is swallowed, wherever it lands.
 *
 * Only that one click: a new touch (`pointerdown`) is a new gesture and ends
 * the watch untouched, and once the finger is up a click that has not come
 * within `graceMs` is not coming.
 */
export interface PressEndTargets {
  addEventListener(type: string, listener: (event: Event) => void, options: { capture: boolean }): void
  removeEventListener(type: string, listener: (event: Event) => void, options: { capture: boolean }): void
}

const CAPTURE = { capture: true }

export function swallowPressEndClick(target: PressEndTargets, graceMs = 400): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    if (timer) clearTimeout(timer)
    target.removeEventListener('click', onClick, CAPTURE)
    target.removeEventListener('pointerdown', stop, CAPTURE)
    target.removeEventListener('pointerup', onUp, CAPTURE)
    target.removeEventListener('pointercancel', onUp, CAPTURE)
  }
  const onClick = (event: Event) => {
    event.preventDefault()
    event.stopPropagation()
    stop()
  }
  const onUp = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(stop, graceMs)
  }
  target.addEventListener('click', onClick, CAPTURE)
  target.addEventListener('pointerdown', stop, CAPTURE)
  target.addEventListener('pointerup', onUp, CAPTURE)
  target.addEventListener('pointercancel', onUp, CAPTURE)
  return stop
}
