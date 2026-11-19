import { describe, expect, it, vi } from 'vitest'
import { isDeletedAttachment, uploadErrorMessage } from '../lib/attachments'
import { browserFamily, buildReport, encodeReport, ReportGate, scrubText, type ErrorReport } from '../lib/errorReport'
import {
  backupStale,
  formatCount,
  formatUptime,
  lastBackupLine,
  ownerErrorMessage,
  relativeTime,
  turnLabel,
  usageRatio,
  usageText,
} from '../lib/opsFormat'

const NOW = Date.parse('2026-11-19T12:00:00Z')
const DAY = 86_400_000

describe('owner text', () => {
  it('formats counts the Turkish way', () => {
    expect(formatCount(14203)).toBe('14.203')
    expect(formatCount(312)).toBe('312')
    expect(formatCount(1234567)).toBe('1.234.567')
    expect(formatCount(0)).toBe('0')
  })

  it('says how long ago', () => {
    expect(relativeTime(NOW - 5_000, NOW)).toBe('az önce')
    expect(relativeTime(NOW + 60_000, NOW)).toBe('az önce')
    expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe('5 dakika önce')
    expect(relativeTime(NOW - 3 * 3_600_000, NOW)).toBe('3 saat önce')
    expect(relativeTime(NOW - 3 * DAY, NOW)).toBe('3 gün önce')
  })

  it('writes the last backup line', () => {
    const last = {
      at: new Date(NOW - 3 * DAY).toISOString(),
      counts: { messages: 14203, attachments: 300 },
      upload_files: 312,
      bytes: 1,
    }
    expect(lastBackupLine(last, NOW)).toBe('Son yedek: 3 gün önce · 14.203 mesaj, 312 dosya')
    expect(lastBackupLine(null, NOW)).toBe('Henüz yedek alınmadı.')
  })

  it('calls a backup stale after 14 days or when there is none', () => {
    const at = (days: number) => ({ at: new Date(NOW - days * DAY).toISOString(), counts: { messages: 0, attachments: 0 }, upload_files: 0, bytes: 0 })
    expect(backupStale(null, NOW)).toBe(true)
    expect(backupStale(at(13.9), NOW)).toBe(false)
    expect(backupStale(at(14.1), NOW)).toBe(true)
    expect(backupStale({ ...at(1), at: 'garbage' }, NOW)).toBe(true)
  })

  it('shows usage in MB and as a ratio', () => {
    const MB = 1024 * 1024
    expect(usageText(412 * MB, 1024 * MB)).toBe('412 / 1024 MB')
    expect(usageText(0.42 * MB, 1024 * MB)).toBe('0,4 / 1024 MB')
    expect(usageText(5 * MB, 1024 * MB)).toBe('5 / 1024 MB')
    expect(usageText(0, 1024 * MB)).toBe('0 / 1024 MB')
    expect(usageRatio(512, 1024)).toBe(0.5)
    expect(usageRatio(2048, 1024)).toBe(1)
    expect(usageRatio(5, 0)).toBe(0)
  })

  it('formats uptime and TURN, and words the owner errors', () => {
    expect(formatUptime(3 * 86400 + 4 * 3600 + 5)).toBe('3 gün 4 saat')
    expect(formatUptime(5 * 3600 + 12 * 60)).toBe('5 saat 12 dk')
    expect(formatUptime(12 * 60)).toBe('12 dk')
    expect(formatUptime(10)).toBe('1 dakikadan az')
    expect(turnLabel('none')).toMatch(/STUN/)
    expect(ownerErrorMessage('INVALID_CONFIRM_CODE')).toBe('Davet kodu yanlış.')
    expect(ownerErrorMessage('RATE_LIMITED', 125)).toContain('3 dakika')
    expect(ownerErrorMessage('???')).toBe('İşlem yapılamadı.')
  })

  it('knows a tombstone, and the quota text points at Depolama', () => {
    expect(isDeletedAttachment({ deleted: true })).toBe(true)
    expect(isDeletedAttachment({})).toBe(false)
    expect(uploadErrorMessage('QUOTA_EXCEEDED')).toContain('Depolama')
  })
})

