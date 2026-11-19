/**
 * CONTRACT-V8-MUSIC §4–5, kept on this device in `localStorage` `trio.music8`:
 * per sharer, my music volume (0–100 %, default 50 %) and mute — apart from
 * that person's voice volume (`trio.voice6`) — and whether my own share sends
 * the title ("Şarkı adını göster", default on).
 *
 * The music volume is the element's own `volume`, never above 100 % and so
 * never through the Web Audio boost path (audio/playback.ts): a person's
 * voice boost does not touch their music, and music never needs one (it
 * arrives at full scale).
 */
import type { NowPlaying } from './capture'

export const MUSIC_PREFS_KEY = 'trio.music8'
export const DEFAULT_MUSIC_VOLUME = 0.5

export interface MusicVolume {
  volume: number
  muted: boolean
}

export interface MusicPrefs {
  volumes: Record<string, MusicVolume>
  showTitle: boolean
}

export const DEFAULT_MUSIC: MusicVolume = { volume: DEFAULT_MUSIC_VOLUME, muted: false }

const MAX_PEOPLE = 200

function clamp(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.min(1, Math.max(0, Math.round(value * 100) / 100))
}

export function validateMusicPrefs(raw: unknown): MusicPrefs {
  const result: MusicPrefs = { volumes: {}, showTitle: true }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return result
  const record = raw as Record<string, unknown>
  if (typeof record.showTitle === 'boolean') result.showTitle = record.showTitle
  const volumes = record.volumes
  if (typeof volumes === 'object' && volumes !== null && !Array.isArray(volumes)) {
    let count = 0
    for (const [key, value] of Object.entries(volumes as Record<string, unknown>)) {
      if (!/^[1-9][0-9]{0,9}$/.test(key) || typeof value !== 'object' || value === null) continue
      const volume = clamp((value as { volume?: unknown }).volume) ?? DEFAULT_MUSIC_VOLUME
      const muted = (value as { muted?: unknown }).muted === true
      if (volume === DEFAULT_MUSIC_VOLUME && !muted) continue
      result.volumes[key] = { volume, muted }
      if (++count >= MAX_PEOPLE) break
    }
  }
  return result
}

export function musicOf(prefs: MusicPrefs, userId: number): MusicVolume {
  return prefs.volumes[String(userId)] ?? DEFAULT_MUSIC
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export class MusicPrefsStore {
  private value: MusicPrefs
  private readonly listeners = new Set<() => void>()

  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage()) {
    let raw: unknown = null
    try {
      const text = storage?.getItem(MUSIC_PREFS_KEY) ?? null
      raw = text === null ? null : JSON.parse(text)
    } catch {
      raw = null
    }
    this.value = validateMusicPrefs(raw)
  }

  getSnapshot = (): MusicPrefs => this.value

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private update(next: MusicPrefs): void {
    const valid = validateMusicPrefs(next)
    if (JSON.stringify(valid) === JSON.stringify(this.value)) return
    this.value = valid
    try {
      this.storage?.setItem(MUSIC_PREFS_KEY, JSON.stringify(valid))
    } catch {
      // Private mode: kept until the tab closes.
    }
    for (const listener of [...this.listeners]) listener()
  }

  setVolume(userId: number, volume: number): void {
    const current = musicOf(this.value, userId)
    this.update({ ...this.value, volumes: { ...this.value.volumes, [String(userId)]: { ...current, volume } } })
  }

  setMuted(userId: number, muted: boolean): void {
    const current = musicOf(this.value, userId)
    this.update({ ...this.value, volumes: { ...this.value.volumes, [String(userId)]: { ...current, muted } } })
  }

  setShowTitle(showTitle: boolean): void {
    this.update({ ...this.value, showTitle })
  }
}

export const musicPrefsStore = new MusicPrefsStore()

/** What a listener's element plays: deafen and the music mute both silence it. */
export function musicElementState(prefs: MusicPrefs, userId: number, deafened: boolean): { volume: number; muted: boolean } {
  const music = musicOf(prefs, userId)
  return { volume: music.volume, muted: deafened || music.muted }
}

/** The title as it may go on the wire: one line, at most 120 characters, or null. */
export function cleanTitle(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, ' ')
  const line = text.replace(/\s+/g, ' ').trim()
  return line === '' ? null : line.slice(0, 120).trim()
}

/** "Artist — Title" from the desktop app's now-playing report. */
export function nowPlayingTitle(info: NowPlaying | null): string | null {
  if (!info) return null
  const title = cleanTitle(info.title)
  if (!title) return null
  const artist = cleanTitle(info.artist)
  return cleanTitle(artist && !title.includes(artist) ? `${artist} — ${title}` : title)
}

