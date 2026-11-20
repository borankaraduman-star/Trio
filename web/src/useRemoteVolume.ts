import { useEffect, useSyncExternalStore, type RefObject } from 'react'
import { ducker } from './audio/ducking'
import { playbackMixer } from './audio/playback'
import { voicePrefsStore, volumeOf, type PersonVolume } from './lib/voicePrefs'
import { settingsStore } from './settings'

/**
 * Plays a remote stream's sound at the per-person volume (CONTRACT-V6-VOICE
 * §3): 0–100 % on the element itself, above that through `playbackMixer`
 * with the element muted (see audio/playback.ts). Deafen silences both.
 * `silent` elements (local previews, cameras) are left alone.
 *
 * V12 (CONTRACT-V12-DUCKING): a remote screen's sound is also multiplied by
 * the ducker's factor while somebody speaks — on the path it already takes
 * (the element's volume, or the boost route's gain); the route is chosen by
 * the slider alone, so a duck never moves a stream between the two.
 */
export function useRemoteVolume(
  ref: RefObject<HTMLMediaElement | null>,
  stream: MediaStream,
  userId: number | null,
  kind: keyof PersonVolume,
  deafened: boolean,
  silent = false,
): void {
  const prefs = useSyncExternalStore(voicePrefsStore.subscribe, voicePrefsStore.getSnapshot)
  const sinkId = useSyncExternalStore(settingsStore.subscribe, () => settingsStore.getSnapshot().outputDeviceId)
  const volume = userId === null ? 1 : volumeOf(prefs, userId)[kind]
  const key = `${kind}:${userId ?? 'local'}`

  useEffect(() => {
    playbackMixer.setSink(sinkId)
  }, [sinkId])

  useEffect(() => {
    const element = ref.current
    if (!element) return
    if (silent) {
      element.muted = true
      return
    }
    element.dataset.volume = String(volume)
    const apply = (duck: number) => {
      const boosted = volume > 1 && playbackMixer.route(key, stream, volume * duck, deafened)
      element.dataset.route = boosted ? 'webaudio' : 'element'
      element.dataset.duck = String(Math.round(duck * 1000) / 1000)
      if (boosted) {
        element.muted = true
        element.volume = 1
      } else {
        playbackMixer.unroute(key)
        element.muted = deafened
        element.volume = Math.min(1, volume) * duck
      }
    }
    // Only a remote screen's sound ducks; a voice never does.
    if (kind === 'stream' && userId !== null) return ducker.add('share', apply)
    apply(1)
  }, [ref, stream, key, kind, userId, volume, deafened, silent])

  useEffect(() => () => playbackMixer.unroute(key), [key])
}
