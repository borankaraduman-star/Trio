import { useEffect, useRef, useState } from 'react'
import type { RemoteMedia } from '../../voice'
import { useShareSize } from '../../watching/useShareSize'
import { focusedShare, nextShare, shareOrder, useWatch, watchStore } from '../../watching/store'
import { miniPlayers } from '../../watching/mini'

/**
 * CONTRACT-V12-WATCHING §5, "Sinema modu": one share fills the Trio window
 * (the sidebar, the member list and the chat are covered); the controls fade
 * after a few seconds without the pointer moving; a slim line shows who is
 * speaking and the latest chat line (optional). Esc (or the theatre hotkey)
 * leaves; a double click is the real fullscreen on the monitor the window is
 * on; with two or more shares, ← / → or 1–9 switch, and "Yan yana" shows two
 * at once. A phone gets the same with a tap to show the controls.
 *
 * Picture only: the share's sound keeps playing from its stage tile, which
 * stays mounted under the theatre (nothing is heard twice, the V6 volume
 * applies). The theatre reports `full` for what it shows.
 */
const IDLE_MS = 3000
const CHAT_MS = 6000

export function Theatre({
  screens,
  nameOf,
  speaking,
  lastLine,
}: {
  screens: readonly RemoteMedia[]
  nameOf: (userId: number) => string
  /** Names speaking now (mine as "Sen"). */
  speaking: readonly string[]
  /** The newest message of the channel I am in, to fade in at the bottom. */
  lastLine: { id: number; name: string; text: string } | null
}) {
  const watch = useWatch()
  const root = useRef<HTMLDivElement>(null)
  const [controls, setControls] = useState(true)
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [chatOn, setChatOn] = useState(true)
  const [chat, setChat] = useState<{ id: number; name: string; text: string } | null>(null)
  const order = shareOrder(screens.map((media) => media.userId), watch.pinned)
  const current = watch.theatre !== null && order.includes(watch.theatre) ? watch.theatre : null
  const second = watch.theatrePair && order.length >= 2 ? (nextShare(order, current) ?? null) : null
  const shown = [current, second !== current ? second : null].filter((id): id is number => id !== null)

  const poke = () => {
    setControls(true)
    if (idle.current) clearTimeout(idle.current)
    idle.current = setTimeout(() => setControls(false), IDLE_MS)
  }

  useEffect(() => {
    poke()
    root.current?.focus()
    return () => {
      if (idle.current) clearTimeout(idle.current)
    }
  }, [])

  // The share ended: leave the theatre (another share may take it).
  useEffect(() => {
    if (watch.theatre !== null && current === null) {
      const fallback = focusedShare(order, watch.focus, watch.pinned)
      watchStore.update({ theatre: fallback })
    }
  }, [watch.theatre, current, order.join(','), watch.focus, watch.pinned])

  useEffect(() => {
    if (!lastLine || !chatOn) return
    setChat(lastLine)
    const timer = setTimeout(() => setChat(null), CHAT_MS)
    return () => clearTimeout(timer)
  }, [lastLine?.id, chatOn])

  if (current === null) return null

  const leave = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined)
    watchStore.update({ theatre: null })
  }
  const switchTo = (id: number | null) => {
    if (id !== null) watchStore.update({ theatre: id, focus: id })
  }
  const fullscreen = () => {
    const element = root.current
    if (!element) return
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined)
    else {
      void element
        .requestFullscreen?.()
        .then(() => (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape'))
        .catch(() => undefined)
    }
  }
  const onKeyDown = (event: React.KeyboardEvent) => {
    poke()
    if (event.key === 'Escape') {
      event.preventDefault()
      leave()
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault()
      switchTo(nextShare(order, current, event.key === 'ArrowRight' ? 1 : -1))
    } else if (/^[1-9]$/.test(event.key)) {
      const target = order[Number(event.key) - 1]
      if (target !== undefined) {
        event.preventDefault()
        switchTo(target)
      }
    } else if (event.key === 'f' || event.key === 'F') {
      event.preventDefault()
      fullscreen()
    }
  }

  return (
    <div
      ref={root}
      className={`v12-theatre${controls ? ' controls' : ''}${shown.length === 2 ? ' pair' : ''}`}
      data-testid="theatre"
      data-sharer={current}
      data-controls={controls ? 'shown' : 'hidden'}
      role="dialog"
      aria-modal="true"
      aria-label={`Sinema modu: ${nameOf(current)} · ekran`}
      tabIndex={-1}
      onPointerMove={poke}
      onPointerDown={poke}
      onKeyDown={onKeyDown}
    >
      <div className="v12-theatre-screens">
        {shown.map((id) => (
          <TheatreScreen
            key={id}
            media={screens.find((media) => media.userId === id) as RemoteMedia}
            name={nameOf(id)}
            onDoubleClick={fullscreen}
          />
        ))}
      </div>
      <div className="v12-theatre-top">
        <strong data-testid="theatre-title">{shown.map((id) => `${nameOf(id)} · ekran`).join('  ·  ')}</strong>
        {order.length > 1 && (
          <div className="v12-theatre-switch" role="group" aria-label="Paylaşımlar">
            {order.map((id, index) => (
              <button
                key={id}
                type="button"
                className={id === current ? 'on' : undefined}
                data-testid={`theatre-share-${id}`}
                aria-pressed={id === current}
                title={`${nameOf(id)} (${index + 1})`}
                onClick={() => switchTo(id)}
              >
                {index + 1} · {nameOf(id)}
              </button>
            ))}
            <button
              type="button"
              className={watch.theatrePair ? 'on' : undefined}
              data-testid="theatre-pair"
              aria-pressed={watch.theatrePair}
              title="İki paylaşımı yan yana göster"
              onClick={() => watchStore.update({ theatrePair: !watch.theatrePair })}
            >
              Yan yana
            </button>
          </div>
        )}
        <span className="v12-theatre-spacer" />
        <button type="button" data-testid="theatre-chat-toggle" aria-pressed={chatOn} title="Son mesajı göster" onClick={() => setChatOn((on) => !on)}>
          {chatOn ? 'Sohbet: açık' : 'Sohbet: kapalı'}
        </button>
        <button type="button" data-testid="theatre-mini" title="Mini oynatıcıya al (oyundayken köşede kalsın)" onClick={() => void miniPlayers.show(current).then(() => leave())}>
          Mini oynatıcı
        </button>
        <button type="button" data-testid="theatre-fullscreen" title="Tam ekran (F, çift tıklama)" onClick={fullscreen}>
          Tam ekran
        </button>
        <button type="button" className="primary" data-testid="theatre-exit" title="Sinema modundan çık (Esc)" onClick={leave}>
          Çık
        </button>
      </div>
      <div className="v12-theatre-bottom" aria-live="polite">
        {speaking.length > 0 && (
          <span className="v12-theatre-speaking" data-testid="theatre-speaking">
            Konuşuyor: {speaking.join(', ')}
          </span>
        )}
        {chat && (
          <span className="v12-theatre-chat" data-testid="theatre-chat">
            <strong>{chat.name}:</strong> {chat.text}
          </span>
        )}
      </div>
    </div>
  )
}

function TheatreScreen({ media, name, onDoubleClick }: { media: RemoteMedia; name: string; onDoubleClick: () => void }) {
  const video = useRef<HTMLVideoElement>(null)
  useShareSize(media.userId, video, true, 'full')
  useEffect(() => {
    const element = video.current
    if (!element) return
    element.srcObject = media.stream
    void element.play().catch(() => undefined)
    return () => {
      element.srcObject = null
    }
  }, [media.stream])
  return (
    <video
      ref={video}
      className="v12-theatre-video"
      data-testid={`theatre-video-${media.userId}`}
      aria-label={`${name} · ekran`}
      autoPlay
      playsInline
      muted
      onDoubleClick={onDoubleClick}
    />
  )
}
