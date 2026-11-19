/**
 * Speaking detection's level measurement, framework-free so it is unit-tested.
 *
 * The detector reads each analyser on a timer (`SPEAKING_POLL_MS` in
 * `voice.ts`). An analyser hands back only its most recent `fftSize` samples,
 * so with a window SHORTER than the poll interval most of the audio is never
 * looked at: with 512 samples (~11 ms) read every 100 ms, ~88 % of the signal
 * fell between two reads. A sound shorter than the gap could be missed on
 * every single poll, for as long as its rhythm kept the same phase against
 * the timer — which is exactly what Chromium's fake microphone does (a 20 ms
 * beep every 500 ms): the ring for a person who was clearly heard never lit.
 * A short real sound (a quick "hı", a laugh's first burst) fell through the
 * same gap.
 *
 * So the window covers the whole interval since the last read (with room for
 * a late timer), and the level is the loudest SHORT block inside it — the
 * same ~11 ms RMS the detector always used, so the threshold keeps its
 * meaning; a long window's plain RMS would dilute a short sound instead.
 */

/** Samples per level block: what a single read used to cover (~11 ms at 44.1–48 kHz). */
export const LEVEL_BLOCK = 512

/** The analyser size whose window spans `pollMs` plus half again (a late timer), as a power of two. */
export function analyserSizeFor(sampleRate: number, pollMs: number): number {
  const wanted = Math.ceil((sampleRate * pollMs * 1.5) / 1000)
  let size = LEVEL_BLOCK
  while (size < wanted && size < 32768) size *= 2
  return size
}

/** The RMS of the loudest `block`-sample stretch of `samples` (time-domain, −1…1). */
export function loudestBlockRms(samples: Float32Array, block = LEVEL_BLOCK): number {
  let loudest = 0
  for (let start = 0; start < samples.length; start += block) {
    const end = Math.min(samples.length, start + block)
    let sum = 0
    for (let i = start; i < end; i++) sum += samples[i] * samples[i]
    const rms = Math.sqrt(sum / (end - start))
    if (rms > loudest) loudest = rms
  }
  return loudest
}
