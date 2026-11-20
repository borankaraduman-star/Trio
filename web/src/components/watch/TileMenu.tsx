import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { VoiceEngine } from '../../voice'
import { voicePrefsStore, volumeOf } from '../../lib/voicePrefs'
import { SIZE_LABELS } from '../../lib/multishare'
import { formatMbps } from '../../lib/shareProfiles'
import { miniPlayers, toggleShareMute } from '../../watching/mini'
import { viewSizes } from '../../watching/sizes'
import { useWatch, watchStore } from '../../watching/store'

/**
 * CONTRACT-V12-WATCHING §8: everything about watching one share, two clicks
 * away: ⋯ on its tile, then the item. Küçük pencere, resim içinde resim,
 * Sinema modu, tam ekran, Hafif izleme, Sadece ses, Sabitle, the share's
 * sound, the receiving line, İzlemeyi bırak.
 */
export function TileMenu({
  userId,
  name,
  stream,
  engine,
  tileVideo,
}: {
  userId: number
  name: string
  stream: MediaStream
  engine: VoiceEngine
  /** The stage tile's own video (classic picture-in-picture plays it, sound and all). */
  tileVideo: () => HTMLVideoElement | null
}) {
  const [open, setOpen] = useState(false)
  const watch = useWatch()
  const prefs = useSyncExternalStore(voicePrefsStore.subscribe, voicePrefsStore.getSnapshot)
  const box = useRef<HTMLDivElement>(null)
  const choice = watch.choices[userId] ?? { light: false, audioOnly: false }
  const volume = volumeOf(prefs, userId).stream
  const hasAudio = stream.getAudioTracks().length > 0
  const mini = watch.minis.includes(userId)
  const pipOk = typeof document !== 'undefined' && document.pictureInPictureEnabled === true

  useEffect(() => {
    if (!open) return
    const onDown = (event: PointerEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const done = () => setOpen(false)
  const item = (testId: string, label: string, action: () => void, checked?: boolean, hint?: string) => (
    <button
      type="button"
      role={checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
      aria-checked={checked}
      className={`v12-menu-item${checked ? ' on' : ''}`}
      data-testid={`${testId}-${userId}`}
      title={hint}
      onClick={() => {
        action()
        done()
      }}
    >
      <span>{label}</span>
      {checked !== undefined && <span className="v12-check" aria-hidden="true">{checked ? '✓' : ''}</span>}
    </button>
  )

  return (
    <div className="v12-tile-menu" ref={box} onClick={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        className="v12-tile-menu-button"
        data-testid={`tile-menu-${userId}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`İzleme seçenekleri: ${name}`}
        title="İzleme seçenekleri"
        onClick={() => setOpen((value) => !value)}
      >
        ⋯
      </button>
      {open && (
        <div className="v12-menu" role="menu" aria-label={`${name} · ekran`} data-testid={`tile-menu-panel-${userId}`}>
          {item('tile-mini', mini ? 'Küçük pencereyi kapat' : 'Küçük pencerede aç', () => {
            if (mini) miniPlayers.close(userId)
            else void miniPlayers.show(userId)
          }, undefined, 'Oyun oynarken arkadaşının ekranı köşede kalsın')}
          {pipOk &&
            item('tile-pip', 'Resim içinde resim', () => {
              const video = tileVideo()
              if (!video) return
              if (document.pictureInPictureElement === video) void document.exitPictureInPicture().catch(() => undefined)
              else void video.requestPictureInPicture().catch(() => undefined)
            }, undefined, 'Tarayıcının her şeyin üstünde duran küçük penceresi')}
          {item('tile-theatre', 'Sinema modu', () => watchStore.update({ theatre: userId, focus: userId }), undefined, 'Paylaşım Trio penceresini doldursun')}
          {item('tile-fullscreen', 'Tam ekran', () => {
            const figure = tileVideo()?.closest('figure')
            void figure?.requestFullscreen?.().catch(() => undefined)
          })}
          <div className="v12-menu-sep" />
          {item('tile-light', 'Hafif izleme', () => {
            watchStore.setChoice(userId, { light: !choice.light })
            viewSizes.refresh(userId)
          }, choice.light, 'Küçük görüntü, saniyede birkaç kare: makineyi ve hattı yormaz')}
          {item('tile-audio', 'Sadece ses', () => {
            watchStore.setChoice(userId, { audioOnly: !choice.audioOnly })
            viewSizes.refresh(userId)
          }, choice.audioOnly, 'Görüntü sana gönderilmez, yayın sesi gelir')}
          {item('tile-pin', 'Bu paylaşımı sabitle', () => watchStore.update({ pinned: watch.pinned === userId ? null : userId }), watch.pinned === userId, 'Hep ilk sırada, Odak görünümünde büyük')}
          {item('tile-stats', 'Bağlantı bilgisini göster', () => watchStore.update({ stats: !watch.stats }), watch.stats)}
          {hasAudio && (
            <div className="v12-menu-volume">
              <button
                type="button"
                className="ghost small"
                data-testid={`tile-share-mute-${userId}`}
                aria-pressed={volume === 0}
                onClick={() => toggleShareMute(userId)}
              >
                {volume === 0 ? 'Yayın sesini aç' : 'Yayın sesini kapat'}
              </button>
              <input
                type="range"
                min={0}
                max={200}
                step={5}
                value={Math.round(volume * 100)}
                aria-label={`Yayın sesi: ${name}`}
                data-testid={`tile-share-volume-${userId}`}
                onChange={(event) => voicePrefsStore.setVolume(userId, 'stream', Number(event.target.value) / 100)}
              />
              <span>{Math.round(volume * 100)} %</span>
            </div>
          )}
          <div className="v12-menu-sep" />
          {item('tile-unwatch', 'İzlemeyi bırak', () => engine.setWatching(userId, false), undefined, 'Görüntü de ses de sana gönderilmez')}
        </div>
      )}
    </div>
  )
}

/** "Sadece ses" on a tile: what it means, and the way back. */
export function AudioOnlyCover({ userId, name }: { userId: number; name: string }) {
  return (
    <div className="v12-audio-only" data-testid={`audio-only-${userId}`} onClick={(event) => event.stopPropagation()}>
      <span>{name} · sadece ses</span>
      <button
        type="button"
        className="primary small"
        data-testid={`audio-only-off-${userId}`}
        onClick={() => {
          watchStore.setChoice(userId, { audioOnly: false })
          viewSizes.refresh(userId)
        }}
      >
        Görüntüyü aç
      </button>
    </div>
  )
}

/** The receiving line: "1280×720 · 30 kare/sn · 2,4 Mbps · büyük", every 2 s while turned on. */
export function ReceiveLine({ userId, engine }: { userId: number; engine: VoiceEngine }) {
  const [line, setLine] = useState<string>('…')
  useEffect(() => {
    let alive = true
    let last: Awaited<ReturnType<VoiceEngine['screenReceiveStats']>> = null
    const read = async () => {
      const now = await engine.screenReceiveStats(userId)
      if (!alive) return
      if (now && last) {
        const seconds = (now.at - last.at) / 1000
        const fps = (now.framesDecoded - last.framesDecoded) / seconds
        const bps = ((now.bytes - last.bytes) * 8) / seconds
        const frames = now.framesDecoded - last.framesDecoded
        const decodeMs = frames > 0 ? ((now.decodeSeconds - last.decodeSeconds) / frames) * 1000 : 0
        const size = SIZE_LABELS[viewSizes.toldSize(userId)]
        setLine(
          bps < 1000
            ? `Görüntü gelmiyor · ${size}`
            : `${now.width}×${now.height} · ${Math.round(fps)} kare/sn · ${formatMbps(bps)} · çözme ${decodeMs.toFixed(1)} ms · ${size}`,
        )
      }
      last = now
    }
    void read()
    const timer = setInterval(() => void read(), 2000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [engine, userId])
  return (
    <span className="v12-receive-line" data-testid={`receive-line-${userId}`}>
      {line}
    </span>
  )
}
