import { describe, expect, it } from 'vitest'
import { StepPlayer, upTo, type Timers } from './player'

/** A clock the test moves by hand. */
function fakeTimers() {
  let now = 0
  let nextId = 1
  const pending = new Map<number, { at: number; fn: () => void }>()
  const timers: Timers = {
    set(fn, ms) {
      const id = nextId++
      pending.set(id, { at: now + ms, fn })
      return id
    },
    clear(id) {
      pending.delete(id)
    },
  }
  const advance = (ms: number) => {
    const end = now + ms
    for (;;) {
      const due = [...pending.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      pending.delete(due[0])
      now = due[1].at
      due[1].fn()
    }
    now = end
  }
  return { timers, advance, pending }
}

describe('StepPlayer', () => {
  it('holds each step for its own time and loops after the last', () => {
    const clock = fakeTimers()
    const seen: number[] = []
    const player = new StepPlayer([100, 200, 300], (i) => seen.push(i), clock.timers)
    player.play()
    clock.advance(99)
    expect(seen).toEqual([])
    clock.advance(1)
    expect(seen).toEqual([1])
    clock.advance(200)
    expect(seen).toEqual([1, 2])
    clock.advance(300)
    expect(seen).toEqual([1, 2, 0])
    expect(player.index).toBe(0)
  })

  it('stops on pause and holds the current step in full again on resume', () => {
    const clock = fakeTimers()
    const seen: number[] = []
    const player = new StepPlayer([100, 100], (i) => seen.push(i), clock.timers)
    player.play()
    clock.advance(60)
    player.pause()
    clock.advance(1000)
    expect(seen).toEqual([])
    expect(clock.pending.size).toBe(0)
    player.play()
    clock.advance(99)
    expect(seen).toEqual([])
    clock.advance(1)
    expect(seen).toEqual([1])
  })

  it('goTo clamps, reports and keeps playing from there; it is quiet while paused', () => {
    const clock = fakeTimers()
    const seen: number[] = []
    const player = new StepPlayer([100, 100, 100], (i) => seen.push(i), clock.timers)
    player.goTo(9)
    expect(player.index).toBe(2)
    player.step(-1)
    player.step(-1)
    player.step(-1)
    expect(seen).toEqual([2, 1, 0])
    clock.advance(500)
    expect(seen).toEqual([2, 1, 0])
    player.play()
    player.goTo(1)
    clock.advance(100)
    expect(seen).toEqual([2, 1, 0, 1, 2])
  })

  it('play twice schedules one timer', () => {
    const clock = fakeTimers()
    const player = new StepPlayer([100, 100], () => undefined, clock.timers)
    player.play()
    player.play()
    expect(clock.pending.size).toBe(1)
    player.dispose()
    expect(clock.pending.size).toBe(0)
  })

  it('refuses an empty script', () => {
    expect(() => new StepPlayer([], () => undefined)).toThrow()
  })
})

describe('upTo', () => {
  it('keeps what a step has reached', () => {
    const items = [{ at: 0 }, { at: 2 }, { at: 4 }]
    expect(upTo(items, 3)).toEqual([{ at: 0 }, { at: 2 }])
    expect(upTo(items, -1)).toEqual([])
  })
})
