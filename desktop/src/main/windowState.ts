/**
 * CONTRACT-V12-MINI-DESKTOP §5: the main window's state for the page
 * (`onWindowState`), debounced and sent only when it changed. No Electron
 * import (tested with fake timers).
 *
 * `fullscreenAppInFront` is never set: no API tells it reliably on all three
 * platforms (Windows' SHQueryUserNotificationState says "busy" for any
 * fullscreen app, presentations included, and needs native code), so it is
 * left undefined rather than guessed.
 */
export interface WindowState {
  focused: boolean;
  minimized: boolean;
  hiddenToTray: boolean;
  fullscreenAppInFront?: boolean;
}

export const WINDOW_STATE_DEBOUNCE_MS = 150;

export class WindowStateReporter {
  private timer: unknown = null;
  private last: string | null = null;

  constructor(
    private readonly read: () => WindowState | null,
    private readonly send: (state: WindowState) => void,
    private readonly setTimer: (fn: () => void, ms: number) => unknown = (fn, ms) => setTimeout(fn, ms),
    private readonly clearTimer: (handle: unknown) => void = (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  ) {}

  /** A window event: report the state once things settle. */
  poke(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.flush();
    }, WINDOW_STATE_DEBOUNCE_MS);
  }

  /** The current state (for a new subscriber); also what the next change is compared to. */
  current(): WindowState | null {
    return this.read();
  }

  /** A new document: it has seen nothing yet. */
  reset(): void {
    this.last = null;
  }

  private flush(): void {
    const state = this.read();
    if (!state) return;
    const key = JSON.stringify(state);
    if (key === this.last) return;
    this.last = key;
    this.send(state);
  }
}

/** From the window's own answers. A window hidden but not minimized is in the tray. */
export function windowStateOf(win: { isFocused(): boolean; isMinimized(): boolean; isVisible(): boolean }): WindowState {
  const minimized = win.isMinimized();
  return { focused: win.isFocused(), minimized, hiddenToTray: !win.isVisible() && !minimized };
}
