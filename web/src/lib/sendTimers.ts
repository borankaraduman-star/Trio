/**
 * The "give up on an unconfirmed message" timers: one per nonce.
 *
 * The server answers a refused message with a bare `error` frame that names
 * no nonce, so a row nobody confirmed is marked failed after a while. Starting
 * the timer again for the same nonce (a retry) replaces the old one, so a
 * timer from the first attempt can never fail the retry while it is in flight.
 */
export class SendTimers {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()

  start(nonce: string, ms: number, onTimeout: () => void): void {
    this.clear(nonce)
    this.timers.set(
      nonce,
      setTimeout(() => {
        this.timers.delete(nonce)
        onTimeout()
      }, ms),
    )
  }

  /** The message was confirmed (or given up on): its timer must not fire. */
  clear(nonce: string): void {
    const timer = this.timers.get(nonce)
    if (timer === undefined) return
    clearTimeout(timer)
    this.timers.delete(nonce)
  }

  clearAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  has(nonce: string): boolean {
    return this.timers.has(nonce)
  }
}
