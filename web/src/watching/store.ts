/**
 * CONTRACT-V12-WATCHING: what the VIEWER of shared screens chose, per device.
 *
 * - the stage's layout (`side` | `focus`), the share in focus and the pinned one;
 * - per sharer (remembered by user id): "Hafif izleme" and "Sadece ses";
 * - the theatre (one share filling the Trio window) and the mini windows open;
 * - settings: the automatic mini player, its opacity, light watching while a
 *   game runs, the stats line, a notice when a share starts.
 *
 * A tiny external store (useSyncExternalStore), localStorage for what is
 * remembered; everything here is local and nothing is sent except through
 * `sizes.ts` (the `watch.size` the sharer encodes for).
 */
import { useSyncExternalStore } from 'react'
import type { StageMode } from '../lib/multishare'

export interface ShareChoice {
  /** "Hafif izleme": a small, low-frame-rate picture for me (watch.size `thumb` at most). */
  light: boolean
  /** "Sadece ses": the share's sound, no picture (watch.size `audio`). */
  audioOnly: boolean
}

export interface WatchSettings {
  /** "Trio arka plandayken paylaşılan ekranı küçük pencerede göster". */
  autoMini: boolean
  /** The mini window's opacity, 0.4–1 (desktop app). */
  miniOpacity: number
  /** "Oyun açıkken hafif izle": every share light while my game status says I am playing. */
  lightInGame: boolean
  /** The receiving line (resolution, frames, bitrate) under each share. */
  stats: boolean
  /** A system notification when somebody starts sharing while Trio is in the background. */
  notifyShare: boolean
}

export interface WatchState extends WatchSettings {
  stageMode: StageMode
  /** Odak: the share (sharer id) shown large; null = the pinned one, else the first. */
  focus: number | null
  /** "Bu paylaşımı sabitle": always first, and the large one in Odak. */
  pinned: number | null
  /** Sinema modu: the sharer whose screen fills the window (null = off). */
  theatre: number | null
  /** Sinema modu with two shares side by side. */
  theatrePair: boolean
  /** Sharers whose screen is open in a mini window (`trio-mini-<id>`). */
  minis: readonly number[]
  choices: Readonly<Record<number, ShareChoice>>
  /** True while my own game status says I am playing (set by the session). */
  inGame: boolean
}

const KEY = 'trio.v12.watch'

export const DEFAULT_WATCH_SETTINGS: WatchSettings = {
  autoMini: false,
  miniOpacity: 1,
  lightInGame: false,
  stats: false,
  notifyShare: false,
}

const NO_CHOICE: ShareChoice = { light: false, audioOnly: false }

function load(): WatchState {
  const state: WatchState = {
    ...DEFAULT_WATCH_SETTINGS,
    stageMode: 'side',
    focus: null,
    pinned: null,
    theatre: null,
    theatrePair: false,
    minis: [],
    choices: {},
    inGame: false,
  }
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Record<string, unknown> | null
    if (!raw || typeof raw !== 'object') return state
    if (raw.stageMode === 'focus') state.stageMode = 'focus'
    for (const key of ['autoMini', 'lightInGame', 'stats', 'notifyShare'] as const) {
      if (typeof raw[key] === 'boolean') state[key] = raw[key] as boolean
    }
    if (typeof raw.miniOpacity === 'number' && raw.miniOpacity >= 0.4 && raw.miniOpacity <= 1) state.miniOpacity = raw.miniOpacity
    if (typeof raw.pinned === 'number' && Number.isInteger(raw.pinned)) state.pinned = raw.pinned
    const choices: Record<number, ShareChoice> = {}
    if (raw.choices && typeof raw.choices === 'object') {
      for (const [id, value] of Object.entries(raw.choices as Record<string, unknown>)) {
        const v = value as Partial<ShareChoice> | null
        if (!Number.isInteger(Number(id)) || !v || typeof v !== 'object') continue
        choices[Number(id)] = { light: v.light === true, audioOnly: v.audioOnly === true }
      }
    }
    state.choices = choices
  } catch {
    // Unreadable or private mode: the defaults.
  }
  return state
}

class WatchStore {
  private state: WatchState = load()
  private readonly listeners = new Set<() => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): WatchState => this.state

  update(patch: Partial<WatchState>): void {
    this.state = { ...this.state, ...patch }
    this.save()
    for (const listener of this.listeners) listener()
  }

  choice(userId: number): ShareChoice {
    return this.state.choices[userId] ?? NO_CHOICE
  }

  setChoice(userId: number, patch: Partial<ShareChoice>): void {
    const next = { ...this.choice(userId), ...patch }
    // "Sadece ses" and "Hafif" are two steps of one scale: choosing one clears the other.
    if (patch.audioOnly === true) next.light = false
    if (patch.light === true) next.audioOnly = false
    const choices = { ...this.state.choices }
    if (!next.light && !next.audioOnly) delete choices[userId]
    else choices[userId] = next
    this.update({ choices })
  }

  setMini(userId: number, open: boolean): void {
    const has = this.state.minis.includes(userId)
    if (has === open) return
    this.update({ minis: open ? [...this.state.minis, userId] : this.state.minis.filter((id) => id !== userId) })
  }

  /** For tests. */
  reset(): void {
    try {
      localStorage.removeItem(KEY)
    } catch {
      // ignore
    }
    this.state = load()
    for (const listener of this.listeners) listener()
  }

  private save(): void {
    const s = this.state
    try {
      localStorage.setItem(
        KEY,
        JSON.stringify({
          stageMode: s.stageMode,
          pinned: s.pinned,
          choices: s.choices,
          autoMini: s.autoMini,
          miniOpacity: s.miniOpacity,
          lightInGame: s.lightInGame,
          stats: s.stats,
          notifyShare: s.notifyShare,
        }),
      )
    } catch {
      // Not remembered.
    }
  }
}

export const watchStore = new WatchStore()

export function useWatch(): WatchState {
  return useSyncExternalStore(watchStore.subscribe, watchStore.getSnapshot)
}

/**
 * The screens in the order the viewer moves through them (arrows, number
 * keys, "next share"): the pinned one first, then by sharer id.
 */
export function shareOrder(sharerIds: readonly number[], pinned: number | null): number[] {
  const sorted = [...sharerIds].sort((a, b) => a - b)
  if (pinned !== null && sorted.includes(pinned)) return [pinned, ...sorted.filter((id) => id !== pinned)]
  return sorted
}

/** The share after `current` in `order` (wrapping), or the first. */
export function nextShare(order: readonly number[], current: number | null, step = 1): number | null {
  if (order.length === 0) return null
  const at = current === null ? -1 : order.indexOf(current)
  if (at === -1) return order[step > 0 ? 0 : order.length - 1]
  return order[(at + step + order.length) % order.length]
}

/** The share shown large in Odak / Sinema: the chosen one, else the pinned one, else the first. */
export function focusedShare(order: readonly number[], focus: number | null, pinned: number | null): number | null {
  if (focus !== null && order.includes(focus)) return focus
  if (pinned !== null && order.includes(pinned)) return pinned
  return order[0] ?? null
}
