import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STABLE_AFTER_MS, TrioSocket } from '../socket'

/** Just enough of a browser WebSocket for TrioSocket, driven by the test. */
class FakeWebSocket {
  static readonly OPEN = 1
  static instances: FakeWebSocket[] = []
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((message: { data: string }) => void) | null = null
  onclose: ((close: { code: number }) => void) | null = null
  onerror: (() => void) | null = null
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this)
  }
  send(): void {}
  close(): void {}
  accept(): void {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }
  frame(event: unknown): void {
    this.onmessage?.({ data: JSON.stringify(event) })
  }
  drop(code = 1006): void {
    this.readyState = 3
    this.onclose?.({ code })
  }
}

const READY = { type: 'ready', user: { id: 1, name: 'a' }, users: [], channels: [], voice: {} }

/** The time between each connection attempt, while every one is accepted and closed at once. */
function delaysWhile(behave: (ws: FakeWebSocket) => void, attempts: number): number[] {
  const socket = new TrioSocket('t')
  socket.connect()
  const delays: number[] = []
  for (let i = 0; i < attempts; i += 1) {
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]
    behave(ws)
    const before = FakeWebSocket.instances.length
    const started = Date.now()
    for (let waited = 0; FakeWebSocket.instances.length === before && waited < 60_000; waited += 100) {
      vi.advanceTimersByTime(100)
    }
    delays.push(Date.now() - started)
  }
  socket.close()
  return delays
}

describe('TrioSocket backoff', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    FakeWebSocket.instances = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal('window', { location: { protocol: 'http:', host: 'h' } })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('keeps backing off when the server accepts and closes at once (4429, a crash after accept)', () => {
    const delays = delaysWhile((ws) => {
      ws.accept()
      ws.drop(4429)
    }, 6)
    expect(delays).toEqual([1000, 2000, 4000, 8000, 15000, 15000])
  })

  it('keeps backing off when ready arrives but the connection dies right after', () => {
    const delays = delaysWhile((ws) => {
      ws.accept()
      ws.frame(READY)
      vi.advanceTimersByTime(STABLE_AFTER_MS - 100)
      ws.drop()
    }, 4)
    // Each wait includes the time the connection was up before it dropped.
    expect(delays).toEqual([1000, 2000, 4000, 8000])
  })

  it('starts again from one second after a connection that was useful', () => {
    const delays = delaysWhile((ws) => {
      ws.accept()
      ws.frame(READY)
      vi.advanceTimersByTime(STABLE_AFTER_MS)
      ws.drop()
    }, 3)
    expect(delays).toEqual([1000, 1000, 1000])
  })

  it('gives up for good on 4401 and does not reconnect', () => {
    const socket = new TrioSocket('t')
    const unauthorized = vi.fn()
    socket.handlers = { onUnauthorized: unauthorized }
    socket.connect()
    FakeWebSocket.instances[0].accept()
    FakeWebSocket.instances[0].drop(4401)
    vi.advanceTimersByTime(60_000)
    expect(unauthorized).toHaveBeenCalledOnce()
    expect(FakeWebSocket.instances).toHaveLength(1)
  })
})
