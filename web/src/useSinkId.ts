import { useEffect, useSyncExternalStore, type RefObject } from 'react'
import { sinkIdSupported } from './lib/devices'
import { settingsStore } from './settings'

type SinkElement = HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> }

/**
 * Plays a remote media element on the output device chosen in the settings
 * (`setSinkId`, where the browser has it). A device that cannot be used falls
 * back to the default one.
 */
export function useSinkId(ref: RefObject<HTMLMediaElement | null>, active = true): void {
  const outputDeviceId = useSyncExternalStore(
    settingsStore.subscribe,
    () => settingsStore.getSnapshot().outputDeviceId,
  )
  useEffect(() => {
    const element = ref.current as SinkElement | null
    if (!active || !element || !sinkIdSupported() || typeof element.setSinkId !== 'function') return
    if (element.sinkId === outputDeviceId) return
    element.setSinkId(outputDeviceId).catch((error: unknown) => {
      console.warn('trio: could not use the chosen output device', error)
      if (outputDeviceId !== '') void element.setSinkId?.('').catch(() => undefined)
    })
  })
}
