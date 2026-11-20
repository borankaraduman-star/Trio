/**
 * CONTRACT-V12-WATCHING §7: what a watching hotkey (or a menu item) does.
 * "The share" an action means is the one in the theatre, else the one in a
 * mini window, else the one in focus (Odak), else the pinned one, else the
 * first.
 */
import type { WatchHotkeyAction } from '../ptt'
import type { VoiceSnapshot } from '../voice'
import { changeShareVolume, miniPlayers, toggleShareMute } from './mini'
import { focusedShare, nextShare, shareOrder, watchStore } from './store'

export const SHARE_VOLUME_STEP = 0.1

export function watchedShares(voice: VoiceSnapshot): number[] {
  return shareOrder(
    voice.remoteVideo.filter((media) => voice.hiddenScreens[media.userId] === undefined).map((media) => media.userId),
    watchStore.getSnapshot().pinned,
  )
}

export function currentShare(voice: VoiceSnapshot): number | null {
  const order = watchedShares(voice)
  const state = watchStore.getSnapshot()
  if (state.theatre !== null && order.includes(state.theatre)) return state.theatre
  const mini = miniPlayers.openIds().find((id) => order.includes(id))
  if (mini !== undefined) return mini
  return focusedShare(order, state.focus, state.pinned)
}

export function runWatchAction(action: WatchHotkeyAction, voice: VoiceSnapshot): void {
  const order = watchedShares(voice)
  const share = currentShare(voice)
  const state = watchStore.getSnapshot()
  switch (action) {
    case 'toggleMini':
      if (miniPlayers.openIds().length > 0) miniPlayers.closeAll()
      else if (share !== null) void miniPlayers.show(share)
      return
    case 'nextShare': {
      const next = nextShare(order, share)
      if (next === null) return
      if (state.theatre !== null) watchStore.update({ theatre: next, focus: next })
      else watchStore.update({ focus: next, stageMode: order.length > 1 ? 'focus' : state.stageMode })
      return
    }
    case 'clickThrough':
      // The desktop shell toggles it itself (CONTRACT-V12-MINI-DESKTOP §3) and
      // tells the page only so it can show it: `onState` brings the result.
      return
    case 'muteShare':
      if (share !== null) toggleShareMute(share)
      return
    case 'shareVolumeUp':
      if (share !== null) changeShareVolume(share, SHARE_VOLUME_STEP)
      return
    case 'shareVolumeDown':
      if (share !== null) changeShareVolume(share, -SHARE_VOLUME_STEP)
      return
    case 'theatre':
      watchStore.update({ theatre: state.theatre !== null ? null : share })
      return
  }
}

export const WATCH_ACTIONS: readonly WatchHotkeyAction[] = [
  'toggleMini',
  'nextShare',
  'clickThrough',
  'muteShare',
  'shareVolumeUp',
  'shareVolumeDown',
  'theatre',
]

export const WATCH_ACTION_LABELS: Record<WatchHotkeyAction, string> = {
  toggleMini: 'Mini oynatıcıyı aç / kapat',
  nextShare: 'Sıradaki paylaşım',
  clickThrough: 'Mini oynatıcı: tıklamalar oyuna geçsin (aç / kapat)',
  muteShare: 'Yayın sesini kapat / aç',
  shareVolumeUp: 'Yayın sesini artır',
  shareVolumeDown: 'Yayın sesini azalt',
  theatre: 'Sinema modu',
}
