/**
 * User settings (CONTRACT-V2 §4): devices, noise suppression, input mode and
 * the push-to-talk key. Stored in localStorage `trio.settings`; read through
 * `validateSettings`, which never throws and repairs anything it does not
 * understand field by field, so a bad value never costs the other settings.
 */

export type InputMode = 'activity' | 'ptt'

export interface Settings {
  version: 1
  /** '' = the system default device. */
  micDeviceId: string
  outputDeviceId: string
  cameraDeviceId: string
  /**
   * The chosen devices' names when they were chosen. A device id is not
   * stable everywhere (Chrome issues new ids on every load unless the
   * permission is a lasting one, e.g. after "allow this time"); the name is
   * how the choice is found again (`repairDeviceChoice`).
   */
  micDeviceLabel: string
  outputDeviceLabel: string
  cameraDeviceLabel: string
  noiseSuppression: boolean
  inputMode: InputMode
  /** A `KeyboardEvent.code`, or one of the mouse buttons (desktop app). */
  pttKey: string
  /** Share the screen's sound with it. Off by default: it can echo the call back (voice.ts). */
  shareScreenAudio: boolean
}

export const SETTINGS_KEY = 'trio.settings'

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  micDeviceId: '',
  outputDeviceId: '',
  cameraDeviceId: '',
  micDeviceLabel: '',
  outputDeviceLabel: '',
  cameraDeviceLabel: '',
  noiseSuppression: true,
  inputMode: 'activity',
  pttKey: 'Backquote',
  shareScreenAudio: false,
}

export const MOUSE_PTT_KEYS = ['MouseMiddle', 'MouseBack', 'MouseForward'] as const

/** A plausible `KeyboardEvent.code` ("KeyA", "F13", "Backquote") or a mouse button name. */
export function isValidPttKey(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9]{0,31}$/.test(value)
}

function deviceId(value: unknown): string | null {
  // Device ids are opaque strings; bound them so storage junk cannot grow.
  return typeof value === 'string' && value.length <= 512 ? value : null
}

/** Settings from anything (parsed JSON, null, garbage). Older or partial shapes are migrated. */
export function validateSettings(raw: unknown): Settings {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ...DEFAULT_SETTINGS }
  const record = raw as Record<string, unknown>
  const result: Settings = { ...DEFAULT_SETTINGS }

  result.micDeviceId = deviceId(record.micDeviceId) ?? DEFAULT_SETTINGS.micDeviceId
  result.outputDeviceId = deviceId(record.outputDeviceId) ?? DEFAULT_SETTINGS.outputDeviceId
  result.cameraDeviceId = deviceId(record.cameraDeviceId) ?? DEFAULT_SETTINGS.cameraDeviceId
  // A label belongs to its id: with no id there is nothing to find again.
  result.micDeviceLabel = (result.micDeviceId && deviceId(record.micDeviceLabel)) || ''
  result.outputDeviceLabel = (result.outputDeviceId && deviceId(record.outputDeviceLabel)) || ''
  result.cameraDeviceLabel = (result.cameraDeviceId && deviceId(record.cameraDeviceLabel)) || ''

  if (typeof record.noiseSuppression === 'boolean') result.noiseSuppression = record.noiseSuppression

  // Migration: early drafts stored `ptt: boolean` / `inputMode: 'voice'`.
  const mode = record.inputMode
  if (mode === 'activity' || mode === 'ptt') result.inputMode = mode
  else if (mode === 'voice') result.inputMode = 'activity'
  else if (typeof record.ptt === 'boolean') result.inputMode = record.ptt ? 'ptt' : 'activity'

  if (isValidPttKey(record.pttKey)) result.pttKey = record.pttKey
  if (typeof record.shareScreenAudio === 'boolean') result.shareScreenAudio = record.shareScreenAudio

  return result
}

export function loadSettings(storage: Pick<Storage, 'getItem'> | null = safeStorage()): Settings {
  if (!storage) return { ...DEFAULT_SETTINGS }
  try {
    const text = storage.getItem(SETTINGS_KEY)
    return validateSettings(text === null ? null : JSON.parse(text))
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(
  settings: Settings,
  storage: Pick<Storage, 'setItem'> | null = safeStorage(),
): void {
  try {
    storage?.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    // Private mode: settings last until the tab closes.
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** A tiny observable around the settings, shared by the dialog, the voice engine and PTT. */
export class SettingsStore {
  private value: Settings
  private readonly listeners = new Set<() => void>()

  constructor(initial: Settings = loadSettings()) {
    this.value = initial
  }

  getSnapshot = (): Settings => this.value

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  update(patch: Partial<Omit<Settings, 'version'>>): void {
    const next = validateSettings({ ...this.value, ...patch })
    if ((Object.keys(next) as (keyof Settings)[]).every((key) => next[key] === this.value[key])) return
    this.value = next
    saveSettings(next)
    for (const listener of [...this.listeners]) listener()
  }
}

/** One store per page: Session, the dialog and the media elements read the same settings. */
export const settingsStore = new SettingsStore()

// --- key names ----------------------------------------------------------------

const NAMED_KEYS: Record<string, string> = {
  Backquote: '` (Backquote)',
  Space: 'Boşluk',
  Enter: 'Enter',
  Tab: 'Tab',
  Escape: 'Esc',
  Backspace: 'Backspace',
  CapsLock: 'Caps Lock',
  ShiftLeft: 'Sol Shift',
  ShiftRight: 'Sağ Shift',
  ControlLeft: 'Sol Ctrl',
  ControlRight: 'Sağ Ctrl',
  AltLeft: 'Sol Alt',
  AltRight: 'Sağ Alt (AltGr)',
  MetaLeft: 'Sol Win/Cmd',
  MetaRight: 'Sağ Win/Cmd',
  ContextMenu: 'Menü',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  IntlBackslash: '< (ISO)',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  ArrowUp: 'Yukarı ok',
  ArrowDown: 'Aşağı ok',
  ArrowLeft: 'Sol ok',
  ArrowRight: 'Sağ ok',
  Insert: 'Insert',
  Delete: 'Delete',
  Home: 'Home',
  End: 'End',
  PageUp: 'Page Up',
  PageDown: 'Page Down',
  ScrollLock: 'Scroll Lock',
  Pause: 'Pause',
  PrintScreen: 'Print Screen',
  NumLock: 'Num Lock',
  MouseMiddle: 'Fare orta tuşu',
  MouseBack: 'Fare geri tuşu',
  MouseForward: 'Fare ileri tuşu',
}

/** A readable name for a `KeyboardEvent.code` ("KeyA" → "A", "Numpad5" → "Num 5"). */
export function keyLabel(code: string): string {
  if (code in NAMED_KEYS) return NAMED_KEYS[code]
  let match = /^Key([A-Z])$/.exec(code)
  if (match) return match[1]
  match = /^Digit([0-9])$/.exec(code)
  if (match) return match[1]
  match = /^Numpad(.+)$/.exec(code)
  if (match) {
    const names: Record<string, string> = {
      Add: '+',
      Subtract: '-',
      Multiply: '*',
      Divide: '/',
      Decimal: ',',
      Enter: 'Enter',
    }
    return `Num ${names[match[1]] ?? match[1]}`
  }
  if (/^F[0-9]{1,2}$/.test(code)) return code
  return code
}

/** Codes that must not become the PTT key (they would make the page unusable). */
export function isBindableKey(code: string): boolean {
  return isValidPttKey(code) && code !== 'Escape' && code !== 'Tab' && code !== 'Enter'
}
