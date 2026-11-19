import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SendTimers } from '../lib/sendTimers'

describe('SendTimers', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('fires once after the delay', () => {
    const timers = new SendTimers()
    const fired = vi.fn()
    timers.start('n1', 10_000, fired)
    vi.advanceTimersByTime(9_999)
    expect(fired).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fired).toHaveBeenCalledOnce()
    expect(timers.has('n1')).toBe(false)
  })

  it('a retry restarts the timer: the first attempt cannot fail the retry in flight', () => {
    const timers = new SendTimers()
    const first = vi.fn()
    const retry = vi.fn()
    timers.start('n1', 10_000, first)
    vi.advanceTimersByTime(8_000)
    timers.start('n1', 10_000, retry)
    vi.advanceTimersByTime(9_000) // 17 s after the first attempt
    expect(first).not.toHaveBeenCalled()
    expect(retry).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1_000)
    expect(first).not.toHaveBeenCalled()
    expect(retry).toHaveBeenCalledOnce()
  })

  it('a confirmed message clears its timer and leaves the others alone', () => {
    const timers = new SendTimers()
    const one = vi.fn()
    const two = vi.fn()
    timers.start('n1', 10_000, one)
    timers.start('n2', 10_000, two)
    timers.clear('n1')
    timers.clear('unknown')
    vi.advanceTimersByTime(10_000)
    expect(one).not.toHaveBeenCalled()
    expect(two).toHaveBeenCalledOnce()
  })

  it('clearAll stops everything', () => {
    const timers = new SendTimers()
    const fired = vi.fn()
    timers.start('n1', 10, fired)
    timers.start('n2', 10, fired)
    timers.clearAll()
    vi.advanceTimersByTime(100)
    expect(fired).not.toHaveBeenCalled()
  })
})
