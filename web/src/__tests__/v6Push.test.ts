import { describe, expect, it } from 'vitest'
import cases from '../lib/notify/mentionCases.json'
import { findMentions, mentionRowClass, mentionsUser, splitMentions } from '../lib/notify/mentions'
import { inQuietHours, localMinutes, type QuietHours } from '../lib/notify/quietHours'
import {
  canEnablePush,
  defaultDeviceLabel,
  notifyState,
  platformOf,
  stateExplanation,
  uaFamily,
  type NotifyEnvironment,
} from '../lib/notify/permission'
import { localNotifyAllowed, urlBase64ToBytes } from '../lib/notify/notifyHub'
import { installMode } from '../lib/notify/install'
import type { PushPrefs } from '../lib/notify/pushApi'

describe('mentions: the cases shared with the server (server/tests/test_v6_push_rules.py)', () => {
  for (const c of cases.cases) {
    it(JSON.stringify(c.text), () => {
      const names = Object.fromEntries(Object.entries(c.names).map(([id, name]) => [Number(id), name]))
      const spans = findMentions(c.text, names)
      const nfc = c.text.normalize('NFC')
      expect(spans.map((s) => nfc.slice(s.start, s.end))).toEqual(c.spans)
      expect([...new Set(spans.flatMap((s) => (s.userId === null ? [] : [s.userId])))].sort((a, b) => a - b)).toEqual(c.mentioned)
      expect(spans.some((s) => s.userId === null)).toBe(c.everyone)
    })
  }
  it('splits text into runs and marks the ones that name me', () => {
    const names = { 1: 'Ayşe', 2: 'Mehmet' }
    expect(splitMentions('selam @ayşe ve @Mehmet!', names, 1)).toEqual([
      { type: 'text', value: 'selam ' },
      { type: 'mention', value: '@ayşe', me: true },
      { type: 'text', value: ' ve ' },
      { type: 'mention', value: '@Mehmet', me: false },
      { type: 'text', value: '!' },
    ])
    expect(splitMentions('düz yazı', names, 1)).toEqual([{ type: 'text', value: 'düz yazı' }])
  })
  it('highlights a row that names me, not my own and not somebody else', () => {
    const mention = { names: { 1: 'Ayşe', 2: 'Mehmet', 3: 'Işıl' }, myId: 3 }
    expect(mentionRowClass('@IŞIL bak', 2, mention)).toBe(' mentions-me')
    expect(mentionRowClass('@herkes', 2, mention)).toBe(' mentions-me')
    expect(mentionRowClass('@Ayşe bak', 2, mention)).toBe('')
    expect(mentionRowClass('@ışıl ben', 3, mention)).toBe('')
    expect(mentionRowClass('@ışıl', 2, undefined)).toBe('')
    expect(mentionsUser('işil@example.com', mention.names, 3)).toBe(false)
  })
})

const at = (iso: string) => Date.parse(iso)
const quiet = (patch: Partial<QuietHours> = {}): QuietHours => ({ enabled: true, start: '23:00', end: '08:00', tz: 'Europe/Istanbul', ...patch })

describe('quiet hours (the same rule as notify.in_quiet_hours)', () => {
  it('runs over midnight in Istanbul (UTC+3, no DST)', () => {
    expect(inQuietHours(quiet(), at('2026-11-19T19:59:00Z'))).toBe(false) // 22:59
    expect(inQuietHours(quiet(), at('2026-11-19T20:00:00Z'))).toBe(true) // 23:00
    expect(inQuietHours(quiet(), at('2026-11-19T21:30:00Z'))).toBe(true) // 00:30
    expect(inQuietHours(quiet(), at('2026-11-20T04:59:00Z'))).toBe(true) // 07:59
    expect(inQuietHours(quiet(), at('2026-11-20T05:00:00Z'))).toBe(false) // 08:00
    // Istanbul stays UTC+3 in summer.
    expect(localMinutes(at('2026-07-01T20:00:00Z'), 'Europe/Istanbul')).toBe(23 * 60)
  })
  it('follows the wall clock across DST in Berlin', () => {
    const q = quiet({ start: '01:30', end: '03:30', tz: 'Europe/Berlin' })
    expect(inQuietHours(q, at('2026-03-29T00:45:00Z'))).toBe(true) // 01:45 CET
    expect(inQuietHours(q, at('2026-03-29T01:15:00Z'))).toBe(true) // 03:15 CEST
    expect(inQuietHours(q, at('2026-03-29T01:31:00Z'))).toBe(false) // 03:31 CEST
    expect(inQuietHours(q, at('2026-10-25T00:30:00Z'))).toBe(true) // 02:30 CEST
    expect(inQuietHours(q, at('2026-10-25T01:30:00Z'))).toBe(true) // 02:30 CET, the second one
    expect(inQuietHours({ ...q, tz: 'Europe/Istanbul' }, at('2026-10-25T01:30:00Z'))).toBe(false) // 04:30
  })
  it('is off when disabled, empty, or malformed', () => {
    const now = at('2026-11-19T22:00:00Z')
    expect(inQuietHours(quiet({ enabled: false }), now)).toBe(false)
    expect(inQuietHours(quiet({ start: '05:00', end: '05:00' }), now)).toBe(false)
    expect(inQuietHours(quiet({ start: '25:00' }), now)).toBe(false)
  })
})

const env = (patch: Partial<NotifyEnvironment> = {}): NotifyEnvironment => ({
  notification: true,
  serviceWorker: true,
  pushManager: true,
  secure: true,
  ios: false,
  standalone: false,
  permission: 'default',
  ...patch,
})

