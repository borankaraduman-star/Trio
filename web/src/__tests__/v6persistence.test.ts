import { describe, expect, it } from 'vitest'
import {
  dataAgeLine,
  freeSeatsLine,
  parseHealth,
  SERVER_RESET_NOTICE,
  sessionEndedNotice,
} from '../lib/persistence'

const NOW = Date.parse('2026-11-19T12:00:00Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()

describe('persistent storage (V6-OPS §7)', () => {
  it('reads health leniently', () => {
    expect(parseHealth({ ok: true, persistent: false, data_since: 'x' })).toEqual({ persistent: false, dataSince: 'x' })
    expect(parseHealth({ ok: true, version: '0.3.0' })).toEqual({ persistent: null, dataSince: null })
    expect(parseHealth(null)).toEqual({ persistent: null, dataSince: null })
  })

  it('says the server was reset only when its database changed under the session', () => {
    expect(sessionEndedNotice('2026-11-01T00:00:00.000Z', '2026-11-19T11:58:00.000Z', 'eski')).toBe(SERVER_RESET_NOTICE)
    expect(sessionEndedNotice('2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', 'eski')).toBe('eski')
    expect(sessionEndedNotice(null, '2026-11-19T11:58:00.000Z', 'eski')).toBe('eski')
    expect(sessionEndedNotice('2026-11-01T00:00:00.000Z', null, 'eski')).toBe('eski')
  })

  it('writes the data age and the boot count', () => {
    expect(dataAgeLine(ago(12 * 86_400_000 + 5000), 9, NOW)).toBe('Veri: 12 gündür, 9. başlatma')
    expect(dataAgeLine(ago(3 * 3_600_000), 1, NOW)).toBe('Veri: 3 saattir, 1. başlatma')
    expect(dataAgeLine(ago(30_000), null, NOW)).toBe('Veri: birkaç dakikadır')
    expect(dataAgeLine(ago(25 * 60_000), 2, NOW)).toBe('Veri: 25 dakikadır, 2. başlatma')
    expect(dataAgeLine(null, 3, NOW)).toBeNull()
  })

  it('counts free seats', () => {
    expect(freeSeatsLine(5, 3)).toBe('2 boş yer var')
    expect(freeSeatsLine(3, 3)).toBeNull()
    expect(freeSeatsLine(3, 4)).toBeNull()
  })
})
