/**
 * CONTRACT-V8-MUSIC §4–6: the music button, the sharer's panel (title toggle
 * and title), the note mark and "Şu an çalıyor" line on a sharer's row, the
 * listener's music volume and mute, and the element each remote music plays in.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { screenShareSupported } from '../lib/phone'
import { useSinkId } from '../useSinkId'
import type { RemoteMedia, VoiceEngine, VoiceSnapshot } from '../voice'
import { desktopMusicBridge, type MusicSupport } from './capture'
import { musicElementState, musicOf, musicPrefsStore, nowPlayingTitle } from './musicPrefs'

export function NoteIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </svg>
  )
}

/** Where music can be shared at all: a browser with getDisplayMedia (the app included). */
export function musicShareSupported(): boolean {
  return screenShareSupported()
}

/** In the desktop app, why the button would refuse (asked once, no side effect), or null. */
function useDesktopRefusal(): string | null {
  const [refusal, setRefusal] = useState<string | null>(null)
  useEffect(() => {
    const bridge = desktopMusicBridge()
    if (!bridge?.musicCaptureSupport) return
    let alive = true
    bridge
      .musicCaptureSupport()
      .then((support: MusicSupport | null) => {
        if (alive && support && !support.systemAudio) setRefusal(support.message)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])
  return refusal
}

function buttonLabel(voice: VoiceSnapshot): string {
  if (voice.music) return 'Müziği durdur'
  return voice.musicStarting ? 'Müzik paylaşımı açılıyor…' : 'Müzik paylaş'
}

/**
 * `btn-music` (the user panel) or `call-bar-music` (the phone call bar). The
 * click goes straight to the engine: the picker needs the click's activation.
 */
export function MusicButton({
  voice,
  engine,
  variant,
}: {
  voice: VoiceSnapshot
  engine: VoiceEngine
  variant: 'panel' | 'callbar'
}) {
  const refusal = useDesktopRefusal()
  if (!musicShareSupported()) return null
  const label = buttonLabel(voice)
  const title = !voice.music && refusal ? `${label} — ${refusal}` : label
  const base = variant === 'panel' ? 'icon-button' : 'v7-call-button'
  return (
    <button
      type="button"
      className={`${base}${voice.music ? ' on' : ''} v8-music-button`}
      data-testid={variant === 'panel' ? 'btn-music' : 'call-bar-music'}
      aria-pressed={voice.music}
      aria-label={label}
      title={title}
      disabled={voice.musicStarting || voice.status !== 'connected'}
      onClick={() => void engine.toggleMusic()}
    >
      <NoteIcon size={variant === 'panel' ? 20 : 22} />
    </button>
  )
}

/**
 * The title while I share (CONTRACT-V8-MUSIC §5). Desktop app with a
 * now-playing source: what Windows says is playing, read only while the share
 * AND the toggle are on. Otherwise the text I type (no browser
 * tells the capturer the tab's title). Toggle off: no title.
 */
export function useMusicTitle(engine: VoiceEngine, voice: VoiceSnapshot) {
  const prefs = useSyncExternalStore(musicPrefsStore.subscribe, musicPrefsStore.getSnapshot)
  const showTitle = prefs.showTitle
  const bridge = desktopMusicBridge()
  const fromApp = typeof bridge?.onNowPlaying === 'function'
  const [typed, setTyped] = useState('')
  const [appTitle, setAppTitle] = useState<string | null>(null)
  const sharing = voice.music
  const initial = useRef<string | null>(null)

  // A new share starts from the title the engine holds (none), or empty.
  useEffect(() => {
    if (!sharing) {
      initial.current = null
      setTyped('')
      setAppTitle(null)
      return
    }
    if (initial.current === null) {
      initial.current = voice.musicTitle ?? ''
      setTyped(initial.current)
    }
  }, [sharing, voice.musicTitle])

  // The desktop app's watch: on only while sharing with the toggle on.
  useEffect(() => {
    if (!sharing || !showTitle || !fromApp || !bridge) return
    const unsubscribe = bridge.onNowPlaying?.((info) => setAppTitle(nowPlayingTitle(info)))
    bridge.setNowPlayingWatch?.(true)
    return () => {
      unsubscribe?.()
      bridge.setNowPlayingWatch?.(false)
      setAppTitle(null)
    }
  }, [sharing, showTitle, fromApp, bridge])

  // What is announced; typing waits for a pause before it goes out.
  const wanted = !sharing || !showTitle ? null : fromApp ? appTitle : typed
  useEffect(() => {
    if (!sharing) return
    const delay = fromApp || wanted === null ? 0 : 400
    const timer = setTimeout(() => engine.setMusicTitle(wanted), delay)
    return () => clearTimeout(timer)
  }, [engine, sharing, wanted, fromApp])

  return { showTitle, fromApp, typed, setTyped, appTitle }
}

export type MusicTitleState = ReturnType<typeof useMusicTitle>

/** Under the voice panel while I share: the title toggle and the title. */
export function MusicPanel({ voice, title }: { voice: VoiceSnapshot; title: MusicTitleState }) {
  if (!voice.music) return null
  return (
    <div className="v8-music-panel" data-testid="music-panel">
      <div className="v8-music-panel-head">
        <NoteIcon size={14} />
        <strong>Müzik paylaşılıyor</strong>
      </div>
      <label className="v8-music-toggle">
        <input
          type="checkbox"
          data-testid="music-title-toggle"
          checked={title.showTitle}
          onChange={(event) => musicPrefsStore.setShowTitle(event.target.checked)}
        />
        Şarkı adını göster
      </label>
      {title.showTitle &&
        (title.fromApp ? (
          <p className="v8-music-app-title" data-testid="music-app-title">
            {title.appTitle ?? 'Çalan parça bilinmiyor'}
          </p>
        ) : (
          <input
            type="text"
            className="v8-music-title-input"
            data-testid="music-title-input"
            maxLength={120}
            placeholder="Ne çalıyor? (isteğe bağlı)"
            aria-label="Şarkı adı"
            value={title.typed}
            onChange={(event) => title.setTyped(event.target.value)}
          />
        ))}
    </div>
  )
}

/** The note mark on a sharer's row. */
export function MusicMark() {
  return (
    <span className="v8-music-mark" title="Müzik paylaşıyor">
      <NoteIcon size={13} />
    </span>
  )
}

/** "Şu an çalıyor: <title>" under a sharer's name: text only, one line. */
export function NowPlayingLine({ userId, name, title }: { userId: number; name: string; title: string | null | undefined }) {
  if (!title) return null
  return (
    <span className="v8-now-playing" data-testid={`music-now-playing-${userId}`} title={`${name} paylaşıyor: ${title}`}>
      <NoteIcon size={11} />
      <span>Şu an çalıyor: {title}</span>
    </span>
  )
}

/** The listener's music volume and mute for one sharer, in their volume sheet. */
export function MusicVolumeControls({ userId }: { userId: number }) {
  const prefs = useSyncExternalStore(musicPrefsStore.subscribe, musicPrefsStore.getSnapshot)
  const music = musicOf(prefs, userId)
  const id = `music-volume-input-${userId}`
  return (
    <div className="volume-field v8-music-volume">
      <label htmlFor={id}>
        <span className="v8-music-volume-label">
          <NoteIcon size={13} /> Müzik
        </span>
        <output data-testid={`music-volume-value-${userId}`}>{music.muted ? 'kapalı' : `%${Math.round(music.volume * 100)}`}</output>
      </label>
      <div className="v8-music-volume-row">
        <input
          id={id}
          type="range"
          min={0}
          max={100}
          step={5}
          value={Math.round(music.volume * 100)}
          data-testid={`music-volume-${userId}`}
          style={{ ['--fill' as string]: `${music.volume * 100}%` }}
          onChange={(event) => musicPrefsStore.setVolume(userId, Number(event.target.value) / 100)}
        />
        <button
          type="button"
          className={`ghost v8-music-mute${music.muted ? ' on' : ''}`}
          data-testid={`music-mute-${userId}`}
          aria-pressed={music.muted}
          onClick={() => musicPrefsStore.setMuted(userId, !music.muted)}
        >
          {music.muted ? 'Aç' : 'Sustur'}
        </button>
      </div>
    </div>
  )
}

/**
 * One remote music stream, in its own element: my music volume for them
 * (0–100 %, the element's volume), muted by deafen or my music mute, on the
 * chosen output device. Never routed through the voice boost (playback.ts)
 * and never read by the speaking detector.
 */
export function RemoteMusic({ media, deafened }: { media: RemoteMedia; deafened: boolean }) {
  const ref = useRef<HTMLAudioElement>(null)
  const prefs = useSyncExternalStore(musicPrefsStore.subscribe, musicPrefsStore.getSnapshot)
  const { volume, muted } = musicElementState(prefs, media.userId, deafened)
  useSinkId(ref)

  useEffect(() => {
    const element = ref.current
    if (!element) return
    element.srcObject = media.stream
    void element.play().catch(() => undefined)
    return () => {
      element.pause()
      element.srcObject = null
    }
  }, [media.stream])

  useEffect(() => {
    const element = ref.current
    if (!element) return
    element.volume = volume
    element.muted = muted
    element.dataset.volume = String(volume)
  }, [volume, muted])

  return <audio ref={ref} autoPlay data-testid={`remote-music-${media.userId}`} />
}

/** All remote music elements (rendered hidden beside the microphones). */
export function RemoteMusicList({ voice }: { voice: VoiceSnapshot }): ReactNode {
  return voice.remoteMusic.map((media) => <RemoteMusic key={media.userId} media={media} deafened={voice.deafened} />)
}
