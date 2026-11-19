/**
 * Mute/deafen shortcuts (CONTRACT-V6-VOICE §5). Pure helpers.
 *
 * Desktop app: one GLOBAL key each (a `KeyboardEvent.code`, the same key hook
 * as push-to-talk, which knows single keys, not chords). Browser: an in-page
 * chord each ("Ctrl+Shift+KeyM"), only while the tab is focused.
 */
import { isBindableKey, keyLabel } from '../settings'

export type HotkeyAction = 'mute' | 'deafen'

export interface Combo {
  code: string
  ctrl: boolean
  shift: boolean
  alt: boolean
  meta: boolean
}

export const DEFAULT_PAGE_SHORTCUTS: Record<HotkeyAction, string> = {
  mute: 'Ctrl+Shift+KeyM',
  deafen: 'Ctrl+Shift+KeyD',
}

const MODIFIER_CODES = new Set([
  'ShiftLeft',
  'ShiftRight',
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
])

export function parseCombo(text: unknown): Combo | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > 64) return null
  const parts = text.split('+')
  const code = parts.pop() ?? ''
  if (!isBindableKey(code) || MODIFIER_CODES.has(code)) return null
  const combo: Combo = { code, ctrl: false, shift: false, alt: false, meta: false }
  for (const part of parts) {
    if (part === 'Ctrl') combo.ctrl = true
    else if (part === 'Shift') combo.shift = true
    else if (part === 'Alt') combo.alt = true
    else if (part === 'Meta') combo.meta = true
    else return null
  }
  // A bare key in a page would fire while typing a word: a chord needs Ctrl, Alt or Meta.
  if (!combo.ctrl && !combo.alt && !combo.meta) return null
  return combo
}

export function formatCombo(combo: Combo): string {
  return [combo.ctrl && 'Ctrl', combo.shift && 'Shift', combo.alt && 'Alt', combo.meta && 'Meta', combo.code]
    .filter(Boolean)
    .join('+')
}

/** The chord a key-down makes, or null (a lone modifier, or no Ctrl/Alt/Meta). */
export function comboFromEvent(event: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>): string | null {
  const text = formatCombo({
    code: event.code,
    ctrl: event.ctrlKey,
    shift: event.shiftKey,
    alt: event.altKey,
    meta: event.metaKey,
  })
  return parseCombo(text) ? text : null
}

export function matchesCombo(
  text: string,
  event: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>,
): boolean {
  const combo = parseCombo(text)
  return (
    combo !== null &&
    combo.code === event.code &&
    combo.ctrl === event.ctrlKey &&
    combo.shift === event.shiftKey &&
    combo.alt === event.altKey &&
    combo.meta === event.metaKey
  )
}

/** "Ctrl + Shift + M" */
export function comboLabel(text: string): string {
  const combo = parseCombo(text)
  if (!combo) return '—'
  return [combo.ctrl && 'Ctrl', combo.shift && 'Shift', combo.alt && 'Alt', combo.meta && 'Meta', keyLabel(combo.code)]
    .filter(Boolean)
    .join(' + ')
}

/**
 * Why this set of keys cannot be used, or null. A key cannot be both the
 * push-to-talk key and a hotkey (one would swallow the other in the hook),
 * and mute and deafen cannot share one key. `ptt` is null when the input mode
 * is not push-to-talk.
 */
export function hotkeyConflict(keys: { ptt: string | null; mute: string | null; deafen: string | null }): string | null {
  const { ptt, mute, deafen } = keys
  if (mute !== null && mute === deafen) return 'Sessize alma ve kulaklık aynı tuş olamaz.'
  if (ptt !== null && (mute === ptt || deafen === ptt)) return 'Bu tuş bas-konuş tuşu; başka bir tuş seç.'
  return null
}

/** A value for a desktop hotkey from storage: a bindable code or null. */
export function desktopKey(value: unknown): string | null {
  return typeof value === 'string' && isBindableKey(value) ? value : null
}

/** A shortcut is being bound in the settings: the shortcuts themselves do nothing meanwhile. */
let binding = 0
export function setBinding(on: boolean): void {
  binding = Math.max(0, binding + (on ? 1 : -1))
}
export function isBinding(): boolean {
  return binding > 0
}
