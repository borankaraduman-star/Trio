import { describe, expect, it } from 'vitest'
import {
  estimateText,
  estimateUpload,
  formatMbps,
  profileSettings,
  trackConstraints,
  uploadWarning,
} from '../lib/shareProfiles'
import { parseWatch, watchApplies } from '../lib/watch'
import { AfkMachine } from '../lib/afk'
import { comboFromEvent, comboLabel, hotkeyConflict, matchesCombo, parseCombo } from '../lib/hotkeys'
import { VoicePrefsStore, validateVoicePrefs, volumeOf, VOICE_PREFS_KEY } from '../lib/voicePrefs'
import { createGate, dbToLinear, GATE_HOLD_MS, GATE_LOOKAHEAD_MS, linearToDb } from '../audio/gateCore'

describe('share profiles', () => {
  it('maps each profile and quality to sender parameters and constraints', () => {
    expect(profileSettings('game', 'mid')).toEqual({
      contentHint: 'motion',
      constraints: { frameRate: 60, width: 1280, height: 720 },
      maxBitrate: 3_000_000,
      maxFramerate: 60,
      degradationPreference: 'maintain-framerate',
    })
    expect(profileSettings('game', 'high').constraints).toEqual({ frameRate: 60, width: 1920, height: 1080 })
    expect(profileSettings('game', 'low').maxBitrate).toBe(1_500_000)
    expect(profileSettings('text', 'high')).toEqual({
      contentHint: 'detail',
      constraints: { frameRate: 15 },
      maxBitrate: 6_000_000,
      maxFramerate: 15,
      degradationPreference: 'maintain-resolution',
    })
    expect(profileSettings('film', 'low')).toMatchObject({
      contentHint: 'motion',
      maxFramerate: 30,
      degradationPreference: 'balanced',
    })
  })

  it('caps with max constraints and leaves Metin at full resolution', () => {
    expect(trackConstraints(profileSettings('game', 'mid'))).toEqual({
      frameRate: { max: 60 },
      width: { max: 1280 },
      height: { max: 720 },
    })
    expect(trackConstraints(profileSettings('text', 'mid'))).toEqual({ frameRate: { max: 15 } })
  })

  it('estimates the mesh upload and warns on a measured shortfall', () => {
    const two = estimateUpload(2, 'mid')
    expect(two).toEqual({ viewers: 2, perViewer: 3_000_000, total: 6_000_000 })
    expect(estimateText(two)).toBe('2 izleyici × 3 Mbps ≈ 6 Mbps')
    expect(estimateText(estimateUpload(0, 'high'))).toMatch(/kimse izlemiyor/)
    expect(formatMbps(1_500_000)).toBe('1,5 Mbps')
    expect(uploadWarning(two, [null, null])).toBeNull()
    expect(uploadWarning(two, [10_000_000, 9_000_000])).toBeNull()
    expect(uploadWarning(two, [10_000_000, 2_000_000])).toMatch(/yetmeyebilir/)
    expect(uploadWarning(two, [3_100_000, 2_800_000])).toMatch(/yetmeyebilir/)
    expect(uploadWarning(estimateUpload(0, 'mid'), [1])).toBeNull()
  })
})

describe('watch signal', () => {
  it('parses only the exact form', () => {
    expect(parseWatch({ watch: { stream: 'abc', on: false } })).toEqual({ stream: 'abc', on: false })
    expect(parseWatch({ watch: { stream: 'screen', on: true }, g: 3 })).toEqual({ stream: 'screen', on: true })
    expect(parseWatch({ watch: { stream: '', on: true } })).toBeNull()
    expect(parseWatch({ watch: { stream: 'x', on: 'no' } })).toBeNull()
    expect(parseWatch({ meta: { camera: null, screen: null } })).toBeNull()
    expect(parseWatch({ negotiate: 'request' })).toBeNull()
    expect(parseWatch(null)).toBeNull()
  })

  it('applies to the current share or to "screen" only', () => {
    expect(watchApplies({ stream: 'a', on: false }, 'a')).toBe(true)
    expect(watchApplies({ stream: 'screen', on: false }, 'a')).toBe(true)
    expect(watchApplies({ stream: 'old', on: false }, 'a')).toBe(false)
    expect(watchApplies({ stream: 'screen', on: false }, null)).toBe(false)
  })
})

