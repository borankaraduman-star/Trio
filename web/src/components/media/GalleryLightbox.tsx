import { useEffect, useRef, type PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { attachmentKind } from '../../lib/attachments'
import { monthLabel, step, swipeDirection, type GalleryAttachment } from '../../lib/gallery'
import { CloseIcon, DownloadIcon } from '../icons2'

/**
 * The gallery's lightbox (CONTRACT-V6-MEDIA §3): the ORIGINAL file, previous
 * and next through the whole gallery (arrow keys, the buttons, a swipe), Esc
 * or a click outside closes, "mesaja git" jumps to the message. Asks for more
 * when it reaches the last loaded item.
 */
export function GalleryLightbox({
  items,
  index,
  onIndex,
  onClose,
  onJump,
  onNeedMore,
}: {
  items: readonly GalleryAttachment[]
  index: number
  onIndex: (index: number) => void
  onClose: () => void
  onJump: (messageId: number) => void
  onNeedMore: () => void
}) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const swipe = useRef<{ x: number; y: number; id: number } | null>(null)
  const item = items[index]
  const state = useRef({ index, length: items.length, onIndex, onClose })
  state.current = { index, length: items.length, onIndex, onClose }

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      const { index: at, length, onIndex: go, onClose: close } = state.current
      if (event.key === 'Escape') close()
      else if (event.key === 'ArrowRight') go(step(at, 1, length))
      else if (event.key === 'ArrowLeft') go(step(at, -1, length))
      else return
      event.preventDefault()
      event.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      previous?.focus?.()
    }
  }, [])

  useEffect(() => {
    if (index >= items.length - 2) onNeedMore()
  }, [index, items.length, onNeedMore])

  if (!item) return null
  const { attachment } = item
  const video = attachmentKind(attachment.content_type) === 'video'

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'mouse') return
    swipe.current = { x: event.clientX, y: event.clientY, id: event.pointerId }
  }
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const start = swipe.current
    swipe.current = null
    if (!start || start.id !== event.pointerId) return
    const direction = swipeDirection(event.clientX - start.x, event.clientY - start.y)
    if (direction !== 0) onIndex(step(index, direction, items.length))
  }

  return createPortal(
    <div
      className="lightbox gallery-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={attachment.filename}
      data-testid="gallery-lightbox"
      data-index={index}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={() => (swipe.current = null)}
    >
      <div className="lightbox-bar">
        <span className="lightbox-name">
          {attachment.filename}
          <small>
            {' '}
            · {item.author.name} · {monthLabel(item.created_at)} · {index + 1}/{items.length}
          </small>
        </span>
        <button
          type="button"
          className="link gallery-jump"
          data-testid="gallery-lightbox-jump"
          onClick={() => onJump(item.message_id)}
        >
          mesaja git
        </button>
        <a className="icon-button" href={attachment.url} download={attachment.filename} title="İndir" aria-label="İndir">
          <DownloadIcon />
        </a>
        <button ref={closeRef} type="button" className="icon-button" data-testid="gallery-lightbox-close" title="Kapat (Esc)" aria-label="Kapat" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>
      <button
        type="button"
        className="gallery-nav prev"
        data-testid="gallery-prev"
        aria-label="Önceki"
        disabled={index === 0}
        onClick={() => onIndex(step(index, -1, items.length))}
      >
        ‹
      </button>
      {video ? (
        <video key={attachment.id} src={attachment.url} controls playsInline preload="metadata" data-testid="gallery-lightbox-video" />
      ) : (
        <img key={attachment.id} src={attachment.url} alt={attachment.filename} data-testid="gallery-lightbox-image" />
      )}
      <button
        type="button"
        className="gallery-nav next"
        data-testid="gallery-next"
        aria-label="Sonraki"
        disabled={index >= items.length - 1}
        onClick={() => onIndex(step(index, 1, items.length))}
      >
        ›
      </button>
    </div>,
    document.body,
  )
}
