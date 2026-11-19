import { describe, expect, it } from 'vitest'
import { deviceLinkUrl, hashWithoutDeviceCode, parseDeviceFragment } from '../lib/deviceLink'
import { qrModules } from '../components/reading/QrCode'
import { initialJoinMode } from '../components/JoinScreen'

describe('device links', () => {
  it('puts the code in the fragment and reads it back normalised', () => {
    const url = deviceLinkUrl('https://trio.example', 'K7QX3MZ9PA')
    expect(url).toBe('https://trio.example/#cihaz=K7QX3MZ9PA')
    expect(parseDeviceFragment(new URL(url).hash)).toBe('K7QX3MZ9PA')
    expect(parseDeviceFragment('#cihaz=k7qx3-mz9pa')).toBe('K7QX3MZ9PA')
    expect(parseDeviceFragment('#device=K7QX3MZ9PA&x=1')).toBe('K7QX3MZ9PA')
  })
  it('refuses what cannot be a code, and takes only its own key out of the hash', () => {
    expect(parseDeviceFragment('#cihaz=0000')).toBeNull()
    expect(parseDeviceFragment('#davet=abc')).toBeNull()
    expect(parseDeviceFragment('')).toBeNull()
    expect(hashWithoutDeviceCode('#cihaz=K7QX3MZ9PA')).toBe('')
    expect(hashWithoutDeviceCode('#cihaz=K7QX3MZ9PA&davet=x')).toBe('#davet=x')
  })
  it('a device link opens the join screen on "Zaten hesabım var"', () => {
    expect(initialJoinMode({ desktop: false, sessionEnded: false, inviteLink: true, deviceLink: true })).toBe('link')
  })
})

describe('qrModules', () => {
  it('is a square with the three finder patterns', () => {
    const modules = qrModules('https://trio.example/#cihaz=K7QX3MZ9PA')
    const n = modules.length
    expect(n).toBe(29) // version 3 at level M
    expect(modules.every((row) => row.length === n)).toBe(true)
    for (const [r, c] of [
      [0, 0],
      [0, n - 7],
      [n - 7, 0],
    ]) {
      expect(modules[r].slice(c, c + 7).every(Boolean)).toBe(true) // the finder's top edge
      expect(modules[r + 1][c + 1]).toBe(false)
      expect(modules[r + 3][c + 3]).toBe(true) // its centre
    }
  })
})