describe('AFK machine', () => {
  function machine() {
    const log: string[] = []
    let muted = false
    const afk = new AfkMachine(
      {
        setAfk: (on) => log.push(`afk:${on}`),
        setMuted: (on) => {
          muted = on
          log.push(`muted:${on}`)
        },
      },
      0,
      1000,
    )
    return { afk, log, muted: () => muted, setMuted: (value: boolean) => (muted = value) }
  }

  it('goes AFK after the timeout, auto-mutes, and unmutes on return', () => {
    const m = machine()
    m.afk.tick(999, m.muted())
    expect(m.log).toEqual([])
    m.afk.tick(1000, m.muted())
    expect(m.log).toEqual(['afk:true', 'muted:true'])
    m.afk.tick(5000, m.muted())
    expect(m.log).toHaveLength(2)
    m.afk.activity(6000, m.muted())
    expect(m.log).toEqual(['afk:true', 'muted:true', 'afk:false', 'muted:false'])
  })

  it('activity resets the clock', () => {
    const m = machine()
    m.afk.activity(900, false)
    m.afk.tick(1500, false)
    expect(m.log).toEqual([])
    m.afk.tick(1900, false)
    expect(m.log).toEqual(['afk:true', 'muted:true'])
  })

  it('never unmutes a mute the user chose', () => {
    const m = machine()
    m.setMuted(true)
    m.afk.tick(1000, true)
    expect(m.log).toEqual(['afk:true'])
    m.afk.activity(2000, true)
    expect(m.log).toEqual(['afk:true', 'afk:false'])
    expect(m.muted()).toBe(true)
  })

  it('a manual mute change during AFK makes the mute the user’s', () => {
    const m = machine()
    m.afk.tick(1000, false)
    m.afk.manualMute()
    m.afk.activity(1200, true)
    expect(m.log).toEqual(['afk:true', 'muted:true', 'afk:false'])
  })

  it('an auto-mute the user already undid is not touched', () => {
    const m = machine()
    m.afk.tick(1000, false)
    m.afk.activity(1100, false)
    expect(m.log).toEqual(['afk:true', 'muted:true', 'afk:false'])
  })

  it('disabled: never AFK; disabling ends an AFK', () => {
    const m = machine()
    m.afk.setEnabled(false, 0, false)
    m.afk.tick(10_000, false)
    expect(m.log).toEqual([])
    m.afk.setEnabled(true, 10_000, false)
    m.afk.tick(11_000, false)
    expect(m.afk.isAfk).toBe(true)
    m.afk.setEnabled(false, 11_500, true)
    expect(m.afk.isAfk).toBe(false)
    expect(m.log.at(-1)).toBe('muted:false')
  })
})

describe('hotkeys', () => {
  const ev = (code: string, mods: Partial<{ ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }> = {}) => ({
    code,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...mods,
  })

  it('parses, matches and labels chords', () => {
    expect(parseCombo('Ctrl+Shift+KeyM')).toEqual({ code: 'KeyM', ctrl: true, shift: true, alt: false, meta: false })
    expect(parseCombo('KeyM')).toBeNull()
    expect(parseCombo('Shift+KeyM')).toBeNull()
    expect(parseCombo('Ctrl+ShiftLeft')).toBeNull()
    expect(parseCombo('Hyper+KeyM')).toBeNull()
    expect(matchesCombo('Ctrl+Shift+KeyM', ev('KeyM', { ctrlKey: true, shiftKey: true }))).toBe(true)
    expect(matchesCombo('Ctrl+Shift+KeyM', ev('KeyM', { ctrlKey: true }))).toBe(false)
    expect(comboFromEvent(ev('KeyD', { altKey: true }))).toBe('Alt+KeyD')
    expect(comboFromEvent(ev('ControlLeft', { ctrlKey: true }))).toBeNull()
    expect(comboFromEvent(ev('KeyD'))).toBeNull()
    expect(comboLabel('Ctrl+Shift+KeyM')).toBe('Ctrl + Shift + M')
  })

  it('a key cannot be both PTT and a hotkey, nor both hotkeys', () => {
    expect(hotkeyConflict({ ptt: 'Backquote', mute: 'F9', deafen: 'F10' })).toBeNull()
    expect(hotkeyConflict({ ptt: 'F9', mute: 'F9', deafen: null })).toMatch(/bas-konuş/)
    expect(hotkeyConflict({ ptt: null, mute: 'F9', deafen: 'F9' })).toMatch(/aynı tuş/)
    expect(hotkeyConflict({ ptt: null, mute: 'F9', deafen: null })).toBeNull()
    expect(hotkeyConflict({ ptt: null, mute: null, deafen: null })).toBeNull()
  })
})

