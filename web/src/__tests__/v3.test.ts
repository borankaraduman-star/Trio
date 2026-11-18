import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachmentKind, sendErrorMessage, uploadErrorMessage } from '../lib/attachments'
import {
  formatCountdown,
  formatLinkCode,
  LINK_CODE_ALPHABET,
  linkCodeProblem,
  localExpiry,
  normalizeLinkCode,
  secondsLeft,
  tidyLinkCodeInput,
} from '../lib/linkCode'
import { formatWait, parseRetryAfter, rateLimitMessage } from '../lib/retryAfter'
import { CLOSE_TOO_MANY, CLOSE_UNAUTHORIZED, closeKind, TOO_MANY_NOTICE_AFTER, TrioSocket } from '../socket'
import { createInitialState, reducer, voiceChannelOf, type AppState } from '../store'
import { initialJoinMode } from '../components/JoinScreen'
import type { ServerEvent } from '../types'

describe('link codes', () => {
  it('groups a code in two fives', () => {
    expect(formatLinkCode('K7QX3MZ9PA')).toBe('K7QX3-MZ9PA')
    expect(formatLinkCode('k7qx3')).toBe('K7QX3')
    expect(formatLinkCode('K7QX3-MZ9PA')).toBe('K7QX3-MZ9PA')
  })

  it('normalises as the server does: case, spaces and dashes ignored', () => {
    expect(normalizeLinkCode('k7qx3-mz9pa')).toBe('K7QX3MZ9PA')
    expect(normalizeLinkCode(' K7QX3 MZ9PA ')).toBe('K7QX3MZ9PA')
    expect(normalizeLinkCode('K7Q X3-M Z9P-A')).toBe('K7QX3MZ9PA')
  })

  it('refuses what cannot be a code', () => {
    expect(normalizeLinkCode('K7QX3MZ9P')).toBeNull() // too short
    expect(normalizeLinkCode('K7QX3MZ9PAB')).toBeNull() // too long
    expect(normalizeLinkCode('K7QX3MZ9P0')).toBeNull() // 0 is not in the alphabet
    expect(normalizeLinkCode('O7QX3MZ9PI')).toBeNull()
    expect(normalizeLinkCode('K7QX3MZ9PA' + ' '.repeat(60))).toBeNull() // over 64 as typed
    expect(normalizeLinkCode('')).toBeNull()
  })

  it('the alphabet has no look-alikes', () => {
    for (const ch of '01OIL') expect(LINK_CODE_ALPHABET.includes(ch)).toBe(false)
    expect(LINK_CODE_ALPHABET).toHaveLength(31)
  })

  it('tidies the field while typing or pasting', () => {
    expect(tidyLinkCodeInput('k7q')).toBe('K7Q')
    expect(tidyLinkCodeInput('k7qx3m')).toBe('K7QX3-M')
    expect(tidyLinkCodeInput('k7qx3 - mz9pa')).toBe('K7QX3-MZ9PA')
    expect(tidyLinkCodeInput('K7QX3-MZ9PAXYZ')).toBe('K7QX3-MZ9PA')
    expect(tidyLinkCodeInput('')).toBe('')
  })

  it('names letters the alphabet lacks, and nothing else', () => {
    expect(linkCodeProblem('')).toBeNull()
    expect(linkCodeProblem('K7QX')).toBeNull()
    expect(linkCodeProblem('K7QX3-MZ9PA')).toBeNull()
    expect(linkCodeProblem('K0QX3-MZ9OA')).toMatch(/“0 O”/)
  })

  it('counts down on this device’s clock, corrected by the server’s Date header', () => {
    const received = Date.parse('2026-11-18T12:00:00Z')
    // Server clock 5 minutes ahead: the code still has its full 10 minutes here.
    const expiry = localExpiry('2026-11-18T12:15:00.000Z', 'Wed, 18 Nov 2026 12:05:00 GMT', received)
    // (The header's whole second is taken as its middle: 599.5 s, shown as 600.)
    expect(expiry - received).toBe(599_500)
    expect(secondsLeft(expiry, received)).toBe(600)
    // Never more than a code's life, whatever the clocks say.
    expect(secondsLeft(received + 650_000, received)).toBe(600)
    // No Date header: taken as it is.
    expect(localExpiry('2026-11-18T12:10:00Z', null, received)).toBe(Date.parse('2026-11-18T12:10:00Z'))
    expect(localExpiry('2026-11-18T12:10:00Z', 'nonsense', received)).toBe(Date.parse('2026-11-18T12:10:00Z'))
    // A broken expires_at is already expired.
    expect(secondsLeft(localExpiry('later', null, received), received)).toBe(0)
  })

  it('formats the countdown', () => {
    expect(formatCountdown(600)).toBe('10:00')
    expect(formatCountdown(599)).toBe('9:59')
    expect(formatCountdown(5)).toBe('0:05')
    expect(formatCountdown(-3)).toBe('0:00')
    expect(secondsLeft(10_500, 10_000)).toBe(1)
    expect(secondsLeft(10_000, 10_000)).toBe(0)
    expect(secondsLeft(5_000, 10_000)).toBe(0)
  })
})

