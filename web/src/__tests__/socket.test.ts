import { describe, expect, it } from 'vitest'
import { backoffDelay, BACKOFF_CAP_MS, socketUrl } from '../socket'

describe('backoffDelay', () => {
  it('starts at one second and doubles', () => {
    expect([0, 1, 2, 3].map(backoffDelay)).toEqual([1000, 2000, 4000, 8000])
  })

  it('is capped at fifteen seconds', () => {
    expect(backoffDelay(4)).toBe(15000)
    expect(backoffDelay(5)).toBe(15000)
    expect(backoffDelay(50)).toBe(BACKOFF_CAP_MS)
    expect(backoffDelay(5000)).toBe(BACKOFF_CAP_MS)
  })

  it('never decreases and never leaves the range', () => {
    let previous = 0
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const delay = backoffDelay(attempt)
      expect(delay).toBeGreaterThanOrEqual(previous)
      expect(delay).toBeGreaterThanOrEqual(1000)
      expect(delay).toBeLessThanOrEqual(15000)
      previous = delay
    }
  })

  it('treats a nonsense attempt as the first', () => {
    expect(backoffDelay(-3)).toBe(1000)
    expect(backoffDelay(0.9)).toBe(1000)
  })
})

describe('socketUrl', () => {
  it('follows the page: ws on http, wss on https, same host', () => {
    expect(socketUrl('abc', { protocol: 'http:', host: 'localhost:5173' })).toBe(
      'ws://localhost:5173/ws?token=abc',
    )
    expect(socketUrl('abc', { protocol: 'https:', host: 'chat.example.com' })).toBe(
      'wss://chat.example.com/ws?token=abc',
    )
  })

  it('encodes the token', () => {
    expect(socketUrl('a b&c=d', { protocol: 'http:', host: 'h' })).toBe('ws://h/ws?token=a%20b%26c%3Dd')
  })
})
