import { useEffect, useState } from 'react'
import { TURN_HINT } from '../lib/connReport'
import { ringCooldownLeft } from '../lib/ring'

/**
 * Small pieces of the voice panel added by CONTRACT-V4: the "Çağır" button
 * (A4), the TURN hint (A3), and the camera button's waiting title (A1).
 */

/** The camera button's title while a change waits for the socket (A1), or null. */
export function heldCameraTitle(held: boolean | null): string | null {
  if (held === null) return null
  return held ? 'Kamera bağlantı gelince açılacak' : 'Kamera bağlantı gelince kapanacak'
}

export interface RingButtonProps {
  /** When I last rang (ms since epoch), or null. */
  lastRingAt: number | null
  /** No signalling now: the ring could not be sent. */
  disabled: boolean
  error: string | null
  onRing: () => void
}

/** "Çağır": rings everybody online who is not in my room; then waits 30 s. */
export function RingButton({ lastRingAt, disabled, error, onRing }: RingButtonProps) {
  const [now, setNow] = useState(() => Date.now())
  const left = ringCooldownLeft(lastRingAt, now)
  useEffect(() => {
    if (left <= 0) return
    const timer = setTimeout(() => setNow(Date.now()), Math.min(1000, left))
    return () => clearTimeout(timer)
  }, [left, now])
  // A ring sent elsewhere (another render) restarts the clock.
  useEffect(() => setNow(Date.now()), [lastRingAt])
  const seconds = Math.ceil(left / 1000)
  return (
    <div className="ring-control">
      <button
        type="button"
        className="ring-button"
        data-testid="btn-ring"
        disabled={disabled || left > 0}
        data-cooldown={left > 0}
        title={
          left > 0
            ? `${seconds} saniye sonra yeniden çağırabilirsin`
            : 'Çevrimiçi olup odada olmayanları çağır'
        }
        onClick={onRing}
      >
        {left > 0 ? `Çağrıldı · ${seconds} sn` : 'Çağır'}
      </button>
      {error && (
        <span className="ring-error" role="alert" data-testid="ring-error">
          {error}
        </span>
      )}
    </div>
  )
}

/** A3: quiet, persistent, for everybody in voice when /api/ice has no TURN server. */
export function TurnHint({ configured }: { configured: boolean | null }) {
  if (configured !== false) return null
  return (
    <p className="turn-hint" data-testid="turn-hint">
      {TURN_HINT}
    </p>
  )
}