describe('Retry-After', () => {
  const now = Date.parse('2026-11-18T12:00:00Z')

  it('reads seconds and HTTP dates', () => {
    expect(parseRetryAfter('8', now)).toBe(8)
    expect(parseRetryAfter(' 600 ', now)).toBe(600)
    expect(parseRetryAfter('0', now)).toBe(0)
    expect(parseRetryAfter('Wed, 18 Nov 2026 12:00:30 GMT', now)).toBe(30)
    expect(parseRetryAfter('Wed, 18 Nov 2026 11:00:00 GMT', now)).toBe(0)
  })

  it('is null when absent or unreadable', () => {
    expect(parseRetryAfter(null, now)).toBeNull()
    expect(parseRetryAfter(undefined, now)).toBeNull()
    expect(parseRetryAfter('', now)).toBeNull()
    expect(parseRetryAfter('-5', now)).toBeNull()
    expect(parseRetryAfter('soon', now)).toBeNull()
    expect(parseRetryAfter('1.5', now)).toBeNull()
  })

  it('says how long in Turkish, never too early', () => {
    expect(formatWait(8)).toBe('8 saniye')
    expect(formatWait(59)).toBe('59 saniye')
    expect(formatWait(60)).toBe('1 dakika')
    expect(formatWait(61)).toBe('2 dakika')
    expect(formatWait(600)).toBe('10 dakika')
    expect(formatWait(0)).toBe('1 saniye')
    expect(rateLimitMessage(8)).toBe('Çok fazla deneme yapıldı. 8 saniye sonra tekrar dene.')
    expect(rateLimitMessage(null)).toMatch(/Biraz sonra/)
    expect(rateLimitMessage(0)).toMatch(/şimdi tekrar/)
  })
})

describe('v3 attachments', () => {
  it('avif is an image; heic and quicktime are file rows', () => {
    expect(attachmentKind('image/avif')).toBe('image')
    expect(attachmentKind('image/heic')).toBe('file')
    expect(attachmentKind('video/quicktime')).toBe('file')
  })

  it('words the new upload and send errors', () => {
    expect(uploadErrorMessage('QUOTA_EXCEEDED')).toMatch(/kota/i)
    expect(uploadErrorMessage('UPLOAD_IN_PROGRESS')).toMatch(/başka bir sekmede/i)
    expect(uploadErrorMessage('STORAGE_FULL')).toMatch(/disk/i)
    expect(sendErrorMessage('STORAGE_FULL')).toMatch(/mesaj kaydedilemedi/)
    expect(sendErrorMessage('BAD_REQUEST')).toBeNull()
  })
})

describe('the join screen’s first mode', () => {
  it('leads with "Zaten hesabım var" in the desktop app and after a session ended', () => {
    expect(initialJoinMode({ desktop: false, sessionEnded: false })).toBe('invite')
    expect(initialJoinMode({ desktop: true, sessionEnded: false })).toBe('link')
    expect(initialJoinMode({ desktop: false, sessionEnded: true })).toBe('link')
  })
})

describe('user.removed', () => {
  const ready: ServerEvent = {
    type: 'ready',
    user: { id: 1, name: 'Ada' },
    users: [
      { id: 1, name: 'Ada', online: true },
      { id: 2, name: 'Bora', online: true },
      { id: 3, name: 'Cem', online: false },
    ],
    channels: [
      { id: 10, name: 'genel', kind: 'text' },
      { id: 20, name: 'Sohbet', kind: 'voice' },
    ],
    voice: {
      '20': [
        { user_id: 1, muted: false, deafened: false, screensharing: false },
        { user_id: 2, muted: false, deafened: false, screensharing: false },
      ],
    },
  }
  const event = (e: ServerEvent, state: AppState, now = 1000) => reducer(state, { type: 'server', event: e, now, viewing: true })

  function setup(): AppState {
    let state = event(ready, createInitialState({ me: { id: 1, name: 'Ada' } }))
    state = event(
      {
        type: 'message.new',
        message: { id: 5, channel_id: 10, author: { id: 2, name: 'Bora' }, content: 'selam', created_at: 't', attachments: [] },
      },
      state,
    )
    return event({ type: 'typing', channel_id: 10, user_id: 2 }, state)
  }

  it('drops the user from the members, the voice room and typing, and keeps the messages', () => {
    const before = setup()
    expect(voiceChannelOf(before, 2)).toBe(20)
    const after = event({ type: 'user.removed', user_id: 2 }, before)
    expect(after.users[2]).toBeUndefined()
    expect(Object.keys(after.users).map(Number)).toEqual([1, 3])
    expect(after.voice[20].map((p) => p.user_id)).toEqual([1])
    expect(voiceChannelOf(after, 2)).toBeNull()
    expect(after.typing[10][2]).toBeUndefined()
    expect(after.messages[10].items.map((m) => [m.author.name, m.content])).toEqual([['Bora', 'selam']])
  })

  it('ignores an unknown user, and never removes me from my own list', () => {
    const before = setup()
    expect(event({ type: 'user.removed', user_id: 99 }, before)).toBe(before)
    expect(event({ type: 'user.removed', user_id: 1 }, before)).toBe(before)
  })
})

