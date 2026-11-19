import { describe, expect, it, vi } from 'vitest'
import { browserName, buildReport, classifyTurn, lossText, probeTurn, rttText, scrubReport } from '../lib/connReport'

describe('scrubReport', () => {
  it('removes IPv4, IPv6 and mDNS addresses, tokens and long opaque strings', () => {
    const text = [
      'candidate:1 1 udp 2122 192.168.1.20 54321 typ host',
      'srflx 2001:db8::1 and fe80:0:0:0:200:f8ff:fe21:67cf',
      'host 1f2e3d4c-aaaa-bbbb-cccc-0123456789ab.local',
      'wss://trio.example/ws?token=abc.def',
      'opaque eyJhbGciOiJIUzI1NiJ9eyJzdWIiOiIxMjM0NTY3ODkwIn0',
    ].join('\n')
    const clean = scrubReport(text)
    expect(clean).not.toMatch(/192\.168|2001:db8|fe80|\.local|abc\.def|eyJhbG/)
    expect(clean).toContain('[adres]')
    expect(clean).toContain('token=[gizli]')
  })

  it('leaves times, percentages and Turkish words alone', () => {
    const text = 'Zaman: 2026-11-19T02:49:32Z\nKayıp %0,4 · gidiş-dönüş 23 ms · Ayşe: doğrudan'
    expect(scrubReport(text)).toBe(text)
  })
})

describe('buildReport', () => {
  const facts = {
    at: new Date('2026-11-19T02:49:32.123Z'),
    version: 'istemci 9rxOsY4f',
    browser: 'Chrome 157',
    micLevel: 0.4,
    turn: 'unconfigured' as const,
    inVoice: true,
    peers: [
      { userId: 2, name: 'Mehmet', path: 'direct' as const, rtt: 0.0234, packetsLost: 1, packetsReceived: 999 },
      { userId: 3, name: 'Zeynep', path: 'relay' as const, rtt: null, packetsLost: null, packetsReceived: null },
    ],
  }

  it('says what was measured, with display names and nothing else identifying', () => {
    const text = buildReport(facts)
    expect(text).toContain('Zaman: 2026-11-19T02:49:32Z')
    expect(text).toContain('TURN: TURN yapılandırılmamış')
    expect(text).toContain('Mikrofon seviyesi: %40')
    expect(text).toContain('- Mehmet: doğrudan, gidiş-dönüş 23 ms, kayıp %0,1')
    expect(text).toContain('- Zeynep: aktarma (TURN), gidiş-dönüş —, kayıp —')
    expect(text).not.toMatch(/\d+\.\d+\.\d+\.\d+/)
    // No user ids in it either.
    expect(text).not.toMatch(/\b[23]\b(?! ms)/)
  })

  it('a name shaped like an address is scrubbed too', () => {
    const text = buildReport({ ...facts, peers: [{ ...facts.peers[0], name: '10.0.0.1' }] })
    expect(text).not.toContain('10.0.0.1')
  })

  it('outside voice it says so', () => {
    expect(buildReport({ ...facts, inVoice: false, peers: [] })).toContain('Ses odası: değil')
  })
})

describe('formatting', () => {
  it('rtt, loss and the browser', () => {
    expect(rttText(0.0456)).toBe('46 ms')
    expect(rttText(null)).toBe('—')
    expect(lossText(0, 0)).toBe('—')
    expect(lossText(5, 95)).toBe('%5,0')
    expect(browserName('Mozilla/5.0 (X11) AppleWebKit Chrome/157.0.0.0 Safari/537.36')).toBe('Chrome 157')
    expect(browserName('x Electron/33.1 Chrome/130')).toBe('Trio masaüstü (Electron) 33')
    expect(browserName('???')).toBe('bilinmiyor')
  })
})

describe('the TURN probe', () => {
  it('classifies', () => {
    expect(classifyTurn(false, false, true)).toBe('unconfigured')
    expect(classifyTurn(true, true, false)).toBe('working')
    expect(classifyTurn(true, false, true)).toBe('unreachable')
  })

  it('without a TURN server it builds no connection', async () => {
    const create = vi.fn()
    expect(await probeTurn([{ urls: 'stun:x' }], false, create)).toBe('unconfigured')
    expect(create).not.toHaveBeenCalled()
  })

  function fakePc(candidates: (string | null)[]) {
    const pc = {
      onicecandidate: null as ((e: { candidate: { type?: string; candidate: string } | null }) => void) | null,
      createDataChannel: vi.fn(),
      createOffer: vi.fn(async () => ({ type: 'offer', sdp: '' })),
      setLocalDescription: vi.fn(async () => {
        for (const c of candidates) pc.onicecandidate?.({ candidate: c === null ? null : { candidate: c } })
      }),
      close: vi.fn(),
    }
    return pc
  }

  it('a relay candidate means it works, and the connection is closed', async () => {
    const pc = fakePc(['candidate:1 1 udp 1 1.2.3.4 9 typ relay raddr 0.0.0.0 rport 0'])
    expect(await probeTurn([], true, () => pc as unknown as RTCPeerConnection)).toBe('working')
    expect(pc.close).toHaveBeenCalled()
  })

  it('gathering ending with no relay, or nothing in time, is unreachable', async () => {
    expect(await probeTurn([], true, () => fakePc([null]) as unknown as RTCPeerConnection)).toBe('unreachable')
    expect(await probeTurn([], true, () => fakePc([]) as unknown as RTCPeerConnection, 20)).toBe('unreachable')
  })
})
