/**
 * The smaller things, each a little live picture: a voice message, a photo
 * losing its location, the screen-share profiles (the visitor picks one) and
 * the server that is yours.
 */
import { useState } from 'react'
import { PROFILE_HINTS, PROFILE_LABELS, SHARE_PROFILES, type ShareProfile } from '../../lib/shareProfiles'
import { Avatar, ECE, Icon, OZAN } from './parts'
import { useLive } from './useDemo'

/** 32 bars of a made-up recording, 0..1. */
const WAVE = [
  0.2, 0.35, 0.6, 0.8, 0.55, 0.3, 0.45, 0.9, 0.7, 0.4, 0.25, 0.5, 0.75, 0.95, 0.6, 0.35, 0.2, 0.4, 0.65, 0.85, 0.5, 0.3,
  0.55, 0.8, 0.6, 0.4, 0.3, 0.5, 0.7, 0.45, 0.25, 0.15,
]

export function VoiceMessageVignette() {
  const { ref, live, reduced } = useLive<HTMLDivElement>()
  return (
    <div className="vg vg-voice" ref={ref} data-live={live} data-reduced={reduced} data-testid="vignette-voice">
      <div className="vg-voice-msg" aria-hidden="true">
        <Avatar friend={OZAN} size={30} />
        <div className="vg-voice-body">
          <p>
            <b>Ozan</b> <time>22:31</time>
          </p>
          <div className="vg-voice-player">
            <span className="vg-play">
              <Icon name="play" size={14} />
            </span>
            <span className="vg-wave">
              {WAVE.map((h, i) => (
                <i key={i} style={{ ['--h' as string]: String(h), ['--i' as string]: String(i) }} />
              ))}
            </span>
            <span className="vg-time">0:14</span>
          </div>
        </div>
      </div>
    </div>
  )
}

export function PhotoVignette() {
  const { ref, live, reduced } = useLive<HTMLDivElement>()
  return (
    <div className="vg vg-photo" ref={ref} data-live={live} data-reduced={reduced} data-testid="vignette-photo">
      <div className="vg-photo-card" aria-hidden="true">
        <svg viewBox="0 0 200 130" className="vg-photo-pic">
          <rect width="200" height="130" fill="#26313a" />
          <circle cx="150" cy="34" r="14" fill="#e8c27a" />
          <path d="M0 98 46 58l34 28 30-22 90 66H0z" fill="#3f8a7c" />
          <path d="M0 130 70 84l40 26 26-14 64 34z" fill="#2c6359" />
        </svg>
        <span className="vg-chip vg-gps">
          <Icon name="pin" size={13} /> 41.03° K, 28.98° D
        </span>
        <span className="vg-chip vg-size">
          <s>4,8 MB</s> <b>540 KB</b>
        </span>
      </div>
    </div>
  )
}

/** The "Metin" picture: lines of code (indent, width, colour), the cursor last. */
const CODE_LINES: { x: number; w: string; kind?: string }[] = [
  { x: 0, w: '34%', kind: 'c' },
  { x: 1, w: '52%' },
  { x: 1, w: '40%', kind: 't' },
  { x: 2, w: '46%' },
  { x: 2, w: '28%' },
  { x: 1, w: '12%', kind: 'c' },
  { x: 0, w: '0' },
  { x: 0, w: '30%', kind: 'c' },
  { x: 1, w: '58%' },
  { x: 1, w: '3px', kind: 'cursor' },
]

const PROFILE_PICTURE: Record<ShareProfile, string> = {
  game: 'oyun',
  text: 'metin',
  film: 'film',
}

