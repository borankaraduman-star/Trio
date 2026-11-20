import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { MiniController } from './controller'
import './mini.css'

/**
 * The mini player's whole UI (CONTRACT-V12-WATCHING §6): one picture and a
 * compact bar that shows while the pointer is over the window. Drawn the same
 * in a popup (`/mini.html`), in the desktop shell's always-on-top window and
 * in the browser's Document Picture-in-Picture window.
 */
export function MiniView({ controller, win }: { controller: MiniController; win: Window }) {
  const snap = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const video = useRef<HTMLVideoElement | null>(null)
  const [hover, setHover] = useState(true)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const attach = useCallback(
    (element: HTMLVideoElement | null) => {
      video.current = element
      controller.attach(element)
    },
    [controller],
  )

  // The mini's own size: the share is sent to me at that size.
  useEffect(() => {
    const report = () => controller.report(win.innerHeight, win.devicePixelRatio || 1, win.document.visibilityState !== 'hidden')
    report()
    win.addEventListener('resize', report)
    win.document.addEventListener('visibilitychange', report)
    return () => {
      win.removeEventListener('resize', report)
      win.document.removeEventListener('visibilitychange', report)
    }
  }, [controller, win])

  const poke = () => {
    setHover(true)
    if (hideTimer.current) clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => setHover(false), 2500)
  }
  useEffect(() => {
    poke()
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current)
    }
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') controller.close()
      else if (event.key === 'm' || event.key === 'M') controller.toggleMute()
      else if (event.key === 'n' || event.key === 'N') controller.next()
    }
    win.addEventListener('keydown', onKey)
    return () => win.removeEventListener('keydown', onKey)
  }, [controller, win])

  const pip = () => {
    const element = video.current
    if (element && win.document.pictureInPictureEnabled && !win.document.pictureInPictureElement) {
      void element.requestPictureInPicture().catch(() => undefined)
    }
  }

  return (
    <div
      className={`mini${hover ? ' controls' : ''}${snap.audioOnly ? ' audio-only' : ''}`}
      data-testid="mini"
      data-sharer={snap.sharerId}
      data-ended={snap.ended}
      onPointerMove={poke}
      onPointerLeave={() => setHover(false)}
    >
      <video ref={attach} data-mini-video data-testid="mini-video" autoPlay playsInline muted />
      {snap.audioOnly && <p className="mini-note">Sadece ses: görüntü sana gönderilmiyor.</p>}
      {snap.ended && <p className="mini-note" data-testid="mini-ended">{snap.name} paylaşımı bitirdi.</p>}
      <div className="mini-top">
        <strong className="mini-name" data-testid="mini-name" title={`${snap.name} · ekran`}>
          {snap.name}
        </strong>
        {snap.speaking && (
          <span className="mini-speaking" data-testid="mini-speaking">
            {snap.speaking}
          </span>
        )}
        <span className="mini-drag" aria-hidden="true" />
        <button type="button" className="mini-button" data-testid="mini-close" title="Kapat (Esc)" aria-label="Mini oynatıcıyı kapat" onClick={() => controller.close()}>
          ✕
        </button>
      </div>
      <div className="mini-bar">
        {snap.hasAudio && (
          <>
            <button
              type="button"
              className={`mini-button${snap.muted ? ' off' : ''}`}
              data-testid="mini-mute"
              aria-pressed={snap.muted}
              title={snap.muted ? 'Yayın sesini aç (M)' : 'Yayın sesini kapat (M)'}
              onClick={() => controller.toggleMute()}
            >
              {snap.muted ? '🔇' : '🔊'}
            </button>
            <input
              type="range"
              min={0}
              max={200}
              step={5}
              value={Math.round(snap.volume * 100)}
              aria-label="Yayın sesi"
              data-testid="mini-volume"
              onChange={(event) => controller.setVolume(Number(event.target.value) / 100)}
            />
          </>
        )}
        {snap.shareCount > 1 && (
          <button type="button" className="mini-button" data-testid="mini-next" title="Sıradaki paylaşım (N)" onClick={() => controller.next()}>
            ⇄
          </button>
        )}
        <button
          type="button"
          className={`mini-button${snap.light ? ' on' : ''}`}
          data-testid="mini-light"
          aria-pressed={snap.light}
          title="Hafif izleme: küçük ve az kare/sn (makineyi ve hattı yormaz)"
          onClick={() => controller.toggleLight()}
        >
          Hafif
        </button>
        <button
          type="button"
          className={`mini-button${snap.audioOnly ? ' on' : ''}`}
          data-testid="mini-audio-only"
          aria-pressed={snap.audioOnly}
          title="Sadece ses: görüntüyü durdur, sesi dinle"
          onClick={() => controller.toggleAudioOnly()}
        >
          Ses
        </button>
        {snap.desktop && (
          <>
            <button
              type="button"
              className={`mini-button${snap.clickThrough ? ' on' : ''}`}
              data-testid="mini-click-through"
              aria-pressed={snap.clickThrough}
              title="Tıklamalar oyuna geçsin (geri almak için kısayolu kullan)"
              onClick={() => controller.toggleClickThrough()}
            >
              Geçir
            </button>
            <input
              type="range"
              min={40}
              max={100}
              step={5}
              value={Math.round(snap.opacity * 100)}
              aria-label="Saydamlık"
              data-testid="mini-opacity"
              onChange={(event) => controller.setOpacity(Number(event.target.value) / 100)}
            />
          </>
        )}
        {!snap.desktop && win.document.pictureInPictureEnabled && (
          <button type="button" className="mini-button" data-testid="mini-pip" title="Her şeyin üstünde tut (resim içinde resim)" onClick={pip}>
            ⧉
          </button>
        )}
        <button type="button" className="mini-button" data-testid="mini-back" title="Trio'ya dön" onClick={() => controller.backToTrio()}>
          ↩
        </button>
      </div>
    </div>
  )
}
