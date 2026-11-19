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

/** CONTRACT-V6-VOICE §5: the global mute/deafen keys, on the same hook. */
export type HotkeyAction = "mute" | "deafen";

export class PttController {
  private hook: KeyHook | null = null;
  private unavailable = false;
  private running = false;
  private binding: PttBinding | null = null;
  private held = false;
  /** V6: hotkey bindings, and which are down (a held key fires once). */
  private hotkeys: Partial<Record<HotkeyAction, PttBinding>> = {};
  private hotkeyHeld = new Set<HotkeyAction>();

  constructor(
    private readonly onState: (down: boolean) => void,
    private readonly loader: HookLoader = loadUiohook,
    private readonly log: Logger = console,
    /** V6: a hotkey was pressed. */
    private readonly onHotkey: (action: HotkeyAction) => void = () => undefined,
  ) {}

  /**
   * V6: set the global mute/deafen keys (`KeyboardEvent.code`, null = none).
   * A key that is the push-to-talk key is not registered: PTT wins. One hook
   * instance serves both; it runs while PTT or any hotkey is set.
   */
  setHotkeys(keys: { mute?: string | null; deafen?: string | null }): void {
    const next: Partial<Record<HotkeyAction, PttBinding>> = {};
    for (const action of ["mute", "deafen"] as const) {
      const code = keys[action];
      if (typeof code !== "string") continue;
      const binding = bindingForCode(code);
      if (binding === null) {
        this.log.warn(`[hotkey] unsupported key code ${JSON.stringify(code)}; ${action} has no key`);
        continue;
      }
      next[action] = binding;
    }
    if (next.mute && next.deafen && sameBinding(next.mute, next.deafen)) delete next.deafen;
    this.hotkeys = next;
    this.hotkeyHeld.clear();
    this.syncHook();
  }

  /** The hotkeys in effect (for tests and logs). */
  get activeHotkeys(): HotkeyAction[] {
    return (["mute", "deafen"] as const).filter((action) => this.effectiveHotkey(action) !== null);
  }

  /** Set (a `KeyboardEvent.code`) or clear (null) the push-to-talk key. */
  setKey(code: string | null): void {
    this.release();
    if (code === null) {
      this.binding = null;
      this.syncHook();
      return;
    }
    const binding = bindingForCode(code);
    if (binding === null) {
      this.log.warn(`[ptt] unsupported key code ${JSON.stringify(code)}; PTT is off`);
      this.binding = null;
      this.syncHook();
      return;
    }
    this.binding = binding;
    this.startHook();
  }

  /** Run the hook exactly while something listens to it. */
  private syncHook(): void {
    if (this.binding !== null || this.activeHotkeys.length > 0) this.startHook();
    else this.stopHook();
  }

  /** A hotkey's binding, unless it is the PTT key's. */
  private effectiveHotkey(action: HotkeyAction): PttBinding | null {
    const binding = this.hotkeys[action];
    if (!binding) return null;
    if (this.binding && sameBinding(binding, this.binding)) return null;
    return binding;
  }

  private handleHotkey(match: (binding: PttBinding) => boolean, down: boolean): void {
    if (!this.running) return;
    for (const action of ["mute", "deafen"] as const) {
      const binding = this.effectiveHotkey(action);
      if (!binding || !match(binding)) continue;
      if (!down) {
        this.hotkeyHeld.delete(action);
      } else if (!this.hotkeyHeld.has(action)) {
        this.hotkeyHeld.add(action);
        this.onHotkey(action);
      }
    }
  }

  /** Whether the hook is currently listening (for tests and logs). */
  get isListening(): boolean {
    return this.running;
  }

  dispose(): void {
    this.hotkeys = {};
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
    this.handleHotkey((h) => h.kind === "key" && h.keycode === keycode, down);
    const b = this.binding;
    if (b?.kind !== "key" || b.keycode !== keycode) return;
    this.transition(down);
  }

  private handleMouse(button: unknown, down: boolean): void {
    this.handleHotkey((h) => h.kind === "mouse" && h.button === Number(button), down);
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

function sameBinding(a: PttBinding, b: PttBinding): boolean {
  return a.kind === "key" && b.kind === "key" ? a.keycode === b.keycode : a.kind === "mouse" && b.kind === "mouse" && a.button === b.button;
}
