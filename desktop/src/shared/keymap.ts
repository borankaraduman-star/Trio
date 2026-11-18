/**
 * `KeyboardEvent.code` (what the web client stores as the PTT key) → the
 * key hook's code. The numbers are libuiohook's virtual key codes (VC_*), the
 * same values `uiohook-napi` exports as `UiohookKey`; they are written out
 * here so the mapping is testable without loading the native module, and a
 * test compares the two tables whenever the module loads.
 *
 * `KeyboardEvent.code` names a PHYSICAL key, and so does libuiohook's code,
 * so the mapping is layout-independent: "KeyZ" is the key at the US "Z"
 * position on a QWERTZ keyboard too.
 */

export type PttBinding =
  | { kind: "key"; keycode: number }
  | { kind: "mouse"; button: number };

const KEYS: Record<string, number> = {
  Escape: 1,
  Digit1: 2, Digit2: 3, Digit3: 4, Digit4: 5, Digit5: 6,
  Digit6: 7, Digit7: 8, Digit8: 9, Digit9: 10, Digit0: 11,
  Minus: 12, Equal: 13, Backspace: 14, Tab: 15,
  KeyQ: 16, KeyW: 17, KeyE: 18, KeyR: 19, KeyT: 20,
  KeyY: 21, KeyU: 22, KeyI: 23, KeyO: 24, KeyP: 25,
  BracketLeft: 26, BracketRight: 27, Enter: 28, ControlLeft: 29,
  KeyA: 30, KeyS: 31, KeyD: 32, KeyF: 33, KeyG: 34,
  KeyH: 35, KeyJ: 36, KeyK: 37, KeyL: 38,
  Semicolon: 39, Quote: 40, Backquote: 41, ShiftLeft: 42, Backslash: 43,
  KeyZ: 44, KeyX: 45, KeyC: 46, KeyV: 47, KeyB: 48, KeyN: 49, KeyM: 50,
  Comma: 51, Period: 52, Slash: 53, ShiftRight: 54,
  NumpadMultiply: 55, AltLeft: 56, Space: 57, CapsLock: 58,
  F1: 59, F2: 60, F3: 61, F4: 62, F5: 63, F6: 64, F7: 65, F8: 66, F9: 67, F10: 68,
  NumLock: 69, ScrollLock: 70,
  Numpad7: 71, Numpad8: 72, Numpad9: 73, NumpadSubtract: 74,
  Numpad4: 75, Numpad5: 76, Numpad6: 77, NumpadAdd: 78,
  Numpad1: 79, Numpad2: 80, Numpad3: 81, Numpad0: 82, NumpadDecimal: 83,
  F11: 87, F12: 88,
  F13: 91, F14: 92, F15: 93, F16: 99, F17: 100, F18: 101, F19: 102,
  F20: 103, F21: 104, F22: 105, F23: 106, F24: 107,
  NumpadComma: 0x007e,
  NumpadEqual: 0x0e0d,
  NumpadEnter: 0x0e1c,
  ControlRight: 0x0e1d,
  NumpadDivide: 0x0e35,
  PrintScreen: 0x0e37,
  AltRight: 0x0e38,
  Pause: 0x0e45,
  IntlBackslash: 0x0e46,
  Home: 0x0e47,
  PageUp: 0x0e49,
  End: 0x0e4f,
  PageDown: 0x0e51,
  Insert: 0x0e52,
  Delete: 0x0e53,
  MetaLeft: 0x0e5b,
  MetaRight: 0x0e5c,
  ContextMenu: 0x0e5d,
  ArrowUp: 0xe048,
  ArrowLeft: 0xe04b,
  ArrowRight: 0xe04d,
  ArrowDown: 0xe050,
};

/**
 * Mouse buttons are not `KeyboardEvent.code`s. These three names are an
 * optional extension a client may store; the numbers are libuiohook's
 * MOUSE_BUTTON3/4/5 (middle, back/X1, forward/X2). Left and right are not
 * offered: holding them to talk would make the mouse unusable.
 */
const MOUSE: Record<string, number> = {
  MouseMiddle: 3,
  MouseBack: 4,
  MouseForward: 5,
};

/** Map a stored code to a hook binding, or null when it is unknown. */
export function bindingForCode(code: string): PttBinding | null {
  if (Object.prototype.hasOwnProperty.call(KEYS, code)) {
    return { kind: "key", keycode: KEYS[code] as number };
  }
  if (Object.prototype.hasOwnProperty.call(MOUSE, code)) {
    return { kind: "mouse", button: MOUSE[code] as number };
  }
  return null;
}

/** Every supported keyboard code and its libuiohook code (for tests). */
export function keyboardTable(): Readonly<Record<string, number>> {
  return KEYS;
}

/**
 * `KeyboardEvent.code` → the name `uiohook-napi`'s `UiohookKey` uses for the
 * same key, where they differ. Used only by the cross-check test.
 */
export function uiohookNameFor(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  const renamed: Record<string, string> = {
    ControlLeft: "Ctrl",
    ControlRight: "CtrlRight",
    AltLeft: "Alt",
    ShiftLeft: "Shift",
    MetaLeft: "Meta",
  };
  return renamed[code] ?? code;
}
