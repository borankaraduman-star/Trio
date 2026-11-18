import { useEffect } from 'react'
import { attachPtt, desktopBridge, PttGate } from './ptt'
import type { InputMode } from './settings'

/**
 * Push-to-talk for this page: in `ptt` mode the gate follows the key (the
 * in-page listener and, in the desktop app, the global hook as well); in
 * `activity` mode the gate is simply open. The desktop bridge is told the key
 * on startup and on every change, and `null` when PTT mode is left (each page
 * load resets it in the main process).
 */
export function usePtt(mode: InputMode, key: string, setOpen: (open: boolean) => void): void {
  useEffect(() => {
    if (mode !== 'ptt') {
      setOpen(true)
      return
    }
    const gate = new PttGate(setOpen)
    setOpen(false)
    return attachPtt(gate, key, { window, document, bridge: desktopBridge() })
  }, [mode, key, setOpen])

  // Leaving PTT mode in the desktop app: the main process must stop listening.
  useEffect(() => {
    if (mode === 'ptt') return
    try {
      desktopBridge()?.setPttKey(null)
    } catch {
      // No bridge.
    }
  }, [mode])
}
