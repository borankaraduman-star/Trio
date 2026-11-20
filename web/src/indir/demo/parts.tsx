/**
 * Pieces the demos share: the three made-up friends, their avatars, the
 * app's line icons (redrawn here so the page does not load the app), and the
 * controls every moving demo carries (pause, and step-by-step under reduced
 * motion).
 */
import type { ReactNode } from 'react'
import type { Demo } from './useDemo'

export interface Friend {
  name: string
  color: string
}

export const ECE: Friend = { name: 'Ece', color: '#3f8a7c' }
export const OZAN: Friend = { name: 'Ozan', color: '#9b5361' }
export const DENIZ: Friend = { name: 'Deniz', color: '#8c6a2f' }
export const SEN: Friend = { name: 'Sen', color: '#4b5a78' }
export const FRIENDS = [ECE, OZAN, DENIZ] as const

export function Avatar({
  friend,
  size = 28,
  speaking = false,
  className,
}: {
  friend: Friend
  size?: number
  speaking?: boolean
  className?: string
}) {
  return (
    <span
      className={['d-avatar', speaking ? 'is-speaking' : '', className ?? ''].filter(Boolean).join(' ')}
      style={{ width: size, height: size, background: friend.color, fontSize: Math.round(size * 0.42) }}
      aria-hidden="true"
    >
      {friend.name[0]}
    </span>
  )
}

const PATHS: Record<string, ReactNode> = {
  mic: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </>
  ),
  micOff: (
    <>
      <path d="M9 9v2a3 3 0 0 0 5.1 2.1M15 10V6a3 3 0 0 0-5.7-1.3" />
      <path d="M5 11a7 7 0 0 0 11.4 5.4M19 11a7 7 0 0 1-.6 2.8M12 18v3M4 4l16 16" />
    </>
  ),
  headphones: <path d="M4 15v-3a8 8 0 0 1 16 0v3M4 15h3v5H5a1 1 0 0 1-1-1zM20 15h-3v5h2a1 1 0 0 0 1-1z" />,
  camera: (
    <>
      <rect x="3" y="7" width="13" height="10" rx="2" />
      <path d="m16 11 5-3v8l-5-3" />
    </>
  ),
  screen: (
    <>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </>
  ),
  leave: (
    <path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2zM16 3l5 5M21 3l-5 5" />
  ),
  note: (
    <>
      <path d="M9 18V6l11-2v12" />
      <circle cx="6.5" cy="18" r="2.5" />
      <circle cx="17.5" cy="16" r="2.5" />
    </>
  ),
  hash: <path d="M9 4 7 20M17 4l-2 16M4 9h16M3 15h16" />,
  speaker: <path d="M4 10v4h4l5 4V6L8 10zM16.5 9.5a4 4 0 0 1 0 5M19 7a7.5 7.5 0 0 1 0 10" />,
  clip: <path d="m20 11-8.5 8.5a5 5 0 0 1-7-7L13 4a3.5 3.5 0 0 1 5 5l-8.4 8.4a2 2 0 0 1-2.8-2.8L14.5 7" />,
  play: <path d="M8 5v14l11-7z" />,
  pause: <path d="M8 5h3v14H8zM13 5h3v14h-3z" />,
  pin: (
    <>
      <path d="M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11z" />
      <circle cx="12" cy="10" r="2.2" />
    </>
  ),
  bell: <path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 21h4" />,
}

export function Icon({ name, size = 18 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg
      className="d-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  )
}

/**
 * Under every moving demo: pause/continue (WCAG 2.2.2), or, with reduced
 * motion, the steps by hand.
 */
export function DemoControls<E extends HTMLElement>({
  demo,
  label,
}: {
  demo: Demo<E>
  label: string
}) {
  const paused = demo.paused
  if (demo.reduced) {
    return (
      <div className="d-controls" data-testid="demo-steps">
        <button type="button" onClick={demo.previous} aria-label={`${label}: önceki adım`}>
          ‹ Önceki
        </button>
        <span className="d-controls-count" aria-live="polite">
          Adım {demo.step + 1} / {demo.last + 1}
        </span>
        <button type="button" onClick={demo.next} aria-label={`${label}: sonraki adım`}>
          Sonraki ›
        </button>
      </div>
    )
  }
  return (
    <div className="d-controls">
      <button
        type="button"
        className="d-pause"
        onClick={() => demo.hold('user', !paused)}
        aria-pressed={paused}
        aria-label={paused ? `${label}: oynat` : `${label}: durdur`}
        data-testid="demo-pause"
      >
        <Icon name={paused ? 'play' : 'pause'} size={14} />
        {paused ? 'Oynat' : 'Durdur'}
      </button>
    </div>
  )
}

/** Data attributes every demo root carries, read by the e2e suite. */
export function demoAttributes<E extends HTMLElement>(demo: Demo<E>, name: string) {
  return {
    'data-demo': name,
    'data-step': demo.step,
    'data-playing': demo.playing ? 'true' : 'false',
    'data-reduced': demo.reduced ? 'true' : 'false',
  }
}
