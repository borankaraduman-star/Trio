/**
 * CONTRACT-V12-WATCHING §6: the seam between the Trio window (the OPENER)
 * and a mini player (a same-origin child window `/mini.html?m=<id>` named
 * `trio-mini-<id>`, or the browser's Document Picture-in-Picture window).
 *
 * The opener owns everything: the MediaStream (it attaches it to the mini's
 * `<video data-mini-video>` and re-attaches it when a renegotiation or a
 * fresh connection hands it a new stream), the `{watch}` accounting (the
 * mini reports its size through the opener), the share's sound (it keeps
 * playing in the Trio window: the mini's video is always muted, so nothing
 * is heard twice) and the share's lifecycle (the share ends → the mini
 * closes itself). The mini only draws and calls these actions.
 *
 * The opener puts the controller on the child as `window.__trioMini` and
 * fires `trio-mini-ready` on it; the mini waits for either.
 */
export interface MiniSnapshot {
  sharerId: number
  /** "Ayşe" */
  name: string
  /** The share carries sound ("Yayın sesi"). */
  hasAudio: boolean
  /** "Yayın sesi" 0–2 (the V6 per-person stream volume), and whether it is muted. */
  volume: number
  muted: boolean
  /** "Konuşuyor: Mehmet" or null. */
  speaking: string | null
  /** How many screens are shared now (the "next" button shows from 2). */
  shareCount: number
  light: boolean
  audioOnly: boolean
  /** The desktop shell's mini window (opacity and click-through are offered). */
  desktop: boolean
  clickThrough: boolean
  opacity: number
  /** The share ended: the mini says so and closes. */
  ended: boolean
}

export interface MiniController {
  getSnapshot(): MiniSnapshot
  subscribe(listener: () => void): () => void
  /** The mini's `<video>` (muted, picture only); the opener attaches the stream to it. */
  attach(video: HTMLVideoElement | null): void
  /** The mini's own size and visibility (its share is sent at that size). */
  report(height: number, dpr: number, visible: boolean): void
  close(): void
  toggleMute(): void
  setVolume(value: number): void
  next(): void
  toggleLight(): void
  toggleAudioOnly(): void
  setOpacity(value: number): void
  toggleClickThrough(): void
  /** Back to the Trio window (focus it, close the mini). */
  backToTrio(): void
}

export const MINI_READY_EVENT = 'trio-mini-ready'

export function miniWindowName(id: string): string {
  return `trio-mini-${id}`
}

export function miniUrl(id: string): string {
  return `/mini.html?m=${encodeURIComponent(id)}`
}
