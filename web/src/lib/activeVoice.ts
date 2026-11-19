import { useSyncExternalStore } from 'react'
import type { VoiceEngine } from '../voice'

/**
 * The session's voice engine, for the V6 settings sections (the level bar of
 * "Giriş hassasiyeti") without threading it through SettingsDialog's props.
 */
let current: VoiceEngine | null = null
const listeners = new Set<() => void>()

export function setActiveEngine(engine: VoiceEngine | null): void {
  if (current === engine) return
  current = engine
  for (const listener of [...listeners]) listener()
}

export function useActiveEngine(): VoiceEngine | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => current,
  )
}
