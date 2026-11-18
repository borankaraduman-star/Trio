/**
 * What a screen share asks the browser for (review finding 9).
 *
 * Sharing the screen WITH its sound sends the friends their own voices back:
 * system audio (the desktop app grants Windows loopback) includes Trio's own
 * playback of the call. So the sound is an explicit choice, off by default
 * (setting "Ekran sesini de paylaş"), and when it is on:
 *
 * - `restrictOwnAudio: true` asks the browser to leave out the audio this
 *   document itself plays (the call). Chromium ≥ 141 lists the constraint
 *   (157 here does), but it is only honoured where the capture source
 *   supports it — the fake capture in the e2e reports `restrictOwnAudio:
 *   [false]` — and whether a real Windows loopback capture honours it has
 *   NOT been verified. It is a plain (ideal) constraint, so where it is not
 *   supported nothing fails; it is only sent where `getSupportedConstraints`
 *   lists it.
 * - `systemAudio: 'include'` offers whole-screen audio in the picker.
 *
 * `suppressLocalAudioPlayback` is deliberately not used: it mutes a captured
 * TAB's sound for the sharer, which is not this problem.
 * `selfBrowserSurface: 'exclude'` keeps Trio's own tab out of the picker
 * (sharing it shows the call to itself).
 */
export function displayMediaOptions(
  withAudio: boolean,
  supported: MediaTrackSupportedConstraints & { restrictOwnAudio?: boolean },
): DisplayMediaStreamOptions {
  const audio: MediaTrackConstraints | boolean = withAudio
    ? supported.restrictOwnAudio
      ? ({ restrictOwnAudio: true } as MediaTrackConstraints)
      : true
    : false
  return {
    video: true,
    audio,
    ...(withAudio ? { systemAudio: 'include' } : {}),
    selfBrowserSurface: 'exclude',
  } as DisplayMediaStreamOptions
}

/** The setting's one-line warning. */
export const SCREEN_AUDIO_WARNING =
  'Hoparlörden gelen sesler (arkadaşlarının sesi dahil) onlara geri gidebilir; kulaklık kullan.'
