/**
 * The voice-evening preferences (CONTRACT-V6-VOICE): share profile and
 * quality, per-person volumes, the input gate, auto-AFK, and the shortcuts.
 *
 * Kept apart from `trio.settings` (settings.ts) in `localStorage`
 * `trio.voice6`, read through `validateVoicePrefs` which repairs field by
 * field and never throws. All of it is local to this device.
 */
import { DEFAULT_PAGE_SHORTCUTS, desktopKey, parseCombo, type HotkeyAction } from './hotkeys'
import { isShareProfile, isShareQuality, type ShareProfile, type ShareQuality } from './shareProfiles'

export const VOICE_PREFS_KEY = 'trio.voice6'

/** 0 = silent, 1 = as sent, 2 = +100 %. */
export const MAX_VOLUME = 2

export interface PersonVolume {
  /** Their microphone. */
  voice: number
  /** The sound of their shared screen. */
  stream: number
}

export const DEFAULT_VOLUME: PersonVolume = { voice: 1, stream: 1 }

/** The threshold bar's range, in dBFS of the post-RNNoise level. */
export const GATE_MIN_DB = -80
export const GATE_MAX_DB = -10
export const GATE_DEFAULT_DB = -50

export interface VoicePrefs {
  shareProfile: ShareProfile
  shareQuality: ShareQuality
  /** By user id (as a string key, JSON-friendly). Missing = DEFAULT_VOLUME. */
  volumes: Record<string, PersonVolume>
  /** "Otomatik": no gate (the v2 behaviour). */
  gateAuto: boolean
  gateThresholdDb: number
  afkEnabled: boolean
  /** Desktop app: global single keys (null = none). */
  desktopHotkeys: Record<HotkeyAction, string | null>
  /** Browser: in-page chords (null = off). */
  pageShortcuts: Record<HotkeyAction, string | null>
}

export const DEFAULT_VOICE_PREFS: VoicePrefs = {
  shareProfile: 'film',
  shareQuality: 'mid',
  volumes: {},
  gateAuto: true,
  gateThresholdDb: GATE_DEFAULT_DB,
  afkEnabled: true,
  desktopHotkeys: { mute: null, deafen: null },
  pageShortcuts: { ...DEFAULT_PAGE_SHORTCUTS },
}

export function clampVolume(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.min(MAX_VOLUME, Math.max(0, Math.round(value * 100) / 100))
}

const MAX_PEOPLE = 200

export function validateVoicePrefs(raw: unknown): VoicePrefs {
  const result: VoicePrefs = {
    ...DEFAULT_VOICE_PREFS,
    volumes: {},
    desktopHotkeys: { ...DEFAULT_VOICE_PREFS.desktopHotkeys },
    pageShortcuts: { ...DEFAULT_VOICE_PREFS.pageShortcuts },
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return result
  const record = raw as Record<string, unknown>
  if (isShareProfile(record.shareProfile)) result.shareProfile = record.shareProfile
  if (isShareQuality(record.shareQuality)) result.shareQuality = record.shareQuality
  if (typeof record.volumes === 'object' && record.volumes !== null && !Array.isArray(record.volumes)) {
    let count = 0
    for (const [key, value] of Object.entries(record.volumes as Record<string, unknown>)) {
      if (!/^[1-9][0-9]{0,9}$/.test(key) || typeof value !== 'object' || value === null) continue
      const voice = clampVolume((value as { voice?: unknown }).voice) ?? 1
      const stream = clampVolume((value as { stream?: unknown }).stream) ?? 1
      if (voice === 1 && stream === 1) continue
      result.volumes[key] = { voice, stream }
      if (++count >= MAX_PEOPLE) break
    }
  }
  if (typeof record.gateAuto === 'boolean') result.gateAuto = record.gateAuto
  if (typeof record.gateThresholdDb === 'number' && Number.isFinite(record.gateThresholdDb)) {
    result.gateThresholdDb = Math.min(GATE_MAX_DB, Math.max(GATE_MIN_DB, Math.round(record.gateThresholdDb)))
  }
  if (typeof record.afkEnabled === 'boolean') result.afkEnabled = record.afkEnabled
  const desktop = record.desktopHotkeys as Record<string, unknown> | undefined
  if (typeof desktop === 'object' && desktop !== null) {
    result.desktopHotkeys = { mute: desktopKey(desktop.mute), deafen: desktopKey(desktop.deafen) }
    if (result.desktopHotkeys.mute !== null && result.desktopHotkeys.mute === result.desktopHotkeys.deafen) {
      result.desktopHotkeys.deafen = null
    }
  }
  const page = record.pageShortcuts as Record<string, unknown> | undefined
  if (typeof page === 'object' && page !== null) {
    for (const action of ['mute', 'deafen'] as const) {
      const value = page[action]
      if (value === null) result.pageShortcuts[action] = null
      else if (parseCombo(value)) result.pageShortcuts[action] = value as string
    }
  }
  return result
}

export function volumeOf(prefs: VoicePrefs, userId: number): PersonVolume {
  return prefs.volumes[String(userId)] ?? DEFAULT_VOLUME
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export class VoicePrefsStore {
  private value: VoicePrefs
  private readonly listeners = new Set<() => void>()

  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage()) {
    this.value = VoicePrefsStore.load(storage)
  }

  static load(storage: Pick<Storage, 'getItem'> | null): VoicePrefs {
    try {
      const text = storage?.getItem(VOICE_PREFS_KEY) ?? null
      return validateVoicePrefs(text === null ? null : JSON.parse(text))
    } catch {
      return validateVoicePrefs(null)
    }
  }

  getSnapshot = (): VoicePrefs => this.value

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  update(patch: Partial<VoicePrefs>): void {
    const next = validateVoicePrefs({ ...this.value, ...patch })
    if (JSON.stringify(next) === JSON.stringify(this.value)) return
    this.value = next
    try {
      this.storage?.setItem(VOICE_PREFS_KEY, JSON.stringify(next))
    } catch {
      // Private mode: kept until the tab closes.
    }
    for (const listener of [...this.listeners]) listener()
  }

  setVolume(userId: number, kind: keyof PersonVolume, value: number): void {
    const current = volumeOf(this.value, userId)
    this.update({ volumes: { ...this.value.volumes, [String(userId)]: { ...current, [kind]: value } } })
  }

  resetVolume(userId: number): void {
    const volumes = { ...this.value.volumes }
    delete volumes[String(userId)]
    this.update({ volumes })
  }

  resetAllVolumes(): void {
    this.update({ volumes: {} })
  }
}

export const voicePrefsStore = new VoicePrefsStore()