describe('error reports', () => {
  const env = { version: '0.4.0', build: '202611190000', path: '/kanal?x=1#davet=abc', userAgent: 'Mozilla/5.0 Chrome/131.0 Safari/537' }

  it('strips query strings, fragments and secrets', () => {
    expect(scrubText('at https://trio.example/app.js?token=abc#frag:1:2', 500)).toBe('at https://trio.example/app.js:1:2')
    expect(scrubText('failed token=xyz and davet=KOD', 500)).toBe('failed token=[redacted] and davet=[redacted]')
    expect(scrubText('x'.repeat(3000), 2048)).toHaveLength(2048)
  })

  it('builds a report from what was thrown, with the path only', () => {
    const error = new TypeError('x is undefined')
    error.stack = 'TypeError: x is undefined\n    at f (http://h/assets/a.js?v=1:1:2)'
    const report = buildReport(error, 'Hata', env)
    expect(report).toEqual({
      message: 'TypeError: x is undefined',
      stack: 'TypeError: x is undefined\n    at f (http://h/assets/a.js:1:2)',
      version: '0.4.0',
      build: '202611190000',
      context: '/kanal',
      browser: 'Chrome 131',
    })
    expect(buildReport('just a string', 'Hata', env).message).toBe('just a string')
    expect(buildReport({ weird: true }, 'Unhandled rejection', env).message).toBe('Unhandled rejection')
  })

  it('names browser families', () => {
    expect(browserFamily('Mozilla/5.0 (X11) Gecko/20100101 Firefox/133.0')).toBe('Firefox 133')
    expect(browserFamily('Mozilla/5.0 Chrome/131 Safari/537.36 Edg/131.0')).toBe('Edge 131')
    expect(browserFamily('Mozilla/5.0 Version/18.1 Mobile/15E148 Safari/604.1')).toBe('Safari 18')
    expect(browserFamily('Mozilla/5.0 Chrome/130 Electron/33.0 Safari/537.36')).toBe('Trio masaüstü')
    expect(browserFamily('curl/8')).toBe('diğer')
  })

  it('keeps a body under 4 KB by cutting the stack', () => {
    const report: ErrorReport = { message: 'm', stack: 'é'.repeat(2048), version: '', build: '', context: '/', browser: '' }
    const body = encodeReport(report)
    expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(4096)
    expect(JSON.parse(body).message).toBe('m')
  })

  it('sends each distinct error once, at most ten, and drops errors raised while sending', () => {
    const gate = new ReportGate(3)
    const sent: string[] = []
    const send = vi.fn(async (report: ErrorReport) => {
      sent.push(report.message)
    })
    const make = (message: string, frame = 'at f (a.js:1)'): ErrorReport => ({
      message,
      stack: `${message}\n    ${frame}`,
      version: '',
      build: '',
      context: '/',
      browser: '',
    })
    expect(gate.offer(make('a'), send)).toBe(true)
    expect(gate.offer(make('a'), send)).toBe(false) // a repeat
    expect(gate.offer(make('a', 'at g (a.js:9)'), send)).toBe(true) // another place
    // A report that throws while being sent: the error it raises is not reported.
    const reentrant = new ReportGate()
    let inner: boolean | null = null
    expect(
      reentrant.offer(make('outer'), () => {
        inner = reentrant.offer(make('inner'), send)
        throw new Error('send failed')
      }),
    ).toBe(false)
    expect(inner).toBe(false)
    expect(gate.offer(make('b'), send)).toBe(true)
    expect(gate.offer(make('c'), send)).toBe(false) // the per-load limit
    expect(sent).toEqual(['a', 'a', 'b'])
    // A rejected request is swallowed.
    expect(() => new ReportGate().offer(make('z'), () => Promise.reject(new Error('offline')))).not.toThrow()
  })
})
