import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_SETTINGS,
  isBindableKey,
  keyLabel,
  loadSettings,
  saveSettings,
  SETTINGS_KEY,
  SettingsStore,
  validateSettings,
} from '../settings'

function memoryStorage(initial: Record<string, string> = {}) {
  const data = { ...initial }
  return {
    data,
    getItem: (key: string) => (key in data ? data[key] : null),
    setItem: (key: string, value: string) => {
      data[key] = value
    },
  }
}

describe('validateSettings', () => {
  it('gives the defaults for nothing or garbage', () => {
    for (const raw of [null, undefined, 42, 'x', [], true]) expect(validateSettings(raw)).toEqual(DEFAULT_SETTINGS)
  })

  it('defaults: noise suppression on, activity mode, Backquote', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ noiseSuppression: true, inputMode: 'activity', pttKey: 'Backquote' })
  })

  it('keeps every valid field', () => {
    const full = {
      version: 1,
      micDeviceId: 'mic-1',
      outputDeviceId: 'out-1',
      cameraDeviceId: 'cam-1',
      micDeviceLabel: 'USB Mikrofon',
      outputDeviceLabel: 'Kulaklık',
      cameraDeviceLabel: 'Kamera',
      noiseSuppression: false,
      inputMode: 'ptt',
      pttKey: 'KeyV',
    }
    expect(validateSettings(full)).toEqual(full)
  })

  it('a device name is kept only beside its device id', () => {
    const result = validateSettings({ micDeviceId: '', micDeviceLabel: 'USB Mikrofon', cameraDeviceId: 'c', cameraDeviceLabel: 7 })
    expect(result.micDeviceLabel).toBe('')
    expect(result.cameraDeviceLabel).toBe('')
    expect(validateSettings({ outputDeviceId: 'o', outputDeviceLabel: 'Kulaklık' }).outputDeviceLabel).toBe('Kulaklık')
  })

  it('repairs bad fields one by one and keeps the good ones', () => {
    const result = validateSettings({
      micDeviceId: 7,
      cameraDeviceId: 'cam',
      noiseSuppression: 'yes',
      inputMode: 'shout',
      pttKey: 'not a key!',
      extra: 'ignored',
    })
    expect(result).toEqual({ ...DEFAULT_SETTINGS, cameraDeviceId: 'cam' })
    expect(result).not.toHaveProperty('extra')
  })

  it('refuses absurdly long device ids', () => {
    expect(validateSettings({ micDeviceId: 'x'.repeat(600) }).micDeviceId).toBe('')
  })

  it('migrates older shapes: ptt boolean and the "voice" mode name', () => {
    expect(validateSettings({ ptt: true }).inputMode).toBe('ptt')
    expect(validateSettings({ ptt: false }).inputMode).toBe('activity')
    expect(validateSettings({ inputMode: 'voice' }).inputMode).toBe('activity')
    // An explicit mode wins over the legacy flag.
    expect(validateSettings({ inputMode: 'ptt', ptt: false }).inputMode).toBe('ptt')
    expect(validateSettings({ version: 0 }).version).toBe(1)
  })

  it('accepts the mouse buttons as PTT keys', () => {
    expect(validateSettings({ pttKey: 'MouseBack' }).pttKey).toBe('MouseBack')
  })
})

describe('load and save', () => {
  it('round-trips through trio.settings', () => {
    const storage = memoryStorage()
    saveSettings({ ...DEFAULT_SETTINGS, inputMode: 'ptt', pttKey: 'F13' }, storage)
    expect(JSON.parse(storage.data[SETTINGS_KEY])).toMatchObject({ inputMode: 'ptt', pttKey: 'F13' })
    expect(loadSettings(storage)).toMatchObject({ inputMode: 'ptt', pttKey: 'F13' })
  })

  it('survives unparsable or missing storage', () => {
    expect(loadSettings(memoryStorage({ [SETTINGS_KEY]: '{oops' }))).toEqual(DEFAULT_SETTINGS)
    expect(loadSettings(null)).toEqual(DEFAULT_SETTINGS)
    const throwing = {
      getItem: () => {
        throw new Error('denied')
      },
    }
    expect(loadSettings(throwing)).toEqual(DEFAULT_SETTINGS)
    expect(() =>
      saveSettings(DEFAULT_SETTINGS, {
        setItem: () => {
          throw new Error('quota')
        },
      }),
    ).not.toThrow()
  })
})

describe('SettingsStore', () => {
  it('notifies on a real change only, and validates patches', () => {
    const store = new SettingsStore({ ...DEFAULT_SETTINGS })
    const listener = vi.fn()
    store.subscribe(listener)
    store.update({ noiseSuppression: true })
    expect(listener).not.toHaveBeenCalled()
    store.update({ noiseSuppression: false })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot().noiseSuppression).toBe(false)
    store.update({ pttKey: '<script>' })
    expect(store.getSnapshot().pttKey).toBe('Backquote')
  })
})

describe('keyLabel', () => {
  it.each([
    ['KeyA', 'A'],
    ['Digit7', '7'],
    ['Space', 'Boşluk'],
    ['Backquote', '` (Backquote)'],
    ['ShiftLeft', 'Sol Shift'],
    ['AltRight', 'Sağ Alt (AltGr)'],
    ['Numpad5', 'Num 5'],
    ['NumpadAdd', 'Num +'],
    ['F13', 'F13'],
    ['MouseMiddle', 'Fare orta tuşu'],
    ['MouseBack', 'Fare geri tuşu'],
    ['Lang1', 'Lang1'],
  ])('%s → %s', (code, label) => {
    expect(keyLabel(code)).toBe(label)
  })

  it('does not bind keys that would break the page', () => {
    expect(isBindableKey('Escape')).toBe(false)
    expect(isBindableKey('Tab')).toBe(false)
    expect(isBindableKey('Enter')).toBe(false)
    expect(isBindableKey('')).toBe(false)
    expect(isBindableKey('KeyV')).toBe(true)
  })
})
