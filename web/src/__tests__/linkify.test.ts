import { describe, expect, it } from 'vitest'
import { linkify } from '../lib/linkify'

const links = (text: string) =>
  linkify(text).flatMap((part) => (part.type === 'link' ? [part.value] : []))

describe('linkify', () => {
  it('returns plain text unchanged', () => {
    expect(linkify('merhaba dünya')).toEqual([{ type: 'text', value: 'merhaba dünya' }])
    expect(linkify('')).toEqual([])
  })

  it('splits text around a link', () => {
    expect(linkify('bak https://example.com/a?b=1#c şuna')).toEqual([
      { type: 'text', value: 'bak ' },
      { type: 'link', value: 'https://example.com/a?b=1#c', href: 'https://example.com/a?b=1#c' },
      { type: 'text', value: ' şuna' },
    ])
  })

  it('finds several links and http as well as https', () => {
    expect(links('http://a.example https://b.example/x')).toEqual([
      'http://a.example',
      'https://b.example/x',
    ])
  })

  it('leaves sentence punctuation outside the link', () => {
    expect(links('Bu: https://example.com/a.')).toEqual(['https://example.com/a'])
    expect(links('(bkz. https://example.com/a)')).toEqual(['https://example.com/a'])
    expect(links('https://example.com/a!?')).toEqual(['https://example.com/a'])
    expect(linkify('git https://example.com, sonra').at(-1)).toEqual({
      type: 'text',
      value: ', sonra',
    })
  })

  it('keeps balanced brackets that belong to the address', () => {
    expect(links('https://tr.wikipedia.org/wiki/Ankara_(il)')).toEqual([
      'https://tr.wikipedia.org/wiki/Ankara_(il)',
    ])
    expect(links('(https://tr.wikipedia.org/wiki/Ankara_(il))')).toEqual([
      'https://tr.wikipedia.org/wiki/Ankara_(il)',
    ])
  })

  it('never links another scheme', () => {
    for (const text of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:x',
      'file:///etc/passwd',
      'ftp://example.com/x',
      'www.example.com',
    ]) {
      expect(links(text), text).toEqual([])
    }
  })

  it('does not start a link in the middle of a word', () => {
    expect(links('xhttps://example.com')).toEqual([])
    expect(links('javascript:https://example.com')).toEqual(['https://example.com'])
  })

  it('keeps markup as text and stops a link at a quote or angle bracket', () => {
    const parts = linkify('<img src=x onerror=alert(1)> <a href="https://evil.example">x</a>')
    expect(parts.map((part) => part.value).join('')).toBe(
      '<img src=x onerror=alert(1)> <a href="https://evil.example">x</a>',
    )
    expect(links('<a href="https://evil.example">x</a>')).toEqual(['https://evil.example'])
    for (const part of parts) {
      if (part.type === 'link') expect(part.href).toMatch(/^https?:\/\//)
    }
  })

  it('rejects a scheme with no host', () => {
    expect(links('https://')).toEqual([])
    expect(links('http:// boş')).toEqual([])
  })

  it('always reassembles to the original text', () => {
    const text = 'a https://x.example/1, b (http://y.example/2). c\nhttps://z.example'
    expect(linkify(text).map((part) => part.value).join('')).toBe(text)
  })
})
