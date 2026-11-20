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
  0.2, 0.35, 0.6, 0.8, 0.55, 0.3, 0.45, 0.9, 0.7, 0.4, 0.25, 0.5, 0.75, 0.95, 0.6, 0.35, 0.2, 0.4, 0.65, 0.85, 0.5,
  0.3, 0.55, 0.8, 0.6, 0.4, 0.3, 0.5, 0.7, 0.45, 0.25, 0.15,
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

const PROFILE_PICTURE: Record<ShareProfile, string> = {
  game: 'oyun',
  text: 'metin',
  film: 'film',
}

export function ShareProfilesVignette() {
  const [profile, setProfile] = useState<ShareProfile>('text')
  const { ref, live, reduced } = useLive<HTMLDivElement>()
  return (
    <div className="vg vg-share" ref={ref} data-live={live} data-reduced={reduced} data-profile={profile} data-testid="vignette-share">
      <div className={`vg-screen vg-screen-${PROFILE_PICTURE[profile]}`} aria-hidden="true">
        <span className="vg-screen-label">
          <Avatar friend={ECE} size={16} /> Ece ekranını paylaşıyor
        </span>
        <div className="vg-screen-art">
          <i />
          <i />
          <i />
          <i />
          <i />
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

export function ServerVignette() {
  const { ref, live, reduced } = useLive<HTMLDivElement>()
  return (
    <div className="vg vg-server" ref={ref} data-live={live} data-reduced={reduced} data-testid="vignette-server">
      <svg viewBox="0 0 320 170" role="img" aria-label="Üç cihaz tek bir küçük sunucuya bağlı">
        <g className="vg-links" fill="none" stroke="#2b303a" strokeWidth="2">
          <path d="M60 46 C110 46 120 85 160 85" />
          <path d="M60 128 C110 128 120 85 160 85" />
          <path d="M260 85 H 200" />
        </g>
        <g className="vg-pulses" fill="none" strokeWidth="2.5" strokeLinecap="round">
          <path d="M60 46 C110 46 120 85 160 85" stroke="#ee997f" pathLength="100" />
          <path d="M60 128 C110 128 120 85 160 85" stroke="#69b9aa" pathLength="100" />
          <path d="M260 85 H 200" stroke="#ddb174" pathLength="100" />
        </g>
        <rect x="150" y="55" width="60" height="60" rx="12" fill="#232730" stroke="#3a404c" />
        <g fill="#ee997f" className="vg-server-dots">
          <circle cx="180" cy="74" r="7" />
          <circle cx="172" cy="88" r="7" />
          <circle cx="188" cy="88" r="7" />
        </g>
        <rect x="24" y="30" width="44" height="32" rx="5" fill="#1a1d24" stroke="#3a404c" />
        <rect x="32" y="108" width="24" height="40" rx="5" fill="#1a1d24" stroke="#3a404c" />
        <rect x="256" y="66" width="48" height="36" rx="5" fill="#1a1d24" stroke="#3a404c" />
      </svg>
    </div>
  )
}
