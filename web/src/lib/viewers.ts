/**
 * CONTRACT-V10-GROUPS §4b: who is in which text channel right now, and my own
 * "Hangi kanalda olduğumu göster" (per device, on by default:
 * `localStorage["trio.v10.showChannel"] = "0"` while off).
 */
import { namesWithMore } from './groups'

export const SHOW_CHANNEL_KEY = 'trio.v10.showChannel'

type Listener = () => void
const listeners = new Set<Listener>()

function read(): boolean {
  try {
    return localStorage.getItem(SHOW_CHANNEL_KEY) !== '0'
  } catch {
    return true
  }
}

let current = typeof localStorage === 'undefined' ? true : read()

export const showChannel = {
  getSnapshot: (): boolean => current,
  subscribe(listener: Listener): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  set(on: boolean): void {
    current = on
    try {
      if (on) localStorage.removeItem(SHOW_CHANNEL_KEY)
      else localStorage.setItem(SHOW_CHANNEL_KEY, '0')
    } catch {
      // Private mode: for this page only.
    }
    for (const listener of listeners) listener()
  },
}

/** user id → channel id from `ready.viewers` ("<channel id>": [user ids]). */
export function viewersFromReady(raw: unknown): Record<number, number> {
  const out: Record<number, number> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [key, list] of Object.entries(raw as Record<string, unknown>)) {
    const channelId = Number(key)
    if (!Number.isInteger(channelId) || !Array.isArray(list)) continue
    for (const id of list) if (Number.isInteger(id)) out[id as number] = channelId
  }
  return out
}

/** The people in `channelId`, me first, then by name. */
export function viewersOf<T extends { id: number; name: string }>(
  viewers: Record<number, number>,
  channelId: number,
  users: Record<number, T>,
  me: number,
): T[] {
  return Object.entries(viewers)
    .filter(([, channel]) => channel === channelId)
    .map(([id]) => users[Number(id)])
    .filter((user): user is T => user !== undefined)
    .sort((a, b) => (a.id === me ? -1 : b.id === me ? 1 : a.name.localeCompare(b.name, 'tr')))
}

/** "Burada: Sen, Ece +2" (the channel header), or null when nobody is shown. */
export function hereLine(people: readonly { id: number; name: string }[], me: number): string | null {
  if (people.length === 0) return null
  return `Burada: ${namesWithMore(people.map((p) => (p.id === me ? 'Sen' : p.name)))}`
}

/** Under a channel row: names while they fit, stacked faces and "+n" past this many. */
export const VIEWER_ROWS_MAX = 4
