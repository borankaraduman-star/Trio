import { describe, expect, it } from 'vitest'
import { analyserSizeFor, LEVEL_BLOCK, loudestBlockRms } from '../audio/speaking'

const RATE = 44100
const POLL_MS = 100
const THRESHOLD = 0.02

/** A 20 ms square beep (amplitude 0.3) every 500 ms, starting at `phaseMs`: Chromium's fake microphone. */
function beepAt(timeMs: number, phaseMs: number): number {
  const t = (((timeMs - phaseMs) % 500) + 500) % 500
  if (t >= 20) return 0
  return Math.floor(t * 0.8) % 2 === 0 ? 0.3 : -0.3
}

/** What an analyser of `size` samples hands back when read at `nowMs`. */
function window(size: number, nowMs: number, phaseMs: number): Float32Array {
  const samples = new Float32Array(size)
  for (let i = 0; i < size; i++) samples[i] = beepAt(nowMs - ((size - i) * 1000) / RATE, phaseMs)
  return samples
}

/** How many of 40 polls (4 s, 8 beeps) see the beep, for an analyser of `size`. */
function polledHits(size: number, phaseMs: number): number {
  let hits = 0
  for (let poll = 1; poll <= 40; poll++) {
    if (loudestBlockRms(window(size, poll * POLL_MS, phaseMs)) > THRESHOLD) hits += 1
  }
  return hits
}

describe('speaking detection level', () => {
  it('covers the whole poll interval, so a short periodic sound is never lost between reads', () => {
    const size = analyserSizeFor(RATE, POLL_MS)
    expect((size * 1000) / RATE).toBeGreaterThanOrEqual(POLL_MS)
    // Every phase of the beep against the timer: each beep is seen at least once.
    for (let phase = 0; phase < 500; phase += 7) expect(polledHits(size, phase)).toBeGreaterThanOrEqual(8)
  })

  it('the old 512-sample snapshot missed the same beep on every poll at most phases', () => {
    // The regression this module exists for: some phases never light the ring.
    const missed = [...Array(72).keys()].filter((k) => polledHits(LEVEL_BLOCK, k * 7) === 0)
    expect(missed.length).toBeGreaterThan(30)
  })

  it('keeps the short-block threshold: a 20 ms beep in a long window is not diluted', () => {
    const size = analyserSizeFor(48000, POLL_MS)
    const samples = new Float32Array(size)
    for (let i = 0; i < 960; i++) samples[size - 2000 + i] = i % 40 < 20 ? 0.3 : -0.3
    expect(loudestBlockRms(samples)).toBeCloseTo(0.3, 2)
    expect(loudestBlockRms(new Float32Array(size))).toBe(0)
  })

  it('sizes the analyser as a power of two within the Web Audio limit', () => {
    expect(analyserSizeFor(44100, 100)).toBe(8192)
    expect(analyserSizeFor(48000, 100)).toBe(8192)
    expect(analyserSizeFor(8000, 10)).toBe(LEVEL_BLOCK)
    expect(analyserSizeFor(384000, 1000)).toBe(32768)
  })
})
