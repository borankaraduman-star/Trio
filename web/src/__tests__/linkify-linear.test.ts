import { describe, expect, it } from 'vitest'
import { linkify, trimTrailing } from '../lib/linkify'

const links = (text: string) =>
  linkify(text).flatMap((part) => (part.type === 'link' ? [part.value] : []))

function time(fn: () => void): number {
  const start = performance.now()
  fn()
  return performance.now() - start
}

describe('linkify is linear', () => {
  it('opens a channel of 50 bracket-heavy 4000-character messages quickly', () => {
    // The reviewer's case: ~90 ms per message with the quadratic trim, 3.7 s per channel.
    const message = 'http://a.b/' + ')'.repeat(4000 - 'http://a.b/'.length)
    linkify(message) // warm up the JIT
    const elapsed = time(() => {
      for (let i = 0; i < 50; i += 1) linkify(message)
    })
    // Generous: linear is ~1-5 ms here; quadratic was seconds.
    expect(elapsed).toBeLessThan(400)
  })

  it('stays linear on a very long input (the quadratic trim takes ~10 s here)', () => {
    const message = 'http://a.b/' + ')'.repeat(40_000)
    const elapsed = time(() => {
      expect(links(message)).toEqual(['http://a.b/'])
    })
    expect(elapsed).toBeLessThan(400)
  })

  it('looks at each character of the candidate a bounded number of times', () => {
    // Operation count: wrap the candidate so that every character read is counted.
    for (const n of [100, 1000, 10_000]) {
      const candidate = 'http://a.b/' + ')'.repeat(n)
      let reads = 0
      const counted = new Proxy(
        { length: candidate.length },
        {
          get(target, key) {
            if (key === 'length') return target.length
            if (key === 'slice') {
              return (start: number, end: number) => {
                const result = candidate.slice(start, end)
                reads += result.length
                return result
              }
            }
            if (typeof key === 'string' && /^\d+$/.test(key)) {
              reads += 1
              return candidate[Number(key)]
            }
            return undefined
          },
        },
      ) as unknown as string
      expect(trimTrailing(counted)).toBe('http://a.b/')
      expect(reads).toBeLessThanOrEqual(3 * candidate.length)
    }
  })
})

describe('linkify correctness', () => {
  it('keeps balanced parentheses of Wikipedia-style addresses', () => {
    expect(links('https://en.wikipedia.org/wiki/Mercury_(planet)')).toEqual([
      'https://en.wikipedia.org/wiki/Mercury_(planet)',
    ])
    expect(links('https://en.wikipedia.org/wiki/A_(b)_(c)')).toEqual([
      'https://en.wikipedia.org/wiki/A_(b)_(c)',
    ])
    expect(links('https://example.com/a_((b))')).toEqual(['https://example.com/a_((b))'])
    expect(links('https://example.com/x[1]')).toEqual(['https://example.com/x[1]'])
    expect(links('https://example.com/{id}')).toEqual(['https://example.com/{id}'])
  })

  it('drops unbalanced closing brackets and trailing punctuation', () => {
    expect(links('(bkz. https://en.wikipedia.org/wiki/Mercury_(planet))')).toEqual([
      'https://en.wikipedia.org/wiki/Mercury_(planet)',
    ])
    expect(links('(https://example.com/a).')).toEqual(['https://example.com/a'])
    expect(links('[https://example.com/a]')).toEqual(['https://example.com/a'])
    expect(links('https://example.com/a)))')).toEqual(['https://example.com/a'])
    expect(links('https://example.com/a...')).toEqual(['https://example.com/a'])
    expect(links('https://example.com/a?!')).toEqual(['https://example.com/a'])
    expect(links('«https://example.com/a»')).toEqual(['https://example.com/a'])
    expect(links('“https://example.com/a”')).toEqual(['https://example.com/a'])
    expect(links('https://example.com/a);')).toEqual(['https://example.com/a'])
  })

  it('keeps punctuation inside the address', () => {
    expect(links('https://example.com/a.b,c;d:e!f?g=1')).toEqual([
      'https://example.com/a.b,c;d:e!f?g=1',
    ])
  })

  it('handles Turkish characters and internationalised domains', () => {
    expect(links('şuna bak: https://tr.wikipedia.org/wiki/İstanbul_Boğazı, güzel')).toEqual([
      'https://tr.wikipedia.org/wiki/İstanbul_Boğazı',
    ])
    const parts = linkify('https://çiçek.com.tr/yol?ğ=ü.')
    const link = parts.find((part) => part.type === 'link')
    expect(link).toMatchObject({ value: 'https://çiçek.com.tr/yol?ğ=ü' })
    expect(link && 'href' in link ? link.href : '').toMatch(/^https:\/\/xn--[a-z0-9-]+\.com\.tr\/yol\?/)
    expect(links('http://münchen.de/ı')).toEqual(['http://münchen.de/ı'])
  })

  it('handles many links, and long text, and still reassembles exactly', () => {
    const text = Array.from({ length: 500 }, (_, i) => `(https://e${i}.example/w_(x)) ve `).join('')
    const parts = linkify(text)
    expect(parts.map((part) => part.value).join('')).toBe(text)
    expect(parts.filter((part) => part.type === 'link')).toHaveLength(500)
    expect(links(text)[7]).toBe('https://e7.example/w_(x)')
  })

  it('trims nothing from an address without trailing punctuation', () => {
    expect(trimTrailing('https://example.com/a')).toBe('https://example.com/a')
    expect(trimTrailing(')))')).toBe('')
    expect(trimTrailing('')).toBe('')
  })
})
