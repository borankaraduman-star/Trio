import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { VoiceEngine, VoiceSnapshot } from '../../voice'
import { desktopBridge, type WatchHotkeyAction } from '../../ptt'
import { activityStore } from '../../gameActivity'
import { settingsStore } from '../../settings'
import { voicePrefsStore } from '../../lib/voicePrefs'
import { isBinding, matchesCombo } from '../../lib/hotkeys'
import { viewSizes } from '../../watching/sizes'
import { miniPlayers } from '../../watching/mini'
import { useWatch, watchStore } from '../../watching/store'
import { currentShare, runWatchAction, WATCH_ACTIONS } from '../../watching/actions'
import { effectiveWatchKeys } from '../../watching/keys'
import { isTypingTarget } from '../../ptt'
import { Theatre } from './Theatre'

/**
 * Everything the viewer side of CONTRACT-V12-WATCHING needs beside the stage:
 * the engine hook-up of the view sizes, the mini players' stream re-attaching,
 * the watching hotkeys (in-page chords, the desktop shell's global keys), the
 * automatic mini player, light watching while a game runs, a notice when a
 * share starts while Trio is in the background, and the theatre itself.
 */
export function WatchingLayer({
  engine,
  voice,
  me,
  nameOf,
  lastLine,
}: {
  engine: VoiceEngine
  voice: VoiceSnapshot
  me: number
  nameOf: (userId: number) => string
  lastLine: { id: number; name: string; text: string } | null
}) {
  const watch = useWatch()
  const voiceRef = useRef(voice)
  voiceRef.current = voice
  const nameRef = useRef(nameOf)
  nameRef.current = nameOf
  const activities = useSyncExternalStore(activityStore.subscribe, activityStore.getSnapshot)
  const inGame = (activities[me]?.activity.game ?? null) !== null

  // The sizes go to the engine; the viewer's choices cap them.
  useEffect(() => {
    viewSizes.attach(engine, (userId) => {
      const state = watchStore.getSnapshot()
      const choice = watchStore.choice(userId)
      return { light: choice.light || (state.lightInGame && state.inGame), audioOnly: choice.audioOnly }
    })
    miniPlayers.bind({ getVoice: () => voiceRef.current, nameOf: (id) => (id === me ? 'Sen' : nameRef.current(id)) })
    return () => {
      viewSizes.attach(null)
      miniPlayers.bind(null)
    }
  }, [engine, me])

  useEffect(() => {
    if (watch.inGame !== inGame) watchStore.update({ inGame })
  }, [inGame, watch.inGame])
  useEffect(() => {
    viewSizes.refresh()
  }, [watch.choices, watch.lightInGame, watch.inGame])

  // Streams changed (a new share, a renegotiation, a fresh connection): minis follow.
  const sharers = voice.remoteVideo.map((media) => `${media.userId}:${media.stream.id}`).join(',')
  const previous = useRef<Set<number>>(new Set())
  useEffect(() => {
    miniPlayers.update()
    const now = new Set(voice.remoteVideo.map((media) => media.userId))
    for (const id of previous.current) if (!now.has(id)) viewSizes.forget(id)
    // A share that started while Trio is in the background: one quiet notice (if asked for).
    const started = [...now].filter((id) => !previous.current.has(id))
    previous.current = now
    const state = watchStore.getSnapshot()
    if (
      started.length > 0 &&
      state.notifyShare &&
      !settingsStore.getSnapshot().doNotDisturb &&
      (document.visibilityState === 'hidden' || !document.hasFocus()) &&
      typeof Notification === 'function' &&
      Notification.permission === 'granted'
    ) {
      try {
        new Notification('Trio', { body: `${started.map((id) => nameRef.current(id)).join(', ')} ekran paylaşmaya başladı`, silent: true, tag: 'trio-share' })
      } catch {
        // Not allowed here.
      }
    }
  }, [sharers, voice.speaking.join(','), voice.remoteVideo.length])

  // Left the call: close every mini window, leave the theatre.
  useEffect(() => {
    if (voice.status === 'idle') {
      miniPlayers.closeAll()
      if (watchStore.getSnapshot().theatre !== null) watchStore.update({ theatre: null })
    }
  }, [voice.status])

  // --- hotkeys ---------------------------------------------------------------------
  const bridge = desktopBridge()
  const desktop = typeof bridge?.setWatchHotkeys === 'function' && typeof bridge.onWatchHotkey === 'function'
  const prefs = useSyncExternalStore(voicePrefsStore.subscribe, voicePrefsStore.getSnapshot)
  const settings = useSyncExternalStore(settingsStore.subscribe, settingsStore.getSnapshot)
  const ptt = settings.inputMode === 'ptt' ? settings.pttKey : null
  const fire = (action: WatchHotkeyAction) => {
    if (isBinding() || voiceRef.current.status === 'idle') return
    runWatchAction(action, voiceRef.current)
  }
  const fireRef = useRef(fire)
  fireRef.current = fire

  const pageKeys = JSON.stringify(watch.pageKeys)
  useEffect(() => {
    if (desktop) return
    const keys = watchStore.getSnapshot().pageKeys
    const onKey = (event: KeyboardEvent) => {
      if (event.repeat || isBinding() || isTypingTarget(event.target)) return
      const action = WATCH_ACTIONS.find((a) => keys[a] !== null && matchesCombo(keys[a] as string, event))
      if (!action) return
      event.preventDefault()
      event.stopPropagation()
      fireRef.current(action)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [desktop, pageKeys])

  const desktopKeys = JSON.stringify(watch.desktopKeys)
  useEffect(() => {
    if (!desktop || !bridge?.setWatchHotkeys || !bridge.onWatchHotkey) return
    bridge.setWatchHotkeys(
      effectiveWatchKeys(watchStore.getSnapshot().desktopKeys, {
        ptt,
        mute: prefs.desktopHotkeys.mute,
        deafen: prefs.desktopHotkeys.deafen,
      }),
    )
    const off = bridge.onWatchHotkey((action) => {
      if (WATCH_ACTIONS.includes(action)) fireRef.current(action)
    })
    return () => {
      off()
      bridge.setWatchHotkeys?.({})
    }
  }, [desktop, desktopKeys, ptt, prefs.desktopHotkeys.mute, prefs.desktopHotkeys.deafen])

  // --- the automatic mini player ---------------------------------------------------
  const autoOpen = useRef(false)
  useEffect(() => {
    if (!watch.autoMini) return
    const openAuto = () => {
      const share = currentShare(voiceRef.current)
      if (share === null || miniPlayers.isOpen(share)) return
      autoOpen.current = true
      void miniPlayers.show(share, { auto: true })
    }
    const back = () => {
      if (!autoOpen.current) return
      autoOpen.current = false
      miniPlayers.closeAll(true)
    }
    const offs: (() => void)[] = []
    if (bridge?.onWindowState) {
      offs.push(
        bridge.onWindowState((state) => {
          if (state.minimized || state.hiddenToTray || state.fullscreenAppInFront === true) openAuto()
          else if (state.focused) back()
        }),
      )
    } else {
      // A browser opens Document Picture-in-Picture by itself when the tab is
      // left, if it lets the page ask (Chromium, for pages using the microphone).
      const session = (navigator as Navigator & { mediaSession?: MediaSession }).mediaSession
      try {
        session?.setActionHandler('enterpictureinpicture' as MediaSessionAction, () => openAuto())
        offs.push(() => {
          try {
            session?.setActionHandler('enterpictureinpicture' as MediaSessionAction, null)
          } catch {
            // ignore
          }
        })
      } catch {
        // Not supported by this browser: the mini player opens only by hand.
      }
      const onVisible = () => {
        if (document.visibilityState === 'visible') back()
      }
      document.addEventListener('visibilitychange', onVisible)
      offs.push(() => document.removeEventListener('visibilitychange', onVisible))
    }
    return () => {
      for (const off of offs) off()
    }
  }, [watch.autoMini])

  if (watch.theatre === null || voice.status === 'idle') return null
  const screens = voice.remoteVideo.filter((media) => voice.hiddenScreens[media.userId] === undefined)
  if (screens.length === 0) return null
  return (
    <Theatre
      screens={screens}
      nameOf={nameOf}
      speaking={voice.speaking.map((id) => (id === me ? 'Sen' : nameOf(id)))}
      lastLine={lastLine}
    />
  )
}
