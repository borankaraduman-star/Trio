/**
 * CONTRACT-V4 A1: actions that need signalling, asked for while the socket is
 * down, wait here. They run, in the order they were first asked for, when the
 * call is back in step (`flush`), or are dropped (`onDropped`, which shows a
 * notice) once the first of them has waited `limitMs`. One entry per key: a
 * later request for the same key replaces the earlier one (the camera turned
 * on and off again while down is one decision, the last), and `cancel`
 * forgets a key (the request was undone). Timers are injectable for tests.
 */

export interface HeldTimers {
  set: (fn: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
}

const REAL_TIMERS: HeldTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export const HOLD_LIMIT_MS = 30_000

export class HeldActions<K extends string = string> {
  private readonly entries = new Map<K, () => void>()
  private timer: unknown = null

  constructor(
    private readonly onDropped: (keys: K[]) => void,
    private readonly limitMs: number = HOLD_LIMIT_MS,
    private readonly timers: HeldTimers = REAL_TIMERS,
  ) {}

  hold(key: K, run: () => void): void {
    // A Map keeps an existing key's place: the order is of first requests.
    this.entries.set(key, run)
    if (this.timer === null) this.timer = this.timers.set(() => this.expire(), this.limitMs)
  }

  cancel(key: K): void {
    this.entries.delete(key)
    if (this.entries.size === 0) this.stopTimer()
  }

  has(key: K): boolean {
    return this.entries.has(key)
  }

  get size(): number {
    return this.entries.size
  }

  /** Run everything held, oldest first; an action that throws does not stop the rest. */
  flush(): void {
    const actions = [...this.entries.values()]
    this.entries.clear()
    this.stopTimer()
    for (const run of actions) {
      try {
        run()
      } catch (error) {
        console.warn('trio: a held action failed', error)
      }
    }
  }

  /** Forget everything without running it or saying so (the call ended). */
  clear(): void {
    this.entries.clear()
    this.stopTimer()
  }

  private expire(): void {
    this.timer = null
    const keys = [...this.entries.keys()]
    this.entries.clear()
    if (keys.length > 0) this.onDropped(keys)
  }

  private stopTimer(): void {
    if (this.timer !== null) this.timers.clear(this.timer)
    this.timer = null
  }
}
