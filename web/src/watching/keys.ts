/**
 * CONTRACT-V12-WATCHING §7: the watching keys. Pure.
 *
 * Unbound by default, on purpose: a game owns most of the keyboard, and a
 * key Trio takes globally in the desktop app is a key the game no longer
 * gets. The settings suggest keys games rarely use (the numeric keypad,
 * F13–F24 on keyboards that have them, mouse side buttons).
 */
import type { WatchHotkeyAction } from '../ptt'
import type { WatchKeys } from './store'

/** Why `keys` cannot be used, or null: one key does one thing, and never the PTT, mute or deafen key. */
export function watchKeyConflict(
  keys: WatchKeys,
  taken: { ptt: string | null; mute: string | null; deafen: string | null },
): string | null {
  const seen = new Map<string, WatchHotkeyAction>()
  for (const [action, key] of Object.entries(keys) as [WatchHotkeyAction, string | null][]) {
    if (key === null) continue
    if (key === taken.ptt) return 'Bu tuş bas-konuş tuşu; başka bir tuş seç.'
    if (key === taken.mute || key === taken.deafen) return 'Bu tuş sessize alma ya da kulaklık kısayolu; başka bir tuş seç.'
    if (seen.has(key)) return 'Bir tuş yalnız bir işe atanabilir.'
    seen.set(key, action)
  }
  return null
}

/** The keys to hand the desktop shell: only bound ones, none if any conflict stands. */
export function effectiveWatchKeys(
  keys: WatchKeys,
  taken: { ptt: string | null; mute: string | null; deafen: string | null },
): WatchKeys {
  const out = { ...keys }
  for (const action of Object.keys(out) as WatchHotkeyAction[]) {
    const key = out[action]
    if (key !== null && (key === taken.ptt || key === taken.mute || key === taken.deafen)) out[action] = null
  }
  return out
}