describe('close codes', () => {
  it('classifies them', () => {
    expect(closeKind(CLOSE_UNAUTHORIZED)).toBe('unauthorized')
    expect(closeKind(CLOSE_TOO_MANY)).toBe('too-many')
    expect(closeKind(1006)).toBe('drop')
    expect(closeKind(1000)).toBe('drop')
    expect(closeKind(1009)).toBe('drop')
  })
})

/** A WebSocket the test drives: `server.open()`, `server.message()`, `server.close(code)`. */
class FakeSocket {
  static all: FakeSocket[] = []
  static OPEN = 1
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((m: { data: string }) => void) | null = null
  onclose: ((c: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  sent: string[] = []
  constructor(readonly url: string) {
    FakeSocket.all.push(this)
  }
  send(data: string) {
    this.sent.push(data)
  }
  close() {
    this.readyState = 3
  }
  open() {
    this.readyState = 1
    this.onopen?.()
  }
  message(frame: object) {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
  shut(code: number) {
    this.readyState = 3
    this.onclose?.({ code })
  }
}

describe('TrioSocket and the server ending things', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    FakeSocket.all = []
  })

  function start() {
    vi.useFakeTimers()
    vi.stubGlobal('WebSocket', FakeSocket)
    vi.stubGlobal('window', { location: { protocol: 'http:', host: 'h' } })
    const calls: string[] = []
    const socket = new TrioSocket('tok')
    socket.handlers = {
      onDown: () => calls.push('down'),
      onUnauthorized: () => calls.push('unauthorized'),
      onTooMany: (streak) => calls.push(`too-many ${streak}`),
      onEvent: (event) => calls.push(event.type),
    }
    socket.connect()
    return { socket, calls }
  }

  it('4401 after the session was up ends it, with no reconnect', () => {
    const { calls } = start()
    const ws = FakeSocket.all[0]
    ws.open()
    ws.message({ type: 'ready' })
    ws.shut(4401)
    expect(calls).toEqual(['ready', 'unauthorized'])
    vi.advanceTimersByTime(60_000)
    expect(FakeSocket.all).toHaveLength(1)
  })

  it('4429 is a drop with growing backoff; repeated, it is reported, and a connection that gets through clears it', () => {
    const { calls } = start()
    // Accepted, then closed at once: the backoff must not start over on `open`.
    FakeSocket.all[0].open()
    FakeSocket.all[0].shut(4429)
    expect(calls).toEqual(['down'])
    vi.advanceTimersByTime(999)
    expect(FakeSocket.all).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(FakeSocket.all).toHaveLength(2)
    FakeSocket.all[1].open()
    FakeSocket.all[1].shut(4429)
    expect(calls).toEqual(['down', `too-many ${TOO_MANY_NOTICE_AFTER}`, 'down'])
    // The second retry waits 2 s, not 1 s.
    vi.advanceTimersByTime(1999)
    expect(FakeSocket.all).toHaveLength(2)
    vi.advanceTimersByTime(1)
    expect(FakeSocket.all).toHaveLength(3)
    FakeSocket.all[2].open()
    FakeSocket.all[2].message({ type: 'ready' })
    expect(calls.slice(3)).toEqual(['too-many 0', 'ready'])
  })

  it('a single 4429 is not reported', () => {
    const { calls } = start()
    FakeSocket.all[0].open()
    FakeSocket.all[0].shut(4429)
    vi.advanceTimersByTime(1000)
    FakeSocket.all[1].open()
    FakeSocket.all[1].message({ type: 'ready' })
    expect(calls).toEqual(['down', 'ready'])
  })
})
