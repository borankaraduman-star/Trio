/**
 * Global push-to-talk through a key hook that reports key DOWN and key UP
 * (Electron's globalShortcut fires only on press). No Electron import, so the
 * controller is unit-tested with a fake hook.
 *
 * Rules:
 * - the hook runs only while a PTT key is set (setKey(null) stops it);
 * - auto-repeat is folded: one `true` per press, one `false` per release;
 * - changing or clearing the key while it is held reports `false` first, so
 *   the client never stays stuck transmitting;
 * - if the native module cannot be loaded or started, the app carries on and
 *   `onState` is simply never called. That is logged ONCE.
 */
import { bindingForCode, type PttBinding } from "../shared/keymap";

interface HookKeyEvent { keycode: number }
interface HookMouseEvent { button: unknown }

/** The part of uiohook-napi's `uIOhook` this file uses. */
export interface KeyHook {
  start(): void;
  stop(): void;
  on(event: "keydown" | "keyup", listener: (e: HookKeyEvent) => void): unknown;
  on(event: "mousedown" | "mouseup", listener: (e: HookMouseEvent) => void): unknown;
}

export type HookLoader = () => KeyHook;

export interface Logger {
  warn(message: string, ...rest: unknown[]): void;
  info(message: string, ...rest: unknown[]): void;
}

export const loadUiohook: HookLoader = () => {
  if (process.platform === "linux" && !process.env.DISPLAY) {
    // libuiohook's Linux backend is X11 (XRecord); loading it with no X
    // display (a Wayland session without XWayland) terminates the process.
    throw new Error("no X11 display; the global key hook needs X11/XWayland");
  }
  // Required lazily: a missing or broken native binary must not stop startup.
  const mod = require("uiohook-napi") as { uIOhook: KeyHook };
  return mod.uIOhook;
};

export class PttController {
  private hook: KeyHook | null = null;
  private unavailable = false;
  private running = false;
  private binding: PttBinding | null = null;
  private held = false;

  constructor(
    private readonly onState: (down: boolean) => void,
    private readonly loader: HookLoader = loadUiohook,
    private readonly log: Logger = console,
  ) {}

  /** Set (a `KeyboardEvent.code`) or clear (null) the push-to-talk key. */
  setKey(code: string | null): void {
    this.release();
    if (code === null) {
      this.binding = null;
      this.stopHook();
      return;
    }
    const binding = bindingForCode(code);
    if (binding === null) {
      this.log.warn(`[ptt] unsupported key code ${JSON.stringify(code)}; PTT is off`);
      this.binding = null;
      this.stopHook();
      return;
    }
    this.binding = binding;
    this.startHook();
  }

  /** Whether the hook is currently listening (for tests and logs). */
  get isListening(): boolean {
    return this.running;
  }

  dispose(): void {
    this.setKey(null);
  }

  private release(): void {
    if (this.held) {
      this.held = false;
      this.onState(false);
    }
  }

  private ensureHook(): KeyHook | null {
    if (this.hook) return this.hook;
    if (this.unavailable) return null;
    try {
      const hook = this.loader();
      hook.on("keydown", (e) => this.handleKey(e.keycode, true));
      hook.on("keyup", (e) => this.handleKey(e.keycode, false));
      hook.on("mousedown", (e) => this.handleMouse(e.button, true));
      hook.on("mouseup", (e) => this.handleMouse(e.button, false));
      this.hook = hook;
      return hook;
    } catch (error) {
      this.unavailable = true;
      this.log.warn("[ptt] global key hook unavailable; push-to-talk will not fire", error);
      return null;
    }
  }

  private startHook(): void {
    if (this.running) return;
    const hook = this.ensureHook();
    if (!hook) return;
    try {
      hook.start();
      this.running = true;
    } catch (error) {
      // e.g. macOS without the Accessibility / Input Monitoring permission.
      this.unavailable = true;
      this.hook = null;
      this.log.warn("[ptt] global key hook failed to start; push-to-talk will not fire", error);
    }
  }

  private stopHook(): void {
    if (!this.running || !this.hook) return;
    try {
      this.hook.stop();
    } catch (error) {
      this.log.warn("[ptt] stopping the key hook failed", error);
    }
    this.running = false;
  }

  private handleKey(keycode: number, down: boolean): void {
    const b = this.binding;
    if (b?.kind !== "key" || b.keycode !== keycode) return;
    this.transition(down);
  }

  private handleMouse(button: unknown, down: boolean): void {
    const b = this.binding;
    if (b?.kind !== "mouse" || Number(button) !== b.button) return;
    this.transition(down);
  }

  private transition(down: boolean): void {
    if (!this.running || down === this.held) return;
    this.held = down;
    this.onState(down);
  }
}
