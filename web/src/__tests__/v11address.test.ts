import { describe, expect, it } from 'vitest'
import {
  applyMovePrefs,
  cleanOrigin,
  collectMovePrefs,
  forgetMovedPrefs,
  forwardUrl,
  hashWithoutMove,
  linkOrigin,
  looksLikeRecovery,
  MOVE_PREF_KEYS,
  nextPending,
  normalizeMoveCode,
  offCanonical,
  parseMoveFragment,
} from '../lib/address'
import { bulkCodesText } from '../components/address/AddressCard'

function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  }
}

describe('the canonical address', () => {
  it('accepts plain origins only', () => {
    expect(cleanOrigin('https://trio.example.org')).toBe('https://trio.example.org')
    expect(cleanOrigin('https://trio.example.org/x')).toBeNull()
    expect(cleanOrigin('javascript:alert(1)')).toBeNull()
    expect(cleanOrigin('https://u:p@trio.example.org')).toBeNull()
    expect(cleanOrigin(42)).toBeNull()
  })
  it('points links at it and knows when the page is elsewhere', () => {
    const known = { publicUrl: 'https://new.example' }
    expect(linkOrigin('https://old.example', known)).toBe('https://new.example')
    expect(linkOrigin('https://old.example', { publicUrl: '' })).toBe('https://old.example')
    expect(offCanonical('https://old.example', known)).toBe(true)
    expect(offCanonical('https://new.example', known)).toBe(false)
    expect(offCanonical('https://old.example', { publicUrl: null })).toBe(false)
    expect(nextPending('https://old.example', { publicUrl: '', nextUrl: 'https://n.example' })).toBe(true)
    expect(nextPending('https://n.example', { publicUrl: '', nextUrl: 'https://n.example' })).toBe(false)
  })
  it('forwards an invite or device code in the fragment only', () => {
    expect(forwardUrl('https://new.example', null, null)).toBe('https://new.example/')
    expect(forwardUrl('https://new.example', 'a b', 'K7QX3MZ9PA')).toBe(
      'https://new.example/#davet=a+b&cihaz=K7QX3MZ9PA',
    )
  })
})

describe('the move fragment', () => {
  it('reads and removes #tasi=', () => {
    expect(parseMoveFragment('#tasi=k7qx3-mz9pa')).toBe('K7QX3MZ9PA')
    expect(parseMoveFragment('#tasi=0000')).toBeNull()
    expect(parseMoveFragment('#cihaz=K7QX3MZ9PA')).toBeNull()
    expect(hashWithoutMove('#tasi=K7QX3MZ9PA&davet=x')).toBe('#davet=x')
    expect(normalizeMoveCode('K7QX3 MZ9PA')).toBe('K7QX3MZ9PA')
  })
})

describe('preferences that move', () => {
  it('collects only the allowlist, never the token', () => {
    const store = memory({
      'trio.token': 'SECRET',
      'trio.user': '{}',
      'trio.push.device': 'x',
      'trio.settings': '{"a":1}',
      'trio.drafts': '{}',
      other: 'y',
    })
    expect(collectMovePrefs(store)).toEqual({ 'trio.settings': '{"a":1}', 'trio.drafts': '{}' })
    expect(MOVE_PREF_KEYS).not.toContain('trio.token' as never)
  })
  it('caps each value and the total', () => {
    const store = memory({ 'trio.settings': 'x'.repeat(33 * 1024), 'trio.voice6': 'y'.repeat(30 * 1024), 'trio.music8': 'z'.repeat(30 * 1024), 'trio.channel': 'w'.repeat(30 * 1024) })
    expect(Object.keys(collectMovePrefs(store))).toEqual(['trio.voice6', 'trio.music8'])
  })
  it('applies only allowlisted strings, and can keep what is there', () => {
    const store = memory({ 'trio.lastName': 'old' })
    expect(applyMovePrefs(store, { 'trio.token': 'x', 'trio.settings': '{}', 'trio.lastName': 'new', 'trio.voice6': 5 }, true)).toBe(1)
    expect(store.getItem('trio.token')).toBeNull()
    expect(store.getItem('trio.lastName')).toBe('old')
    applyMovePrefs(store, { 'trio.lastName': 'new' })
    expect(store.getItem('trio.lastName')).toBe('new')
    forgetMovedPrefs(store)
    expect(store.data.size).toBe(0)
  })
})

describe('recovery and the codes for everybody', () => {
  it('tells a recovery code from a device code', () => {
    expect(looksLikeRecovery('ABCDE-FGHJK')).toBe(false)
    expect(looksLikeRecovery('abcdefghjkm')).toBe(true)
  })
  it('makes one line per person', () => {
    expect(
      bulkCodesText([
        { user: { id: 2, name: 'Berk' }, code: 'K7QX3MZ9PA', url: 'https://n.example/#cihaz=K7QX3MZ9PA' },
        { user: { id: 3, name: 'Cem' }, code: 'ABCDEFGHJK', url: null },
      ]),
    ).toBe('Berk — K7QX3-MZ9PA — https://n.example/#cihaz=K7QX3MZ9PA\nCem — ABCDE-FGHJK')
  })
})
