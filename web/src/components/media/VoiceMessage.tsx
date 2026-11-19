import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { claimPlayback, releasePlayback } from '../../lib/onePlayer'
import { formatDuration, nextRate, rateLabel, WAVEFORM_BARS } from '../../lib/voiceNote'
import type { Attachment, VoiceMeta } from '../../types'

/**
 * A voice message (CONTRACT-V6-MEDIA §4): play/pause, the 64-bar waveform as
 * the seek bar, the time, and 1× / 1,5× / 2×. One plays at a time.
 *
 * A WebM written by MediaRecorder has no duration in its header, so Chromium
 * reports `Infinity` until it has read to the end; the player asks for the
 * end once (a seek far ahead) to learn the real duration before seeking is
 * offered, and uses the sender's `duration_ms` meanwhile.
 */
export function VoiceMessage({ attachment, voice }: { attachment: Attachment; voice: VoiceMeta }) {
  const audio = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [position, setPosition] = useState(0)
  const [duration, setDuration] = useState(voice.duration_ms / 1000)
  const [rate, setRate] = useState(1)
  const probing = useRef(false)
  const bars = voice.waveform.length === WAVEFORM_BARS ? voice.waveform : new Array<number>(WAVEFORM_BARS).fill(0)

  useEffect(() => {
    const element = audio.current
    return () => {
      if (element) {
        element.pause()
        releasePlayback(element)
      }
    }
  }, [])

  const learnDuration = () => {
    const element = audio.current
    if (!element) return
    if (Number.isFinite(element.duration) && element.duration > 0) {
      setDuration(element.duration)
      if (probing.current) {
        probing.current = false
        element.currentTime = 0
      }
    } else if (!probing.current && element.readyState >= 1) {
      probing.current = true
      element.currentTime = 1e9
    }
  }

  const toggle = () => {
    const element = audio.current
    if (!element) return
    if (element.paused) {
      claimPlayback(element)
      element.playbackRate = rate
      void element.play().catch(() => setPlaying(false))
    } else element.pause()
  }

  const seekTo = (fraction: number) => {
    const element = audio.current
    if (!element || probing.current) return
    const length = Number.isFinite(element.duration) && element.duration > 0 ? element.duration : duration
    element.currentTime = Math.max(0, Math.min(length, fraction * length))
    setPosition(element.currentTime)
  }

  const onWavePointer = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    seekTo((event.clientX - box.left) / box.width)
  }

  const onWaveKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowRight' ? 5 : event.key === 'ArrowLeft' ? -5 : 0
    if (!step || duration <= 0) return
    event.preventDefault()
    seekTo((position + step) / duration)
  }

  const progress = duration > 0 ? Math.min(1, position / duration) : 0
  const played = Math.round(progress * WAVEFORM_BARS)
  return (
    <div className={`voice-message${playing ? ' playing' : ''}`} data-testid="voice-message">
      <button
        type="button"
        className="voice-play"
        data-testid="voice-play"
        aria-label={playing ? 'Duraklat' : 'Sesli mesajı oynat'}
        onClick={toggle}
      >
        {playing ? (
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <rect x="3" y="2" width="3.5" height="12" rx="1" fill="currentColor" />
            <rect x="9.5" y="2" width="3.5" height="12" rx="1" fill="currentColor" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4 2.5v11a.8.8 0 0 0 1.2.7l9-5.5a.8.8 0 0 0 0-1.4l-9-5.5A.8.8 0 0 0 4 2.5z" fill="currentColor" />
          </svg>
        )}
      </button>
      <div
        className="voice-wave"
        data-testid="voice-wave"
        role="slider"
        tabIndex={0}
        aria-label="Sesli mesajda konum"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(position)}
        aria-valuetext={`${formatDuration(position * 1000)} / ${formatDuration(duration * 1000)}`}
        onPointerDown={onWavePointer}
        onKeyDown={onWaveKey}
      >
        {bars.map((value, index) => (
          <span
            key={index}
            className={index < played ? 'played' : undefined}
            style={{ height: `${Math.max(8, Math.round((value / 255) * 100))}%` }}
          />
        ))}
      </div>
      <span className="voice-time" data-testid="voice-time">
        {formatDuration((playing || position > 0 ? position : duration) * 1000)}
      </span>
      <button
        type="button"
        className="voice-rate"
        data-testid="voice-rate"
        aria-label={`Oynatma hızı ${rateLabel(rate)}`}
        onClick={() => {
          const next = nextRate(rate)
          setRate(next)
          if (audio.current) audio.current.playbackRate = next
        }}
      >
        {rateLabel(rate)}
      </button>
      <audio
        ref={audio}
        data-testid="voice-audio"
        src={attachment.url}
        preload="metadata"
        onLoadedMetadata={learnDuration}
        onDurationChange={learnDuration}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false)
          setPosition(0)
          releasePlayback(audio.current!)
        }}
        onTimeUpdate={() => {
          if (!probing.current && audio.current) setPosition(audio.current.currentTime)
        }}
      />
    </div>
  )
}
