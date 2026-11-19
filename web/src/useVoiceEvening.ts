import { useEffect, useRef, useSyncExternalStore } from 'react'
import { dbToLinear } from './audio/gateCore'
import { AFK_TIMEOUT_MS, AfkMachine } from './lib/afk'
import { desktopVoiceBridge } from './lib/desktopVoice'
import { hotkeyConflict, isBinding, matchesCombo, type HotkeyAction } from './lib/hotkeys'
import { voicePrefsStore } from './lib/voicePrefs'
import { setActiveEngine } from './lib/activeVoice'
import type { VoiceEngine } from './voice'

/** Speech for AFK purposes: a peak over this (before the gate and the mute), or over the gate's threshold. */
const SPEECH_PEAK = 0.05
const AFK_TICK_MS = 1000
/** Desktop: the system counts as in use when its idle time is below this. */
const SYSTEM_ACTIVE_S = 30
const SYSTEM_POLL_MS = 5000
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const

/**
 * The voice-evening wiring of one session (CONTRACT-V6-VOICE §4–5): the input
 * gate follows the setting, auto-AFK watches for somebody being there, and
 * the mute/deafen shortcuts (in-page chords in the browser, global keys in the
 * desktop app) toggle through `toggle` — the same path as a click, cue sound
 * included. The tray icon follows mute and deafen.
 */
