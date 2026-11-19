import type { ClientEvent, ServerEvent } from './types'

export const BACKOFF_BASE_MS = 1000
export const BACKOFF_CAP_MS = 15000
export const PING_INTERVAL_MS = 25000
const PONG_TIMEOUT_MS = 10000
const CLOSE_UNAUTHORIZED = 4401
/** A connection counts as healthy (and resets the backoff) once `ready` came and it stayed up this long. */
export const STABLE_AFTER_MS = 5000

/** Delay before reconnect attempt `attempt` (0-based): 1 s, 2 s, 4 s, 8 s, then 15 s. */
export function backoffDelay(attempt: number): number {
  const exponent = Math.max(0, Math.floor(attempt))
  // 2 ** 20 seconds is already far past the cap; avoid Infinity for huge counts.
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.min(exponent, 20))
}

export function socketUrl(token: string, location: { protocol: string; host: string }): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${location.host}/ws?token=${encodeURIComponent(token)}`
}

export interface SocketHandlers {
  onEvent?: (event: ServerEvent) => void
  /** The connection opened (the `ready` frame follows). */
  onOpen?: () => void
  /** The connection was lost; a reconnect is scheduled. */
  onDown?: () => void
  /** The server closed with 4401: the token is not valid. No reconnect. */
  onUnauthorized?: () => void
}

/** A WebSocket that reconnects with backoff and keeps itself alive with pings. */
export class TrioSocket {
  handlers: SocketHandlers = {}

  private ws: WebSocket | null = null
  private attempt = 0
  private stopped = true
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private pongTimer: ReturnType<typeof setTimeout> | null = null
  private stableTimer: ReturnType<typeof setTimeout> | null = null
  private lastFrameAt = 0

  constructor(private readonly token: string) {}

  connect(): void {
    if (!this.stopped) return
    this.stopped = false
    this.attempt = 0
    this.open()
  }

  /** False when the frame could not be sent (no open connection). */
  send(event: ClientEvent): boolean {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    try {
      ws.send(JSON.stringify(event))
      return true
    } catch {
      return false
    }
  }

  close(): void {
    this.stopped = true
    this.clearTimers()
    const ws = this.ws
    this.ws = null
    if (ws) {
      try {
        ws.close()
      } catch {
        // Already closed.
      }
    }
  }

  private open(): void {
    let ws: WebSocket
    try {
      ws = new WebSocket(socketUrl(this.token, window.location))
    } catch {
      this.scheduleRetry()
      return
    }
    this.ws = ws

    ws.onopen = () => {
      if (this.ws !== ws) return
      this.lastFrameAt = Date.now()
      this.startPing(ws)
      this.handlers.onOpen?.()
    }
    ws.onmessage = (message) => {
      if (this.ws !== ws) return
      this.lastFrameAt = Date.now()
      let event: ServerEvent
      try {
        const parsed: unknown = JSON.parse(String(message.data))
        if (typeof parsed !== 'object' || parsed === null) return
        if (typeof (parsed as { type?: unknown }).type !== 'string') return
        event = parsed as ServerEvent
      } catch {
        return
      }
      if (event.type === 'pong') return
      // Not on open: a server that accepts and closes at once must still back off.
      if (event.type === 'ready' && !this.stableTimer) {
        this.stableTimer = setTimeout(() => (this.attempt = 0), STABLE_AFTER_MS)
      }
      this.handlers.onEvent?.(event)
    }
    ws.onclose = (close) => this.handleClose(ws, close.code)
    ws.onerror = () => {
      // `close` always follows; nothing to do here.
    }
  }

  private handleClose(ws: WebSocket, code: number): void {
    if (this.ws !== ws) return
    this.ws = null
    this.clearTimers()
    if (code === CLOSE_UNAUTHORIZED) {
      this.stopped = true
      this.handlers.onUnauthorized?.()
      return
    }
    if (this.stopped) return
    this.handlers.onDown?.()
    this.scheduleRetry()
  }

  private scheduleRetry(): void {
    if (this.stopped) return
    const delay = backoffDelay(this.attempt)
    this.attempt += 1
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (!this.stopped) this.open()
    }, delay)
  }

  private startPing(ws: WebSocket): void {
    this.pingTimer = setInterval(() => {
      const sentAt = Date.now()
      if (!this.send({ type: 'ping' })) return
      if (this.pongTimer) clearTimeout(this.pongTimer)
      this.pongTimer = setTimeout(() => {
        this.pongTimer = null
        // Nothing at all since the ping: the connection is dead even if the
        // browser has not noticed. Drop it now instead of waiting for TCP.
        if (this.ws === ws && this.lastFrameAt < sentAt) {
          try {
            ws.close()
          } catch {
            // Ignore.
          }
          this.handleClose(ws, 1006)
        }
      }, PONG_TIMEOUT_MS)
    }, PING_INTERVAL_MS)
  }

  private clearTimers(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.pongTimer) clearTimeout(this.pongTimer)
    if (this.stableTimer) clearTimeout(this.stableTimer)
    this.stableTimer = null
    this.retryTimer = null
    this.pingTimer = null
    this.pongTimer = null
  }
}
