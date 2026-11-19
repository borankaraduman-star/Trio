import { describe, expect, it, vi } from 'vitest'
import { HeldActions, type HeldTimers } from '../lib/heldActions'

function fakeTimers() {
  let pending: { fn: () => void; ms: number } | null = null
  const timers: HeldTimers = {
    set: (fn, ms) => {
      pending = { fn, ms }
      return pending
    },
    clear: (handle) => {
      if (handle === pending) pending = null
    },
  }
  return {
    timers,
    fire: () => {
      const p = pending
      pending = null
      p?.fn()
    },
    get pending() {
      return pending
    },
  }
}

describe('HeldActions', () => {
  it('runs held actions on flush, in the order first asked, each key once (the newest)', () => {
    const clock = fakeTimers()
    const dropped = vi.fn()
    const held = new HeldActions<'a' | 'b'>(dropped, 30_000, clock.timers)
    const ran: string[] = []
    held.hold('a', () => ran.push('a1'))
    held.hold('b', () => ran.push('b'))
    held.hold('a', () => ran.push('a2'))
    expect(held.size).toBe(2)
    held.flush()
    expect(ran).toEqual(['a2', 'b'])
    expect(held.size).toBe(0)
    expect(clock.pending).toBeNull()
    expect(dropped).not.toHaveBeenCalled()
  })

  it('drops everything with one notice after the limit, counted from the first hold', () => {
    const clock = fakeTimers()
    const dropped = vi.fn()
    const held = new HeldActions<'a' | 'b'>(dropped, 30_000, clock.timers)
    const run = vi.fn()
    held.hold('a', run)
    expect(clock.pending?.ms).toBe(30_000)
    held.hold('b', run)
    clock.fire()
    expect(dropped).toHaveBeenCalledWith(['a', 'b'])
    held.flush()
    expect(run).not.toHaveBeenCalled()
  })

  it('cancel forgets a key, and the timer when nothing is left', () => {
    const clock = fakeTimers()
    const held = new HeldActions<'a'>(vi.fn(), 30_000, clock.timers)
    held.hold('a', vi.fn())
    held.cancel('a')
    expect(held.has('a')).toBe(false)
    expect(clock.pending).toBeNull()
  })

  it('an action that throws does not stop the others', () => {
    const held = new HeldActions<'a' | 'b'>(vi.fn(), 30_000, fakeTimers().timers)
    const later = vi.fn()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    held.hold('a', () => {
      throw new Error('x')
    })
    held.hold('b', later)
    held.flush()
    expect(later).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('clear forgets everything without the notice', () => {
    const clock = fakeTimers()
    const dropped = vi.fn()
    const held = new HeldActions<'a'>(dropped, 30_000, clock.timers)
    held.hold('a', vi.fn())
    held.clear()
    clock.fire()
    expect(dropped).not.toHaveBeenCalled()
  })
})
