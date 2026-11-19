/**
 * What the owner UI knows, shared by the settings sections and the red dot on
 * the settings button: whether this account is the owner, and the last
 * overview. Its own module (not store.ts): nothing else reads it.
 */
import { loadAuth } from '../api'
import { rememberDataSince } from './healthStore'
import { opsApi, type Overview } from './opsApi'

export interface OpsState {
  /** null: not asked yet (or it failed). */
  isOwner: boolean | null
  overview: Overview | null
}

type Listener = () => void

class OpsStore {
  private state: OpsState = { isOwner: null, overview: null }
  private readonly listeners = new Set<Listener>()
  private loading: Promise<void> | null = null
  private token: string | null = null

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): OpsState => this.state

  private set(patch: Partial<OpsState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }

  /** Ask the server again: /api/me, and the overview when this is the owner. Never throws. */
  refresh(): Promise<void> {
    if (this.loading) return this.loading
    const token = loadAuth()?.token
    if (!token) return Promise.resolve()
    // Another account signed in on this page: nothing of the last one carries over.
    if (token !== this.token) {
      this.token = token
      this.set({ isOwner: null, overview: null })
    }
    this.loading = (async () => {
      try {
        const { user } = await opsApi.me(token)
        // The session is valid in this database: remember which one (V6-OPS §7).
        void rememberDataSince()
        const isOwner = user.is_owner === true
        this.set({ isOwner, overview: isOwner ? this.state.overview : null })
        if (isOwner) this.set({ overview: await opsApi.overview(token) })
      } catch {
        // Offline or signed out: keep what we had.
      } finally {
        this.loading = null
      }
    })()
    return this.loading
  }

  setOverview(overview: Overview): void {
    this.set({ overview })
  }

  /** Signed out: forget everything (another account may sign in next). */
  reset(): void {
    this.set({ isOwner: null, overview: null })
  }
}

export const opsStore = new OpsStore()
