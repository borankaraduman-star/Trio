import { describe, expect, it } from 'vitest'
import { checkLength, codePoints, MAX_MESSAGE_LENGTH, serverStrip } from '../lib/messageLength'

describe('serverStrip (Python str.strip)', () => {
  it('trims what Python trims, including what JavaScript trim() keeps', () => {
    expect(serverStrip('  a b \n')).toBe('a b')
    expect(serverStrip('\u0085a\u001c')).toBe('a') // NEL and the file separators
    expect(serverStrip('　a ')).toBe('a')
  })

  it('keeps what Python keeps, including what JavaScript trim() removes', () => {
    expect(serverStrip('﻿a﻿')).toBe('﻿a﻿') // BOM is not Python whitespace
    expect(serverStrip('​a')).toBe('​a') // zero-width space neither
    expect(serverStrip('a  b')).toBe('a  b')
  })
})

describe('codePoints (Python len)', () => {
  it('counts code points, not UTF-16 units', () => {
    expect(codePoints('abc')).toBe(3)
    expect(codePoints('😀')).toBe(1) // '😀'.length === 2
    expect(codePoints('🇹🇷')).toBe(2) // a flag is two regional indicators
    expect(codePoints('👨‍👩‍👧')).toBe(5) // three people and two joiners
    expect(codePoints('é')).toBe(2) // a combining accent is its own code point (no NFC)
    expect(codePoints('ş')).toBe(1)
    expect(codePoints('\ud800')).toBe(1) // a lone surrogate, as Python counts it
  })
})

describe('checkLength', () => {
  it('the limit is inclusive and counted after the trim', () => {
    expect(checkLength('a'.repeat(MAX_MESSAGE_LENGTH)).over).toBe(0)
    expect(checkLength(`  ${'a'.repeat(MAX_MESSAGE_LENGTH)}\n\n`).over).toBe(0)
    expect(checkLength('a'.repeat(MAX_MESSAGE_LENGTH + 1)).over).toBe(1)
  })

  it('3999 letters and an emoji fit (4001 UTF-16 units, 4000 code points)', () => {
    const text = `${'a'.repeat(3999)}😀`
    expect(text.length).toBe(4001)
    expect(checkLength(text)).toMatchObject({ length: 4000, over: 0 })
  })

  it('shows the counter from 200 below the limit', () => {
    expect(checkLength('a'.repeat(3799)).showCounter).toBe(false)
    expect(checkLength('a'.repeat(3800)).showCounter).toBe(true)
    expect(checkLength('a'.repeat(5000)).showCounter).toBe(true)
  })
})
