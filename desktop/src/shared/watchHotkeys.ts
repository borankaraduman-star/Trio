/**
 * CONTRACT-V12-MINI-DESKTOP §4: the global "watching" keys. Pure, so the
 * conflict rules are unit-tested and the web can mirror them word for word.
 *
 * A key is a `KeyboardEvent.code` ("F9"), a mouse side button ("MouseBack"),
 * or a chord in the page shortcuts' format ("Ctrl+Alt+KeyM": `Ctrl`, `Alt`,
 * `Shift`, `Meta` in any order, then one non-modifier key code). A chord
 * matches only with exactly those modifiers held; a plain key only with none
 * of Ctrl/Alt/Meta held (Shift neither), so "F9" and "Ctrl+F9" are two keys.
 * Mouse buttons take no modifiers.
 */
import { bindingForCode, type PttBinding } from "./keymap";

export const WATCH_ACTIONS = [
  "toggleMini",
  "nextShare",
  "clickThrough",
  "muteShare",
  "shareVolumeUp",
  "shareVolumeDown",
  "theatre",
] as const;
export type WatchAction = (typeof WATCH_ACTIONS)[number];

export interface Modifiers {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
}

export interface WatchKey {
  binding: PttBinding;
  mods: Modifiers;
}

const MODIFIER_CODES = new Set([
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
]);

const NO_MODS: Modifiers = { ctrl: false, alt: false, shift: false, meta: false };

/** Parse a stored key, or null when the hook cannot listen for it. */
export function parseWatchKey(text: unknown): WatchKey | null {
  if (typeof text !== "string" || text.length === 0 || text.length > 64) return null;
  const parts = text.split("+");
  const code = parts.pop() ?? "";
  const binding = bindingForCode(code);
  if (!binding) return null;
  const mods: Modifiers = { ...NO_MODS };
  for (const part of parts) {
    if (part === "Ctrl" && !mods.ctrl) mods.ctrl = true;
    else if (part === "Alt" && !mods.alt) mods.alt = true;
    else if (part === "Shift" && !mods.shift) mods.shift = true;
    else if (part === "Meta" && !mods.meta) mods.meta = true;
    else return null;
  }
  const chord = mods.ctrl || mods.alt || mods.shift || mods.meta;
  if (chord && (binding.kind === "mouse" || MODIFIER_CODES.has(code))) return null;
  return { binding, mods };
}

export function sameBinding(a: PttBinding, b: PttBinding): boolean {
  return a.kind === "key" && b.kind === "key"
    ? a.keycode === b.keycode
    : a.kind === "mouse" && b.kind === "mouse" && a.button === b.button;
}

function sameKey(a: WatchKey, b: WatchKey): boolean {
  return (
    sameBinding(a.binding, b.binding) &&
    a.mods.ctrl === b.mods.ctrl &&
    a.mods.alt === b.mods.alt &&
    a.mods.shift === b.mods.shift &&
    a.mods.meta === b.mods.meta
  );
}

/** The sentences the shell uses (and the web settings show) for a refused key. */
export const WATCH_REASONS = {
  unsupported: "Bu tuş kullanılamıyor; başka bir tuş seç.",
  ptt: "Bu tuş bas-konuş tuşu; başka bir tuş seç.",
  mute: "Bu tuş sessize alma kısayolu; başka bir tuş seç.",
  deafen: "Bu tuş kulaklık kısayolu; başka bir tuş seç.",
  duplicate: "Bu tuş başka bir izleme kısayolunda; başka bir tuş seç.",
} as const;

export type WatchRefusal = keyof typeof WATCH_REASONS;

/**
 * Which watch keys are refused and why. PTT, mute and deafen listen to their
 * key whatever modifiers are held, so a watch key on the same physical key
 * (chord or not) would fire both: refused. Two watch actions may not have the
 * same key: the first in WATCH_ACTIONS order keeps it.
 */
export function watchConflicts(
  watch: Partial<Record<WatchAction, string | null>>,
  others: { ptt: string | null; mute: string | null; deafen: string | null },
): Partial<Record<WatchAction, WatchRefusal>> {
  const refused: Partial<Record<WatchAction, WatchRefusal>> = {};
  const taken: WatchKey[] = [];
  const base = (code: string | null): PttBinding | null => (typeof code === "string" ? bindingForCode(code) : null);
  const ptt = base(others.ptt);
  const mute = base(others.mute);
  const deafen = base(others.deafen);
  for (const action of WATCH_ACTIONS) {
    const text = watch[action];
    if (text === null || text === undefined) continue;
    const key = parseWatchKey(text);
    if (!key) refused[action] = "unsupported";
    else if (ptt && sameBinding(key.binding, ptt)) refused[action] = "ptt";
    else if (mute && sameBinding(key.binding, mute)) refused[action] = "mute";
    else if (deafen && sameBinding(key.binding, deafen)) refused[action] = "deafen";
    else if (taken.some((t) => sameKey(t, key))) refused[action] = "duplicate";
    else taken.push(key);
  }
  return refused;
}

/** Whether a key-down (or mouse-down) with these modifiers is this watch key. */
export function matchesWatchKey(key: WatchKey, binding: PttBinding, mods: Partial<Modifiers>): boolean {
  if (!sameBinding(key.binding, binding)) return false;
  if (binding.kind === "mouse") return true;
  return (
    key.mods.ctrl === (mods.ctrl === true) &&
    key.mods.alt === (mods.alt === true) &&
    key.mods.shift === (mods.shift === true) &&
    key.mods.meta === (mods.meta === true)
  );
}