export function ShareProfilesVignette() {
  const [profile, setProfile] = useState<ShareProfile>('text')
  const { ref, live, reduced } = useLive<HTMLDivElement>()
  return (
    <div
      className="vg vg-share"
      ref={ref}
      data-live={live}
      data-reduced={reduced}
      data-profile={profile}
      data-testid="vignette-share"
    >
      <div className={`vg-screen vg-screen-${PROFILE_PICTURE[profile]}`} aria-hidden="true">
        <span className="vg-screen-label">
          <Avatar friend={ECE} size={16} /> Ece ekranını paylaşıyor
        </span>
        <div className="vg-screen-art">
          {CODE_LINES.map((line, n) => (
            <i
              key={n}
              className={line.kind}
              style={{ ['--n' as string]: String(n), ['--x' as string]: String(line.x), ['--w' as string]: line.w }}
            />
          ))}
        </div>
      </div>
      <div className="vg-seg" role="radiogroup" aria-label="Ekran paylaşımı profili">
        {SHARE_PROFILES.map((p) => (
          <button
            type="button"
            role="radio"
            aria-checked={profile === p}
            key={p}
            onClick={() => setProfile(p)}
            data-testid={`share-profile-${p}`}
          >
            {PROFILE_LABELS[p]}
          </button>
        ))}
      </div>
      <p className="vg-hint" aria-live="polite" data-testid="share-profile-hint">
        {PROFILE_HINTS[profile]}
      </p>
    </div>
  )
}

/** The devices around the one small server: a laptop or a phone each, with its owner's colour. */
const DEVICES: { kind: 'laptop' | 'phone'; x: number; y: number; colour: string; link: string }[] = [
  { kind: 'laptop', x: 18, y: 16, colour: '#ee997f', link: 'M62 32 C112 32 116 72 150 76' },
  { kind: 'phone', x: 34, y: 70, colour: '#69b9aa', link: 'M58 87 H 150' },
  { kind: 'laptop', x: 18, y: 124, colour: '#ddb174', link: 'M62 140 C112 140 116 100 150 96' },
  { kind: 'laptop', x: 256, y: 22, colour: '#9fb0dc', link: 'M256 38 C214 38 216 72 210 76' },
  { kind: 'phone', x: 270, y: 106, colour: '#c79ad1', link: 'M270 124 C232 124 224 98 210 96' },
]

export function ServerVignette() {
  const { ref, live, reduced } = useLive<HTMLDivElement>()
  return (
    <div className="vg vg-server" ref={ref} data-live={live} data-reduced={reduced} data-testid="vignette-server">
      <svg viewBox="0 0 320 170" role="img" aria-label="Grubun bilgisayarları ve telefonları tek bir küçük sunucuya bağlı">
        <g className="vg-links" fill="none" stroke="#2b303a" strokeWidth="2">
          {DEVICES.map((d) => (
            <path key={d.link} d={d.link} />
          ))}
        </g>
        <g className="vg-pulses" fill="none" strokeWidth="2.5" strokeLinecap="round">
          {DEVICES.map((d) => (
            <path key={d.link} d={d.link} stroke={d.colour} pathLength="100" />
          ))}
        </g>
        <rect x="150" y="56" width="60" height="60" rx="12" fill="#232730" stroke="#3a404c" />
        <g fill="#ee997f" className="vg-server-dots">
          <circle cx="180" cy="75" r="7" />
          <circle cx="172" cy="89" r="7" />
          <circle cx="188" cy="89" r="7" />
        </g>
        {DEVICES.map((d) =>
          d.kind === 'laptop' ? (
            <g key={d.link} data-device="laptop">
              <rect x={d.x} y={d.y} width="44" height="30" rx="5" fill="#1a1d24" stroke="#3a404c" />
              <circle cx={d.x + 22} cy={d.y + 15} r="6.5" fill={d.colour} />
            </g>
          ) : (
            <g key={d.link} data-device="phone">
              <rect x={d.x} y={d.y} width="24" height="36" rx="5" fill="#1a1d24" stroke="#3a404c" />
              <circle cx={d.x + 12} cy={d.y + 17} r="5.5" fill={d.colour} />
            </g>
          ),
        )}
      </svg>
    </div>
  )
}