describe('voice prefs', () => {
  it('repairs field by field', () => {
    const prefs = validateVoicePrefs({
      shareProfile: 'game',
      shareQuality: 'ultra',
      volumes: { '2': { voice: 1.5, stream: 9 }, x: { voice: 0 }, '3': { voice: 1, stream: 1 }, '4': { voice: -1 } },
      gateThresholdDb: -200,
      afkEnabled: 'no',
      desktopHotkeys: { mute: 'F9', deafen: 'F9' },
      pageShortcuts: { mute: null, deafen: 'KeyD' },
    })
    expect(prefs.shareProfile).toBe('game')
    expect(prefs.shareQuality).toBe('mid')
    expect(prefs.volumes).toEqual({ '2': { voice: 1.5, stream: 2 }, '4': { voice: 0, stream: 1 } })
    expect(prefs.gateThresholdDb).toBe(-80)
    expect(prefs.afkEnabled).toBe(true)
    expect(prefs.desktopHotkeys).toEqual({ mute: 'F9', deafen: null })
    expect(prefs.pageShortcuts).toEqual({ mute: null, deafen: 'Ctrl+Shift+KeyD' })
    expect(validateVoicePrefs('garbage').shareProfile).toBe('film')
  })

  it('persists volumes per user id and resets', () => {
    const data = new Map<string, string>()
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) }
    const store = new VoicePrefsStore(storage)
    store.setVolume(7, 'voice', 1.6)
    store.setVolume(7, 'stream', 0.3)
    store.setVolume(8, 'voice', 0)
    const again = new VoicePrefsStore(storage)
    expect(volumeOf(again.getSnapshot(), 7)).toEqual({ voice: 1.6, stream: 0.3 })
    expect(volumeOf(again.getSnapshot(), 8)).toEqual({ voice: 0, stream: 1 })
    expect(volumeOf(again.getSnapshot(), 9)).toEqual({ voice: 1, stream: 1 })
    again.resetVolume(7)
    expect(volumeOf(new VoicePrefsStore(storage).getSnapshot(), 7)).toEqual({ voice: 1, stream: 1 })
    again.resetAllVolumes()
    expect(JSON.parse(data.get(VOICE_PREFS_KEY)!).volumes).toEqual({})
  })
})

describe('input gate', () => {
  const RATE = 48000
  const ms = (n: number) => Math.round((RATE * n) / 1000)

  /** Silence, then a tone of `amp` for `toneMs`, then silence; processed in 128-sample blocks. */
  function run(amp: number, thresholdDb: number) {
    const total = ms(1000)
    const start = ms(200)
    const end = start + ms(300)
    const input = new Float32Array(total)
    for (let i = start; i < end; i++) input[i] = amp * Math.sin((2 * Math.PI * 200 * (i - start)) / RATE)
    const output = new Float32Array(total)
    const gate = createGate(RATE, dbToLinear(thresholdDb), GATE_HOLD_MS, GATE_LOOKAHEAD_MS)
    for (let i = 0; i < total; i += 128) gate.process(input.subarray(i, i + 128), output.subarray(i, i + 128))
    return { input, output, start, end, lookahead: gate.lookahead }
  }

  it('passes a loud word whole, onset included, delayed by the look-ahead', () => {
    const { input, output, start, end, lookahead } = run(0.3, -40)
    expect(lookahead).toBe(ms(10))
    // The first samples of the word come out at full level (the gate opened during the look-ahead).
    for (let i = start + 1; i < start + ms(5); i++) expect(output[i + lookahead]).toBeCloseTo(input[i], 6)
    for (let i = start; i < end; i++) expect(output[i + lookahead]).toBeCloseTo(input[i], 6)
  })

  it('keeps a quiet signal out entirely', () => {
    const { output } = run(0.003, -40)
    expect(Math.max(...output.map(Math.abs))).toBe(0)
  })

  it('hold and release timing on a quiet bed after a loud burst', () => {
    const total = ms(1000)
    const input = new Float32Array(total)
    const loudEnd = ms(100)
    for (let i = 0; i < total; i++) input[i] = (i < loudEnd ? 0.5 : 0.001) * (i % 2 ? 1 : -1)
    const output = new Float32Array(total)
    const gate = createGate(RATE, dbToLinear(-40), GATE_HOLD_MS, GATE_LOOKAHEAD_MS)
    for (let i = 0; i < total; i += 128) gate.process(input.subarray(i, i + 128), output.subarray(i, i + 128))
    const la = gate.lookahead
    // The quiet bed right after the burst still comes through (hold).
    expect(Math.abs(output[loudEnd + la + ms(200)])).toBeCloseTo(0.001, 6)
    // Just past hold + 20 ms release: closed.
    expect(Math.abs(output[loudEnd + la + ms(GATE_HOLD_MS) + ms(25)])).toBe(0)
    expect(gate.isOpen()).toBe(false)
  })

  it('is self-contained: its source can be evaluated on its own (the worklet)', () => {
    const rebuilt = new Function(`return (${createGate.toString()})`)() as typeof createGate
    const gate = rebuilt(RATE, 0.1, 250, 10)
    const out = new Float32Array(4)
    gate.process(new Float32Array([0.5, 0.5, 0.5, 0.5]), out)
    expect(gate.isOpen()).toBe(true)
  })

  it('dB helpers', () => {
    expect(dbToLinear(-20)).toBeCloseTo(0.1)
    expect(linearToDb(0.01)).toBeCloseTo(-40)
    expect(linearToDb(0)).toBe(-Infinity)
  })
})
