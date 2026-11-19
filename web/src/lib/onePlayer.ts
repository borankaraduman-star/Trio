/** One voice message plays at a time: starting one pauses the one before. */
let playing: HTMLMediaElement | null = null

export function claimPlayback(element: HTMLMediaElement): void {
  if (playing && playing !== element && !playing.paused) playing.pause()
  playing = element
}

export function releasePlayback(element: HTMLMediaElement): void {
  if (playing === element) playing = null
}
