import { useEffect, useSyncExternalStore, type RefObject } from 'react'
import { playbackMixer } from './audio/playback'
import { voicePrefsStore, volumeOf, type PersonVolume } from './lib/voicePrefs'
import { settingsStore } from './settings'

/**
 * Plays a remote stream's sound at the per-person volume (CONTRACT-V6-VOICE
 * §3): 0–100 % on the element itself, above that through `playbackMixer`
 * with the element muted (see audio/playback.ts). Deafen silences both.
 * `silent` elements (local previews, cameras) are left alone.
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
    const boosted = volume > 1 && playbackMixer.route(key, stream, volume, deafened)
    element.dataset.volume = String(volume)
    element.dataset.route = boosted ? 'webaudio' : 'element'
    if (boosted) {
      element.muted = true
      element.volume = 1
    } else {
      playbackMixer.unroute(key)
      element.muted = deafened
      element.volume = Math.min(1, volume)
    }
  }, [ref, stream, key, volume, deafened, silent])

  useEffect(() => () => playbackMixer.unroute(key), [key])
}
