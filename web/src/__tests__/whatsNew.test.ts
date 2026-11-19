import { describe, expect, it } from 'vitest'
import { CHANGELOG, type ChangelogEntry } from '../changelog'
import { compareVersions, deviceWasUsed, entriesSince, MAX_ENTRIES, parseVersion, VERSION_BEFORE_CARD } from '../lib/whatsNew'
import pkg from '../../package.json'

const LOG: ChangelogEntry[] = [
  { version: '0.10.0', lines: ['ten'] },
  { version: '0.3.0', lines: ['three'] },
  { version: '0.2.1', lines: ['two-one'] },
  { version: '0.2.0', lines: ['two'] },
  { version: '0.1.0', lines: ['one'] },
]
const versions = (entries: ChangelogEntry[]) => entries.map((entry) => entry.version)

describe('versions', () => {
  it('parse and compare numerically', () => {
    expect(parseVersion('1.2.3')).toEqual([1, 2, 3])
    expect(parseVersion('v0.3')).toEqual([0, 3, 0])
    expect(parseVersion('0.3.0-beta.1')).toEqual([0, 3, 0])
    expect(parseVersion('banana')).toBeNull()
    expect(parseVersion('')).toBeNull()
    expect(parseVersion(null)).toBeNull()
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0)
    expect(compareVersions('0.2.0', '0.2')).toBe(0)
    expect(compareVersions('garbage', '0.1.0')).toBeLessThan(0)
  })
})

describe('what is new since the stored version', () => {
  it('lists the newer entries up to the current one, newest first', () => {
    expect(versions(entriesSince(LOG, '0.2.0', '0.3.0', true))).toEqual(['0.3.0', '0.2.1'])
    expect(versions(entriesSince(LOG, '0.2.1', '0.10.0', true))).toEqual(['0.10.0', '0.3.0'])
  })

  it('lists nothing once the current version is seen, or after a downgrade', () => {
    expect(entriesSince(LOG, '0.3.0', '0.3.0', true)).toEqual([])
    expect(entriesSince(LOG, '0.10.0', '0.3.0', true)).toEqual([])
  })

  it('caps a long absence', () => {
    expect(entriesSince(LOG, '0.0.1', '0.10.0', true)).toHaveLength(MAX_ENTRIES)
  })

  it('keeps every part of a version split into several entries, and caps by versions', () => {
    const split: ChangelogEntry[] = [
      { version: '0.4.0', title: 'a', lines: ['a'] },
      { version: '0.4.0', title: 'b', lines: ['b'] },
      ...LOG.slice(1),
    ]
    const shown = entriesSince(split, '0.0.1', '0.4.0', true)
    expect(shown.map((entry) => `${entry.version}${entry.title ?? ''}`)).toEqual(['0.4.0a', '0.4.0b', '0.3.0', '0.2.1'])
    expect(new Set(versions(shown)).size).toBe(MAX_ENTRIES)
  })

  it('shows nothing on a first visit, missing or garbage value alike', () => {
    expect(entriesSince(LOG, null, '0.3.0', false)).toEqual([])
    expect(entriesSince(LOG, 'banana', '0.3.0', false)).toEqual([])
  })

  it('treats a used device without a value as having seen the last version before the card', () => {
    expect(VERSION_BEFORE_CARD).toBe('0.2.0')
    expect(versions(entriesSince(LOG, null, '0.3.0', true))).toEqual(['0.3.0', '0.2.1'])
    expect(versions(entriesSince(LOG, '{"x":1}', '0.3.0', true))).toEqual(['0.3.0', '0.2.1'])
  })

  it('knows a used device by its session and its read marks', () => {
    const store = (values: Record<string, string>) => ({ getItem: (key: string) => values[key] ?? null })
    expect(deviceWasUsed(store({ 'trio.token': 't', 'trio.lastRead': '{}' }))).toBe(true)
    expect(deviceWasUsed(store({ 'trio.token': 't' }))).toBe(false)
    expect(deviceWasUsed(store({}))).toBe(false)
  })
})

describe('the changelog itself', () => {
  it('is newest first, each entry 2–5 lines, and has an entry for this version', () => {
    for (let i = 1; i < CHANGELOG.length; i++) {
      const order = compareVersions(CHANGELOG[i - 1].version, CHANGELOG[i].version)
      expect(order).toBeGreaterThanOrEqual(0)
      // A version in several entries: each part has its own title.
      if (order === 0) {
        expect(CHANGELOG[i - 1].title).toBeTruthy()
        expect(CHANGELOG[i].title).toBeTruthy()
        expect(CHANGELOG[i].title).not.toBe(CHANGELOG[i - 1].title)
      }
    }
    for (const entry of CHANGELOG) {
      expect(entry.lines.length).toBeGreaterThanOrEqual(2)
      expect(entry.lines.length).toBeLessThanOrEqual(5)
    }
    expect(CHANGELOG[0].version).toBe(pkg.version)
  })
})
