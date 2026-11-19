import { afterEach, describe, expect, it, vi } from 'vitest'
import { hashWithoutInvite, inviteLinkUrl, parseInviteFragment } from '../lib/inviteLink'
import { initialJoinMode } from '../components/JoinScreen'

describe('parseInviteFragment', () => {
  it('reads both keys, with or without the #', () => {
    expect(parseInviteFragment('#davet=gizli-kod')).toBe('gizli-kod')
    expect(parseInviteFragment('#invite=gizli-kod')).toBe('gizli-kod')
    expect(parseInviteFragment('davet=gizli-kod')).toBe('gizli-kod')
  })

  it('URL-decodes the code', () => {
    expect(parseInviteFragment('#davet=%C3%A7ay%20saati%2B1%26%3D')).toBe('çay saati+1&=')
    expect(parseInviteFragment(`#davet=${encodeURIComponent('kod/ğüş?#')}`)).toBe('kod/ğüş?#')
  })

  it('is null when there is no code, or an empty one', () => {
    expect(parseInviteFragment('')).toBeNull()
    expect(parseInviteFragment('#')).toBeNull()
    expect(parseInviteFragment('#davet=')).toBeNull()
    expect(parseInviteFragment('#davet=%20%20')).toBeNull()
    expect(parseInviteFragment('#kanal=genel')).toBeNull()
    expect(parseInviteFragment('#davetiye=x')).toBeNull()
  })

  it('finds the code among other parameters; davet wins over invite', () => {
    expect(parseInviteFragment('#x=1&davet=abc&y=2')).toBe('abc')
    expect(parseInviteFragment('#invite=eng&davet=tr')).toBe('tr')
    expect(parseInviteFragment('#invite=&davet=tr')).toBe('tr')
  })

  it('takes the invite out and keeps the rest of the fragment', () => {
    expect(hashWithoutInvite('#davet=abc')).toBe('')
    expect(hashWithoutInvite('#x=1&davet=abc&invite=d')).toBe('#x=1')
  })

  it('makes a link that reads back to the same code', () => {
    for (const code of ['trio-e2e-davet', 'çay saati+1&=', 'a#b?c/d']) {
      const link = inviteLinkUrl('https://trio.example', code)
      expect(link.startsWith('https://trio.example/#davet=')).toBe(true)
      expect(link).not.toContain('?')
      expect(parseInviteFragment(new URL(link).hash)).toBe(code)
    }
  })
})

describe('takeInviteFromLocation', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('reads the code once, removes it from the address bar, and answers the same afterwards', async () => {
    const replaced: string[] = []
    vi.stubGlobal('window', {
      location: { hash: '#davet=abc&tema=koyu', pathname: '/', search: '' },
      history: { state: null, replaceState: (_s: unknown, _t: string, url: string) => replaced.push(url) },
    })
    const { takeInviteFromLocation } = await import('../lib/inviteLink')
    expect(takeInviteFromLocation()).toBe('abc')
    expect(takeInviteFromLocation()).toBe('abc')
    expect(replaced).toEqual(['/#tema=koyu'])
  })

  it('leaves an address with no invite alone', async () => {
    const replaced: string[] = []
    vi.stubGlobal('window', {
      location: { hash: '', pathname: '/', search: '' },
      history: { state: null, replaceState: (_s: unknown, _t: string, url: string) => replaced.push(url) },
    })
    const { takeInviteFromLocation } = await import('../lib/inviteLink')
    expect(takeInviteFromLocation()).toBeNull()
    expect(replaced).toEqual([])
  })
})

describe('an invite link and the join mode', () => {
  it('opens the invite form even in the desktop app', () => {
    expect(initialJoinMode({ desktop: true, sessionEnded: false, inviteLink: true })).toBe('invite')
    expect(initialJoinMode({ desktop: true, sessionEnded: false, inviteLink: false })).toBe('link')
  })
})
