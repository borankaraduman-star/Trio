/**
 * Push-to-talk (CONTRACT-V2 §4).
 *
 * `PttGate` is the pure state machine: two independent sources — the in-page
 * key listener and the desktop app's global hook — and one output, "may the
 * microphone send". The key counts as held when EITHER source says so; on
 * release of the last one the gate stays open for a 150 ms tail.
 *
 * Deviation from the contract's "instead of": in the desktop app BOTH
 * sources are used, because if the native hook is unavailable `onPtt` simply
 * never fires and nothing reports it. Blur and a hidden page release the
 * in-page source, so a key-up lost to another window cannot hold the
 * microphone open; the desktop source is global and keeps its own state.
 */
import type { DesktopMusicBridge } from './music/capture'

export const PTT_RELEASE_TAIL_MS = 150

export interface PttTimers {
  setTimeout: (callback: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

const realTimers: PttTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export class PttGate {
  private page = false
  private desktop = false
  private open = false
  private tail: unknown = null

  constructor(
    private readonly onChange: (open: boolean) => void,
    private readonly timers: PttTimers = realTimers,
    private readonly tailMs = PTT_RELEASE_TAIL_MS,
  ) {}

  get isOpen(): boolean {
    return this.open
  }

  get held(): boolean {
    return this.page || this.desktop
  }

  setPage(down: boolean): void {
    this.page = down
    this.update()
  }

  setDesktop(down: boolean): void {
    this.desktop = down
    this.update()
  }

  /** Everything released at once, with no tail (leaving PTT mode, unmount). */
  reset(): void {
    this.page = false
    this.desktop = false
    this.cancelTail()
    this.set(false)
  }

  private update(): void {
    if (this.held) {
      this.cancelTail()
      this.set(true)
      return
    }
    if (!this.open || this.tail !== null) return
    this.tail = this.timers.setTimeout(() => {
      this.tail = null
      if (!this.held) this.set(false)
    }, this.tailMs)
  }

  private cancelTail(): void {
    if (this.tail === null) return
    this.timers.clearTimeout(this.tail)
    this.tail = null
  }

  private set(open: boolean): void {
    if (open === this.open) return
    this.open = open
    this.onChange(open)
  }
}

/** The desktop app's preload bridge (CONTRACT-V2 §5). */
export interface TrioDesktopBridge {
  isDesktop: true
  setPttKey(code: string | null): void
  onPtt(callback: (down: boolean) => void): () => void
  /** CONTRACT-V6-VOICE "Desktop version": the app's own version; absent in builds before it. */
  appVersion?: string
  /** CONTRACT-V8-MUSIC §5 (absent in older apps): see music/capture.ts. */
  musicCaptureSupport?: DesktopMusicBridge['musicCaptureSupport']
  prepareMusicCapture?: DesktopMusicBridge['prepareMusicCapture']
  setNowPlayingWatch?: DesktopMusicBridge['setNowPlayingWatch']
  onNowPlaying?: DesktopMusicBridge['onNowPlaying']
  /** CONTRACT-V10-UPDATE §3 (absent in older apps): the shell's own update cycle. */
  getUpdateState?: () => Promise<unknown>
  onUpdateState?: (callback: (state: unknown) => void) => () => void
  checkForUpdates?: () => Promise<unknown>
  downloadUpdate?: () => Promise<unknown>
  installUpdate?: () => Promise<{ ok: boolean; reason?: string }>
  setAutoUpdate?: (on: boolean) => void
}

export function desktopBridge(): TrioDesktopBridge | null {
  const bridge = (globalThis as { trioDesktop?: Partial<TrioDesktopBridge> }).trioDesktop
  if (!bridge || bridge.isDesktop !== true) return null
  if (typeof bridge.setPttKey !== 'function' || typeof bridge.onPtt !== 'function') return null
  return bridge as TrioDesktopBridge
}

/** True when a key press is going into a text field (and must not trigger PTT). */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== 'function') return false
  const element = target as HTMLElement
  if (element.isContentEditable) return true
  const field = element.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')
  if (!field) return false
  if (typeof HTMLInputElement !== 'undefined' && field instanceof HTMLInputElement) {
    // Buttons, checkboxes and the like take no text.
    return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'color', 'file', 'image'].includes(
      field.type,
    )
  }
  return true
}

/** `MouseEvent.button` → our mouse key names. */
export function mouseButtonCode(button: number): string | null {
  if (button === 1) return 'MouseMiddle'
  if (button === 3) return 'MouseBack'
  if (button === 4) return 'MouseForward'
  return null
}

/**
 * Wires a gate to the page (and the desktop bridge when there is one) for one
 * PTT key. Returns a function that removes every listener and releases the
 * gate. `window` and `document` are parameters so tests can pass fakes.
 */
export function attachPtt(
  gate: PttGate,
  key: string,
  env: {
    window: Pick<Window, 'addEventListener' | 'removeEventListener'>
    document: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>
    bridge: TrioDesktopBridge | null
  },
): () => void {
  const { window: win, document: doc, bridge } = env

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.code !== key || event.repeat) return
    if (isTypingTarget(event.target)) return
    gate.setPage(true)
  }
  // A key-up is always honoured, even in a text field: the release must never be lost.
  const onKeyUp = (event: KeyboardEvent) => {
    if (event.code === key) gate.setPage(false)
  }
  const onMouseDown = (event: MouseEvent) => {
    if (mouseButtonCode(event.button) === key) gate.setPage(true)
  }
  const onMouseUp = (event: MouseEvent) => {
    if (mouseButtonCode(event.button) === key) gate.setPage(false)
  }
  const release = () => gate.setPage(false)
  const onVisibility = () => {
    if (doc.visibilityState !== 'visible') gate.setPage(false)
  }

  win.addEventListener('keydown', onKeyDown as EventListener, true)
  win.addEventListener('keyup', onKeyUp as EventListener, true)
  win.addEventListener('mousedown', onMouseDown as EventListener, true)
  win.addEventListener('mouseup', onMouseUp as EventListener, true)
  win.addEventListener('blur', release)
  doc.addEventListener('visibilitychange', onVisibility)

  let unsubscribe: (() => void) | null = null
  if (bridge) {
    try {
      bridge.setPttKey(key)
      unsubscribe = bridge.onPtt((down) => gate.setDesktop(Boolean(down)))
    } catch (error) {
      console.warn('trio: desktop push-to-talk unavailable', error)
    }
  }

  return () => {
    win.removeEventListener('keydown', onKeyDown as EventListener, true)
    win.removeEventListener('keyup', onKeyUp as EventListener, true)
    win.removeEventListener('mousedown', onMouseDown as EventListener, true)
    win.removeEventListener('mouseup', onMouseUp as EventListener, true)
    win.removeEventListener('blur', release)
    doc.removeEventListener('visibilitychange', onVisibility)
    try {
      unsubscribe?.()
      bridge?.setPttKey(null)
    } catch {
      // The bridge went away with the window.
    }
    gate.reset()
  }
}
