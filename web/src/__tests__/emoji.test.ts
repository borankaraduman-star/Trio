import { describe, expect, it } from 'vitest'
import { normalizeReactionKey, reactionPath, utf8Length } from '../lib/emojiKey'
import { ALL_EMOJI, QUICK_REACTIONS, searchEmoji } from '../lib/emojiData'
import { loadRecent, MAX_RECENT, pushRecent, type KeyValueStore } from '../lib/recentEmoji'

describe('normalizeReactionKey', () => {
  it('adds VS16 where the default presentation is text', () => {
    expect(normalizeReactionKey('❤')).toBe('❤️')
    expect(normalizeReactionKey('❤️')).toBe('❤️')
    expect(normalizeReactionKey('❤︎')).toBe('❤️')
    expect(normalizeReactionKey('☺')).toBe('☺️')
    expect(normalizeReactionKey('©')).toBe('©️')
  })

  it('leaves emoji-presentation characters, modifiers, flags and names alone', () => {
    for (const key of ['👍', '👍🏽', '🇹🇷', '🏴󠁧󠁢󠁳󠁣󠁴󠁿', ':parti_1:', '😂']) expect(normalizeReactionKey(key)).toBe(key)
    // ☝🏻 is fully qualified without VS16.
    expect(normalizeReactionKey('☝\u{1F3FB}')).toBe('☝\u{1F3FB}')
  })

  it('qualifies every element of a ZWJ sequence and keycaps', () => {
    expect(normalizeReactionKey('❤‍\u{1F525}')).toBe('❤️‍\u{1F525}')
    expect(normalizeReactionKey('\u{1F3F3}‍\u{1F308}')).toBe('\u{1F3F3}️‍\u{1F308}')
    expect(normalizeReactionKey('1⃣')).toBe('1️⃣')
  })

  it('is idempotent, and every picker emoji is already in its sent form', () => {
    for (const { emoji } of ALL_EMOJI) {
      expect(normalizeReactionKey(emoji)).toBe(emoji)
      expect(utf8Length(emoji)).toBeLessThanOrEqual(64)
    }
    for (const emoji of QUICK_REACTIONS) expect(normalizeReactionKey(emoji)).toBe(emoji)
  })

  it('percent-encodes the normalised key for the path', () => {
    expect(reactionPath('❤')).toBe(encodeURIComponent('❤️'))
  })
})

describe('the built-in set', () => {
  it('has about 80 distinct emoji', () => {
    const set = new Set(ALL_EMOJI.map((entry) => entry.emoji))
    expect(set.size).toBe(ALL_EMOJI.length)
    expect(set.size).toBeGreaterThanOrEqual(70)
    expect(set.size).toBeLessThanOrEqual(90)
  })

  it('searches Turkish keywords by prefix, case-insensitively with the Turkish İ', () => {
    expect(searchEmoji('kalp').map((e) => e.emoji)).toContain('❤️')
    expect(searchEmoji('KAHK').map((e) => e.emoji)).toContain('😂')
    expect(searchEmoji('İYİ')).toEqual(searchEmoji('iyi'))
    expect(searchEmoji('xyzzy')).toEqual([])
    expect(searchEmoji('  ').length).toBe(ALL_EMOJI.length)
  })
})

function memory(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) }
}

describe('recent emoji', () => {
  it('most recent first, no duplicates, normalised, bounded', () => {
    const store = memory()
    pushRecent('👍', store)
    pushRecent('❤', store)
    pushRecent('👍', store)
    expect(loadRecent(store)).toEqual(['👍', '❤️'])
    for (let i = 0; i < 30; i += 1) pushRecent(String.fromCodePoint(0x1f600 + i), store)
    expect(loadRecent(store)).toHaveLength(MAX_RECENT)
    expect(loadRecent(store)[0]).toBe(String.fromCodePoint(0x1f600 + 29))
  })

  it('survives garbage and no storage', () => {
    const store = memory()
    store.setItem('trio.recentEmoji', '{bad')
    expect(loadRecent(store)).toEqual([])
    store.setItem('trio.recentEmoji', JSON.stringify([1, '', '👍', '👍']))
    expect(loadRecent(store)).toEqual(['👍'])
    expect(loadRecent(null)).toEqual([])
    expect(pushRecent('👍', null)).toEqual(['👍'])
  })
})
