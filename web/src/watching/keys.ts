/**
 * CONTRACT-V12-WATCHING §7: the watching keys. Pure.
 *
 * Unbound by default, on purpose: a game owns most of the keyboard, and a
 * key Trio takes globally in the desktop app is a key the game no longer
 * gets. A key is a `KeyboardEvent.code` ("F9", desktop only), a mouse side
 * button (desktop only) or a chord in the page shortcuts' format
 * ("Ctrl+Shift+F9"). The refusals and their sentences are the desktop
 * shell's (`WATCH_REASONS`, CONTRACT-V12-MINI-DESKTOP §4), checked here
 * before anything is sent; the shell's check is the backstop.
 */
import type { WatchHotkeyAction } from '../ptt'
import type { WatchKeys } from './store'

export const WATCH_REASONS = {
  unsupported: 'Bu tuş kullanılamıyor; başka bir tuş seç.',
  ptt: 'Bu tuş bas-konuş tuşu; başka bir tuş seç.',
  mute: 'Bu tuş sessize alma kısayolu; başka bir tuş seç.',
  deafen: 'Bu tuş kulaklık kısayolu; başka bir tuş seç.',
  duplicate: 'Bu tuş başka bir izleme kısayolunda; başka bir tuş seç.',
} as const

/** Suggested chords (none is set until the user picks): Ctrl+Shift with an F-key. */
export const SUGGESTED_WATCH_KEYS: Partial<Record<WatchHotkeyAction, string>> = {
  toggleMini: 'Ctrl+Shift+F9',
  clickThrough: 'Ctrl+Shift+F10',
  nextShare: 'Ctrl+Shift+F11',
}

/** The physical key of a key or chord ("Ctrl+Shift+F9" → "F9"). */
export function baseCode(key: string): string {
  const parts = key.split('+')
  return parts[parts.length - 1] ?? key
}

const ORDER: readonly WatchHotkeyAction[] = [
  'toggleMini',
  'nextShare',
  'clickThrough',
  'muteShare',
  'shareVolumeUp',
  'shareVolumeDown',
  'theatre',
]

/**
 * Why `action`'s key is refused, or null. PTT, mute and deafen listen to their
 * physical key whatever modifiers are held: a watch key on the same physical
 * key would fire both. Two watch actions may not share a key: the first in
 * the shell's order keeps it.
 */
export function watchKeyRefusal(
  keys: WatchKeys,
  action: WatchHotkeyAction,
  taken: { ptt: string | null; mute: string | null; deafen: string | null },
): string | null {
  const key = keys[action]
  if (key === null) return null
  const base = baseCode(key)
  if (taken.ptt !== null && base === baseCode(taken.ptt)) return WATCH_REASONS.ptt
  if (taken.mute !== null && base === baseCode(taken.mute)) return WATCH_REASONS.mute
  if (taken.deafen !== null && base === baseCode(taken.deafen)) return WATCH_REASONS.deafen
  for (const earlier of ORDER) {
    if (earlier === action) break
    if (keys[earlier] === key) return WATCH_REASONS.duplicate
  }
  return null
}

/** The first refusal among `keys`, or null. */
export function watchKeyConflict(keys: WatchKeys, taken: { ptt: string | null; mute: string | null; deafen: string | null }): string | null {
  for (const action of ORDER) {
    const refusal = watchKeyRefusal(keys, action, taken)
    if (refusal) return refusal
  }
  return null
}

/** The keys to hand the desktop shell: refused ones left unbound. */
export function effectiveWatchKeys(keys: WatchKeys, taken: { ptt: string | null; mute: string | null; deafen: string | null }): WatchKeys {
  const out = { ...keys }
  for (const action of ORDER) if (watchKeyRefusal(keys, action, taken)) out[action] = null
  return out
}
