import { useState } from 'react'

/**
 * The per-user colours behind an initial (and behind a picture while it
 * loads): picked by user id, muted to sit with the palette (design/palette.md)
 * while keeping the light initial at 4.4:1 or more.
 */
export const AVATAR_COLORS = ['#52638f', '#37766c', '#97505f', '#86652f', '#a0574a', '#3e6e85', '#75507a']

export function avatarColor(id: number): string {
  return AVATAR_COLORS[Math.abs(id) % AVATAR_COLORS.length]
}

export function initialOf(name: string): string {
  return [...name.trim()][0]?.toLocaleUpperCase('tr-TR') ?? '?'
}

/**
 * A user's picture when they have one, else (and when it fails to load) the
 * initial on their colour. The box is the same size either way, so a picture
 * arriving moves nothing.
 */
export function Avatar({
  id,
  name,
  size = 32,
  speaking = false,
  url = null,
}: {
  id: number
  name: string
  size?: number
  speaking?: boolean
  /** v4: `avatar_url`; only same-origin `/api/` paths are shown. */
  url?: string | null
}) {
  // The URL that failed, so that a NEW url (another upload) is tried again.
  const [failed, setFailed] = useState<string | null>(null)
  const picture = typeof url === 'string' && url.startsWith('/api/') && failed !== url ? url : null
  const className = `avatar${speaking ? ' speaking' : ''}${picture ? ' has-image' : ''}`
  return (
    <span
      className={className}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.45),
        background: avatarColor(id),
      }}
      data-avatar={picture ? 'image' : 'initial'}
      aria-hidden="true"
    >
      {picture ? (
        <img
          key={picture}
          className="avatar-img"
          src={picture}
          width={size}
          height={size}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailed(picture)}
        />
      ) : (
        initialOf(name)
      )}
    </span>
  )
}
