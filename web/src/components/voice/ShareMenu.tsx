import { useEffect, useRef, useState } from 'react'
import {
  estimateText,
  estimateUpload,
  PROFILE_HINTS,
  PROFILE_LABELS,
  QUALITY_BITRATE,
  QUALITY_LABELS,
  SHARE_PROFILES,
  SHARE_QUALITIES,
  formatMbps,
  uploadWarning,
  type ShareProfile,
  type ShareQuality,
} from '../../lib/shareProfiles'
import { voicePrefsStore } from '../../lib/voicePrefs'
import type { VoiceEngine, VoiceSnapshot } from '../../voice'
import { ChevronIcon } from './icons'

const STATS_POLL_MS = 2000

/**
 * The screen-share menu (CONTRACT-V6-VOICE §1): profile, transfer quality,
 * the estimated mesh upload, a warning when the measured upload is short,
 * and who is watching. Opened from the caret beside the share button, or
 * from the chip on my own screen tile. Choices are remembered and apply at
 * once to a share in progress (no renegotiation).
 */
export function ShareMenu({
  engine,
  voice,
  nameOf,
  variant,
}: {
  engine: VoiceEngine
  voice: VoiceSnapshot
  nameOf: (userId: number) => string
  variant: 'button' | 'chip'
}) {
  const [open, setOpen] = useState(false)
  const [available, setAvailable] = useState<(number | null)[]>([])
  const box = useRef<HTMLDivElement>(null)
  const sharing = voice.screensharing
  const others = Object.keys(voice.peerHealth).length
  const viewers = sharing ? voice.screenWatchers.length : others
  const estimate = estimateUpload(viewers, voice.shareQuality)
  const warning = sharing ? uploadWarning(estimate, available) : null

  useEffect(() => {
    if (!open) return
    const onDown = (event: PointerEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setOpen(false)
      }
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  useEffect(() => {
    if (!open || !sharing) {
      setAvailable([])
      return
    }
    let alive = true
    const poll = async () => {
      const stats = await engine.shareStats()
      if (alive) setAvailable(stats.filter((s) => s.watching).map((s) => s.available))
    }
    void poll()
    const timer = setInterval(() => void poll(), STATS_POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [open, sharing, engine])

  const choose = (profile: ShareProfile, quality: ShareQuality) => {
    voicePrefsStore.update({ shareProfile: profile, shareQuality: quality })
    void engine.setShareProfile(profile, quality)
  }

  const label = `${PROFILE_LABELS[voice.shareProfile]} · ${QUALITY_LABELS[voice.shareQuality]}`
  return (
    <div className={`share-menu ${variant}`} ref={box} onClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        className={variant === 'button' ? 'icon-button share-menu-caret' : 'share-chip'}
        data-testid={variant === 'button' ? 'btn-share-menu' : 'share-chip'}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Ekran paylaşımı ayarları"
        aria-label={`Ekran paylaşımı ayarları: ${label}`}
        onClick={() => setOpen((value) => !value)}
      >
        {variant === 'chip' && <span>{label}</span>}
        <ChevronIcon size={14} />
      </button>
      {open && (
        <div className="share-popover" role="dialog" aria-label="Ekran paylaşımı" data-testid="share-menu">
          <h4>Profil</h4>
          <div className="share-options" role="radiogroup" aria-label="Profil">
            {SHARE_PROFILES.map((profile) => (
              <button
                key={profile}
                type="button"
                role="radio"
                aria-checked={voice.shareProfile === profile}
                className={voice.shareProfile === profile ? 'share-option on' : 'share-option'}
                data-testid={`share-profile-${profile}`}
                title={PROFILE_HINTS[profile]}
                onClick={() => choose(profile, voice.shareQuality)}
              >
                {PROFILE_LABELS[profile]}
              </button>
            ))}
          </div>
          <p className="share-hint">{PROFILE_HINTS[voice.shareProfile]}</p>
          <h4>Aktarım (izleyici başına)</h4>
          <div className="share-options" role="radiogroup" aria-label="Aktarım">
            {SHARE_QUALITIES.map((quality) => (
              <button
                key={quality}
                type="button"
                role="radio"
                aria-checked={voice.shareQuality === quality}
                className={voice.shareQuality === quality ? 'share-option on' : 'share-option'}
                data-testid={`share-quality-${quality}`}
                onClick={() => choose(voice.shareProfile, quality)}
              >
                {QUALITY_LABELS[quality]}
                <small>{formatMbps(QUALITY_BITRATE[quality])}</small>
              </button>
            ))}
          </div>
          <p className="share-estimate" data-testid="share-estimate">
            {sharing ? 'Yükleme: ' : 'Paylaşırsan yükleme: '}
            {estimateText(estimate)}
          </p>
          {warning && (
            <p className="share-warning" role="alert" data-testid="share-warning">
              {warning}
            </p>
          )}
          {sharing && (
            <p className="share-watchers" data-testid="share-watchers" data-count={voice.screenWatchers.length}>
              {voice.screenWatchers.length === 0
                ? 'Kimse izlemiyor; görüntü kimseye gönderilmiyor.'
                : `İzleyenler: ${voice.screenWatchers.map(nameOf).join(', ')}`}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

/** On my own screen tile: who watches it, at a glance. */
export function ShareWatchers({ voice, nameOf }: { voice: VoiceSnapshot; nameOf: (userId: number) => string }) {
  const count = voice.screenWatchers.length
  const names = voice.screenWatchers.map(nameOf).join(', ')
  return (
    <span
      className="share-watch-count"
      data-testid="local-watchers"
      data-count={count}
      title={count === 0 ? 'Kimse izlemiyor' : `İzleyenler: ${names}`}
    >
      {count === 0 ? 'Kimse izlemiyor' : `${count} izliyor`}
    </span>
  )
}