export function useVoiceEvening({
  engine,
  toggle,
  pttKey,
}: {
  engine: VoiceEngine
  toggle: (action: HotkeyAction) => void
  /** The PTT key while in push-to-talk mode, else null (a hotkey may not be it). */
  pttKey: string | null
}): void {
  const prefs = useSyncExternalStore(voicePrefsStore.subscribe, voicePrefsStore.getSnapshot)
  const voice = useSyncExternalStore(engine.subscribe, engine.getSnapshot)
  const toggleRef = useRef(toggle)
  toggleRef.current = toggle
  const inVoice = voice.status !== 'idle'

  useEffect(() => {
    setActiveEngine(engine)
    return () => setActiveEngine(null)
  }, [engine])

  // --- the input gate ---------------------------------------------------------
  const gate = prefs.gateAuto ? null : dbToLinear(prefs.gateThresholdDb)
  useEffect(() => {
    if (inVoice) void engine.setGate(gate)
  }, [engine, gate, inVoice])

  // --- auto-AFK ------------------------------------------------------------------
  const afkRef = useRef<AfkMachine | null>(null)
  const expectedMute = useRef<boolean | null>(null)
  useEffect(() => {
    if (!inVoice) return
    const timeout = (globalThis as { __trioAfkMs?: number }).__trioAfkMs ?? AFK_TIMEOUT_MS
    const muted = () => engine.getSnapshot().muted
    const machine = new AfkMachine(
      {
        setAfk: (afk) => engine.setAfk(afk),
        setMuted: (value) => {
          if (engine.getSnapshot().muted === value) return
          expectedMute.current = value
          toggleRef.current('mute')
        },
      },
      Date.now(),
      timeout,
    )
    machine.setEnabled(voicePrefsStore.getSnapshot().afkEnabled, Date.now(), muted())
    afkRef.current = machine
    const onActivity = () => machine.activity(Date.now(), muted())
    for (const type of ACTIVITY_EVENTS) window.addEventListener(type, onActivity, { capture: true, passive: true })
    const bridge = desktopVoiceBridge()
    const unsubscribePtt =
      typeof (bridge as { onPtt?: unknown } | null)?.onPtt === 'function'
        ? (bridge as unknown as { onPtt: (cb: (down: boolean) => void) => () => void }).onPtt((down) => {
            if (down) onActivity()
          })
        : null
    const tick = setInterval(() => {
      const peak = engine.inputPeak()
      const threshold = voicePrefsStore.getSnapshot().gateAuto
        ? SPEECH_PEAK
        : Math.max(SPEECH_PEAK, dbToLinear(voicePrefsStore.getSnapshot().gateThresholdDb))
      if (peak !== null && peak > threshold) onActivity()
      machine.tick(Date.now(), muted())
    }, AFK_TICK_MS)
    let idlePoll: ReturnType<typeof setInterval> | null = null
    if (typeof bridge?.getSystemIdleTime === 'function') {
      const read = bridge.getSystemIdleTime
      idlePoll = setInterval(() => {
        void read()
          .then((seconds) => {
            if (typeof seconds === 'number' && seconds < SYSTEM_ACTIVE_S) onActivity()
          })
          .catch(() => undefined)
      }, SYSTEM_POLL_MS)
    }
    return () => {
      for (const type of ACTIVITY_EVENTS) window.removeEventListener(type, onActivity, { capture: true })
      clearInterval(tick)
      if (idlePoll) clearInterval(idlePoll)
      unsubscribePtt?.()
      afkRef.current = null
      engine.setAfk(false)
    }
  }, [engine, inVoice])

  useEffect(() => {
    afkRef.current?.setEnabled(prefs.afkEnabled, Date.now(), engine.getSnapshot().muted)
  }, [engine, prefs.afkEnabled])

  // A mute change that the AFK machine did not make is the user's own.
  const lastMuted = useRef(voice.muted)
  useEffect(() => {
    if (voice.muted === lastMuted.current) return
    lastMuted.current = voice.muted
    if (expectedMute.current === voice.muted) {
      expectedMute.current = null
      return
    }
    expectedMute.current = null
    afkRef.current?.manualMute()
    afkRef.current?.activity(Date.now(), voice.muted)
  }, [voice.muted])

  // --- shortcuts -----------------------------------------------------------------
  const bridge = desktopVoiceBridge()
  const desktop = typeof bridge?.setHotkeys === 'function' && typeof bridge.onHotkey === 'function'
  const fire = (action: HotkeyAction) => {
    if (isBinding()) return
    afkRef.current?.activity(Date.now(), engine.getSnapshot().muted)
    toggleRef.current(action)
  }
  const fireRef = useRef(fire)
  fireRef.current = fire

  const { mute: pageMute, deafen: pageDeafen } = prefs.pageShortcuts
  useEffect(() => {
    if (desktop) return
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat || isBinding()) return
      const action: HotkeyAction | null =
        pageMute !== null && matchesCombo(pageMute, event)
          ? 'mute'
          : pageDeafen !== null && matchesCombo(pageDeafen, event)
            ? 'deafen'
            : null
      if (!action) return
      event.preventDefault()
      event.stopPropagation()
      fireRef.current(action)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [desktop, pageMute, pageDeafen])

  const { mute: deskMute, deafen: deskDeafen } = prefs.desktopHotkeys
  useEffect(() => {
    if (!desktop || !bridge?.setHotkeys || !bridge.onHotkey) return
    // The PTT key wins: a conflicting hotkey is not registered (the settings say why).
    const ok = (key: string | null) => (key !== null && hotkeyConflict({ ptt: pttKey, mute: key, deafen: null }) === null ? key : null)
    bridge.setHotkeys({ mute: ok(deskMute), deafen: ok(deskDeafen) })
    const unsubscribe = bridge.onHotkey((action) => {
      if (action === 'mute' || action === 'deafen') fireRef.current(action)
    })
    return () => {
      unsubscribe()
      bridge.setHotkeys?.({ mute: null, deafen: null })
    }
    // `bridge` is the same object for the page's life.
  }, [desktop, deskMute, deskDeafen, pttKey])

  // --- the tray icon ---------------------------------------------------------------
  useEffect(() => {
    try {
      desktopVoiceBridge()?.setVoiceState?.({ inVoice, muted: voice.muted, deafened: voice.deafened })
    } catch {
      // The bridge went away with the window.
    }
  }, [inVoice, voice.muted, voice.deafened])
}
