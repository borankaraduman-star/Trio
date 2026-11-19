/** GET /api/health's storage facts (CONTRACT-V6-OPS §7), asked once per page load. */
import { parseHealth, type Health } from '../lib/persistence'

type Listener = () => void
let state: Health = { persistent: null, dataSince: null }
const listeners = new Set<Listener>()
let started = false

export async function fetchHealth(): Promise<Health> {
  try {
    const response = await fetch('/api/health', { cache: 'no-store' })
    if (!response.ok) return state
    state = parseHealth(await response.json())
    for (const listener of listeners) listener()
  } catch {
    // Offline: keep what we knew.
  }
  return state
}

const KNOWN_KEY = 'trio.dataSince'

/** The `data_since` of the database this device's session is valid in (see sessionEndedNotice). */
export function loadKnownDataSince(): string | null {
  try {
    return localStorage.getItem(KNOWN_KEY)
  } catch {
    return null
  }
}

/** Call only after an authenticated request succeeded: the session is valid in THIS database. */
export async function rememberDataSince(): Promise<void> {
  const { dataSince } = await fetchHealth()
  if (!dataSince) return
  try {
    localStorage.setItem(KNOWN_KEY, dataSince)
  } catch {
    // Private mode: the reset notice is not shown, the usual one is.
  }
}

export const healthStore = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener)
    if (!started) {
      started = true
      void fetchHealth()
    }
    return () => listeners.delete(listener)
  },
  getSnapshot(): Health {
    return state
  },
}
