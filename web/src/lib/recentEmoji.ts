/**
 * The emoji this device used last, most recent first (localStorage
 * `trio.recentEmoji`). Unreadable or blocked storage is an empty list.
 */
import { normalizeReactionKey } from './emojiKey'

export const RECENT_KEY = 'trio.recentEmoji'
export const MAX_RECENT = 16

export interface KeyValueStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function storage(): KeyValueStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function loadRecent(store: KeyValueStore | null = storage()): string[] {
  if (!store) return []
  try {
    const raw: unknown = JSON.parse(store.getItem(RECENT_KEY) ?? '[]')
    if (!Array.isArray(raw)) return []
    const seen = new Set<string>()
    const result: string[] = []
    for (const value of raw) {
      if (typeof value !== 'string' || value === '') continue
      const key = normalizeReactionKey(value)
      if (seen.has(key)) continue
      seen.add(key)
      result.push(key)
      if (result.length === MAX_RECENT) break
    }
    return result
  } catch {
    return []
  }
}

/** `emoji` moved (or added) to the front; returns the new list. */
export function pushRecent(emoji: string, store: KeyValueStore | null = storage()): string[] {
  const key = normalizeReactionKey(emoji)
  const next = [key, ...loadRecent(store).filter((item) => item !== key)].slice(0, MAX_RECENT)
  try {
    store?.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    // Remembered for this page only.
  }
  return next
}