describe('permission states', () => {
  it('maps the environment to one state', () => {
    expect(notifyState(env())).toBe('default')
    expect(notifyState(env({ permission: 'granted' }))).toBe('granted')
    expect(notifyState(env({ permission: 'denied' }))).toBe('denied')
    expect(notifyState(env({ ios: true, notification: false, pushManager: false, permission: null }))).toBe('ios-needs-home-screen')
    expect(notifyState(env({ ios: true, standalone: true }))).toBe('default')
    expect(notifyState(env({ secure: false }))).toBe('insecure')
    expect(notifyState(env({ notification: false, permission: null }))).toBe('unsupported')
    expect(notifyState(env({ pushManager: false, permission: 'granted' }))).toBe('no-push')
    expect(notifyState(env({ pushManager: false }))).toBe('default')
  })
  it('only offers the device toggle where a push can arrive', () => {
    expect(canEnablePush('default', env())).toBe(true)
    expect(canEnablePush('granted', env())).toBe(true)
    expect(canEnablePush('denied', env())).toBe(false)
    expect(canEnablePush('default', env({ pushManager: false }))).toBe(false)
    expect(canEnablePush('ios-needs-home-screen', env())).toBe(false)
  })
  it('explains every state, with the iOS home-screen rule and per-platform re-enable steps', () => {
    expect(stateExplanation('ios-needs-home-screen', 'ios')).toContain('Ana Ekrana Ekle')
    expect(stateExplanation('denied', 'android')).toContain('İzin ver')
    expect(stateExplanation('denied', 'ios')).toContain('Ayarlar → Bildirimler')
    for (const state of ['insecure', 'unsupported', 'no-push', 'default', 'granted'] as const)
      expect(stateExplanation(state, 'windows').length).toBeGreaterThan(10)
  })
  it('names the device from its user agent', () => {
    const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1'
    const ipad = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15'
    const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'
    const edge = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0'
    const firefox = 'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0'
    expect(defaultDeviceLabel(iphone)).toBe('iPhone/iPad · Safari')
    expect(platformOf(ipad, 5)).toBe('ios')
    expect(platformOf(ipad, 0)).toBe('mac')
    expect(defaultDeviceLabel(android)).toBe('Android · Chrome')
    expect(uaFamily(edge)).toBe('edge')
    expect(defaultDeviceLabel(firefox)).toBe('Linux · Firefox')
  })
})

const prefs = (patch: Partial<PushPrefs> = {}): PushPrefs => ({
  channels: {},
  quiet: { enabled: false, start: '23:00', end: '08:00', tz: 'Europe/Istanbul' },
  voice_rooms: true,
  calls: true,
  calls_break_quiet: false,
  ...patch,
})

describe('notifications a tab shows itself', () => {
  const base = { kind: 'message' as const, permission: 'granted' as const, pushedHere: false, prefs: prefs(), channelId: 1, mention: false, now: at('2026-11-19T12:00:00Z') }
  it('needs permission and is skipped where the server pushes', () => {
    expect(localNotifyAllowed(base)).toBe(true)
    expect(localNotifyAllowed({ ...base, permission: 'default' })).toBe(false)
    expect(localNotifyAllowed({ ...base, pushedHere: true })).toBe(false)
    expect(localNotifyAllowed({ ...base, prefs: null })).toBe(true)
  })
  it('follows the server-side preferences', () => {
    expect(localNotifyAllowed({ ...base, prefs: prefs({ channels: { '1': 'none' } }), mention: true })).toBe(false)
    expect(localNotifyAllowed({ ...base, prefs: prefs({ channels: { '1': 'mentions' } }) })).toBe(false)
    expect(localNotifyAllowed({ ...base, prefs: prefs({ channels: { '1': 'mentions' } }), mention: true })).toBe(true)
    const night = { ...base, now: at('2026-11-19T22:00:00Z'), prefs: prefs({ quiet: { enabled: true, start: '23:00', end: '08:00', tz: 'Europe/Istanbul' } }) }
    expect(localNotifyAllowed(night)).toBe(false)
    expect(localNotifyAllowed({ ...night, mention: true })).toBe(true)
    expect(localNotifyAllowed({ ...night, kind: 'ring', channelId: null })).toBe(false)
    expect(localNotifyAllowed({ ...night, kind: 'ring', channelId: null, prefs: { ...night.prefs, calls_break_quiet: true } })).toBe(true)
    expect(localNotifyAllowed({ ...base, kind: 'voice', prefs: prefs({ voice_rooms: false }) })).toBe(false)
    expect(localNotifyAllowed({ ...base, kind: 'ring', prefs: prefs({ calls: false }) })).toBe(false)
  })
})

describe('the install card', () => {
  it('shows the iOS steps in Safari, the prompt elsewhere, never once installed or dismissed', () => {
    expect(installMode({ ios: true, standalone: false, promptReady: false, dismissed: false })).toBe('ios')
    expect(installMode({ ios: true, standalone: true, promptReady: false, dismissed: false })).toBeNull()
    expect(installMode({ ios: false, standalone: false, promptReady: true, dismissed: false })).toBe('prompt')
    expect(installMode({ ios: false, standalone: false, promptReady: false, dismissed: false })).toBeNull()
    expect(installMode({ ios: true, standalone: false, promptReady: false, dismissed: true })).toBeNull()
  })
})

describe('the VAPID key', () => {
  it('decodes base64url to the 65 bytes of a P-256 point', () => {
    const key = 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM'
    const bytes = urlBase64ToBytes(key)
    expect(bytes.length).toBe(65)
    expect(bytes[0]).toBe(4)
  })
})
