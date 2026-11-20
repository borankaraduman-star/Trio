/**
 * The demos' scheduler: a list of steps, each held for its own time, played in
 * a loop. Pure apart from the timer it is given, so it is unit-tested with a
 * fake clock. A demo renders from the step index alone, which is what makes
 * "show the last step" a complete still picture for reduced motion.
 */

export interface Timers {
  set(fn: () => void, ms: number): number
  clear(id: number): void
}

const realTimers: Timers = {
  set: (fn, ms) => window.setTimeout(fn, ms),
  clear: (id) => window.clearTimeout(id),
}

export class StepPlayer {
  private timer: number | null = null
  private current = 0
  private playingNow = false

  constructor(
    /** How long each step is held, in ms; the last one is the pause before the loop starts again. */
    private readonly durations: readonly number[],
    private readonly onStep: (index: number) => void,
    private readonly timers: Timers = realTimers,
  ) {
    if (durations.length === 0) throw new Error('a demo needs at least one step')
  }

  get index(): number {
    return this.current
  }

  get playing(): boolean {
    return this.playingNow
  }

  get last(): number {
    return this.durations.length - 1
  }

  /** Start (or resume) from the current step; the step is held for its full time again. */
  play(): void {
    if (this.playingNow) return
    this.playingNow = true
    this.schedule()
  }

  pause(): void {
    this.playingNow = false
    this.cancel()
  }

  /** Jump to a step (clamped); playing continues from there. */
  goTo(index: number): void {
    const next = Math.min(this.last, Math.max(0, Math.round(index)))
    this.cancel()
    this.set(next)
    if (this.playingNow) this.schedule()
  }

  step(by: 1 | -1): void {
    this.goTo(this.current + by)
  }

  dispose(): void {
    this.pause()
  }

  private set(index: number): void {
    if (index === this.current) return
    this.current = index
    this.onStep(index)
  }

  private schedule(): void {
    this.cancel()
    this.timer = this.timers.set(() => {
      this.timer = null
      if (!this.playingNow) return
      this.set(this.current >= this.last ? 0 : this.current + 1)
      this.schedule()
    }, this.durations[this.current])
  }

  private cancel(): void {
    if (this.timer !== null) this.timers.clear(this.timer)
    this.timer = null
  }
}

/** Steps a script reveals: the items whose `at` is at or before the current step. */
export function upTo<T extends { at: number }>(items: readonly T[], step: number): T[] {
  return items.filter((item) => item.at <= step)
}
