import { describe, expect, it } from 'vitest'
import { compareVersions, desktopVersionState, loadDismissed, saveDismissed, updateText, DISMISSED_KEY } from '../lib/desktopVersion'

describe('compareVersions', () => {
  it('orders by semver', () => {
    expect(compareVersions('0.4.0', '0.5.0')).toBeLessThan(0)
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0)
    expect(compareVersions('1.2.3+abc', '1.2.3')).toBe(0)
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBeLessThan(0)
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.10')).toBeLessThan(0)
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBeLessThan(0)
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBeLessThan(0)
    expect(compareVersions('1.0.0-beta', '1.0.0-beta.1')).toBeLessThan(0)
    expect(compareVersions('unknown', '1.0.0')).toBeNull()
  })
})

describe('desktopVersionState', () => {
  const base = { isDesktop: true, clientVersion: '0.5.0' }
  it('is nothing in a plain browser', () => {
    expect(desktopVersionState({ ...base, isDesktop: false, appVersion: '0.1.0', serverVersion: '0.5.0' })).toBeNull()
  })
  it('an older app gets the server version as the update', () => {
    expect(desktopVersionState({ ...base, appVersion: '0.4.0', serverVersion: '0.5.0' })).toEqual({
      line: 'Masaüstü uygulaması 0.4.0',
      update: '0.5.0',
    })
  })
  it('the same or a newer app: no notice', () => {
    expect(desktopVersionState({ ...base, appVersion: '0.5.0', serverVersion: '0.5.0' })?.update).toBeNull()
    expect(desktopVersionState({ ...base, appVersion: '0.6.0', serverVersion: '0.5.0' })?.update).toBeNull()
  })
  it('a build without appVersion is an old one', () => {
    expect(desktopVersionState({ ...base, appVersion: undefined, serverVersion: '0.5.0' })).toEqual({
      line: 'Masaüstü uygulaması (eski sürüm)',
      update: '0.5.0',
    })
  })
  it('falls back to the client version when the server does not say', () => {
    expect(desktopVersionState({ ...base, appVersion: '0.4.0', serverVersion: 'unknown' })?.update).toBe('0.5.0')
    expect(desktopVersionState({ ...base, appVersion: '0.4.0', serverVersion: null })?.update).toBe('0.5.0')
    expect(desktopVersionState({ isDesktop: true, clientVersion: 'dev', appVersion: '0.4.0', serverVersion: null })?.update).toBeNull()
  })
  it('text and per-version dismissal', () => {
    expect(updateText('0.5.0')).toBe('Masaüstü uygulamasının yeni sürümü var (0.5.0).')
    const data = new Map<string, string>()
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) }
    expect(loadDismissed(storage)).toBeNull()
    saveDismissed('0.5.0', storage)
    expect(data.get(DISMISSED_KEY)).toBe('0.5.0')
    expect(loadDismissed(storage)).toBe('0.5.0')
  })
})
