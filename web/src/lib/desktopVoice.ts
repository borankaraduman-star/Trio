/**
 * The desktop bridge's V6 additions (CONTRACT-V6-VOICE §5), each optional:
 * an older desktop app has none of them and the page simply goes without.
 *
 *     setHotkeys({mute?: code | null, deafen?: code | null}): void
 *     onHotkey(cb: (action: 'mute' | 'deafen') => void): () => void
 *     setVoiceState({inVoice, muted, deafened}): void     // the tray icon
 *     getSystemIdleTime(): Promise<number>                // seconds (powerMonitor)
 */
import type { HotkeyAction } from './hotkeys'

export interface DesktopVoiceBridge {
  setHotkeys?: (keys: { mute?: string | null; deafen?: string | null }) => void
  onHotkey?: (callback: (action: HotkeyAction) => void) => () => void
  setVoiceState?: (state: { inVoice: boolean; muted: boolean; deafened: boolean }) => void
  getSystemIdleTime?: () => Promise<number>
}

export function desktopVoiceBridge(): DesktopVoiceBridge | null {
  const bridge = (globalThis as { trioDesktop?: { isDesktop?: unknown } & DesktopVoiceBridge }).trioDesktop
  if (!bridge || bridge.isDesktop !== true) return null
  return bridge
}

/** The bridge can take global mute/deafen keys. */
export function desktopHotkeysSupported(): boolean {
  const bridge = desktopVoiceBridge()
  return typeof bridge?.setHotkeys === 'function' && typeof bridge.onHotkey === 'function'
}
