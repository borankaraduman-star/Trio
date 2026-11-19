import { describe, expect, it } from 'vitest'
import { entryScript } from '../lib/buildCheck'

describe('entryScript', () => {
  it('finds the hashed module entry in a Vite index.html', () => {
    const html = '<head><script type="module" crossorigin src="/assets/index-9rxOsY4f.js"></script>' +
      '<link rel="stylesheet" crossorigin href="/assets/index-KxdKLErF.css"></head>'
    expect(entryScript(html)).toBe('/assets/index-9rxOsY4f.js')
  })
  it('is null when there is no module script', () => {
    expect(entryScript('<html><body>hi</body></html>')).toBeNull()
  })
})
