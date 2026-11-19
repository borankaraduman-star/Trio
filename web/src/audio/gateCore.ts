/**
 * The input gate's DSP (CONTRACT-V6-VOICE §4), pure so it is unit-tested with
 * synthetic signals, and run unchanged inside the AudioWorklet: gate.ts
 * builds the worklet module from `createGate.toString()`, so the function
 * must not refer to anything outside itself (and is a plain closure, not a
 * class: a class with fields can be compiled into code that calls a bundler
 * helper defined elsewhere in the chunk).
 *
 *   - Look-ahead: the output is the input DELAYED by `lookaheadMs`, and the
 *     detector reads the undelayed input. A word's onset therefore opens the
 *     gate before that onset reaches the output: nothing is clipped.
 *   - Opening is fast (a ~1 ms ramp, well inside the look-ahead); closing waits
 *     `holdMs` after the last sample over the threshold has LEFT the delay
 *     line, then ramps down over ~20 ms.
 *   - The threshold is a peak amplitude (0..1), the same measure as the level
 *     bar in Ayarlar › Ses (peak dBFS).
 */
export interface Gate {
  process(input: Float32Array, output: Float32Array): void
  setThreshold(linear: number): void
  /** Open or opening (a sample over the threshold is in the delay line or its hold). */
  isOpen(): boolean
  gain(): number
  lookahead: number
}

export function createGate(sampleRate: number, thresholdLinear: number, holdMs: number, lookaheadMs: number): Gate {
  let threshold = thresholdLinear
  const size = Math.max(1, Math.round((sampleRate * lookaheadMs) / 1000))
  const hold = Math.round((sampleRate * holdMs) / 1000)
  const attackStep = 1 / Math.max(1, Math.round(sampleRate / 1000))
  const releaseStep = 1 / Math.max(1, Math.round((sampleRate * 20) / 1000))
  const delay = new Float32Array(size)
  let index = 0
  let holdLeft = 0
  let gain = 0
  return {
    lookahead: size,
    setThreshold(linear: number) {
      threshold = linear
    },
    isOpen() {
      return holdLeft > 0
    },
    gain() {
      return gain
    },
    process(input: Float32Array, output: Float32Array) {
      for (let i = 0; i < input.length; i++) {
        const x = input[i]
        if (x > threshold || -x > threshold) holdLeft = hold + size
        else if (holdLeft > 0) holdLeft--
        if (holdLeft > 0) gain = gain + attackStep > 1 ? 1 : gain + attackStep
        else if (gain > 0) gain = gain - releaseStep < 0 ? 0 : gain - releaseStep
        const delayed = delay[index]
        delay[index] = x
        index = index + 1 === size ? 0 : index + 1
        output[i] = delayed * gain
      }
    },
  }
}

export const GATE_HOLD_MS = 250
export const GATE_LOOKAHEAD_MS = 10

export function dbToLinear(db: number): number {
  return Math.pow(10, db / 20)
}

export function linearToDb(value: number): number {
  return value > 0 ? 20 * Math.log10(value) : -Infinity
}
