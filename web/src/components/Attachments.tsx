import { memo, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { attachmentKind, formatSize } from '../lib/attachments'
import type { PendingAttachment } from '../lib/pending'
import type { Attachment } from '../types'
import { CloseIcon, DownloadIcon, FileIcon } from './icons2'
import { OriginalToggle, PendingSize } from './media/PendingPhoto'
import { VoiceMessage } from './media/VoiceMessage'
import { attachmentBoxStyle } from '../lib/imageBox'

/** Full-size image over the page. Esc, the close button or a click outside the image closes it. */
function Lightbox({ attachment, onClose }: { attachment: Attachment; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      previous?.focus?.()
    }
  }, [onClose])

  return createPortal(
    <div
      className="lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={attachment.filename}
      data-testid="lightbox"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="lightbox-bar">
        <span className="lightbox-name">{attachment.filename}</span>
        <a className="icon-button" href={attachment.url} download={attachment.filename} title="İndir" aria-label="İndir">
          <DownloadIcon />
        </a>
        <button
          ref={closeRef}
          type="button"
          className="icon-button"
          data-testid="lightbox-close"
          title="Kapat (Esc)"
          aria-label="Kapat"
          onClick={onClose}
        >
          <CloseIcon />
        </button>
      </div>
      <img src={attachment.url} alt={attachment.filename} onClick={(event) => event.stopPropagation()} />
    </div>,
    document.body,
  )
}

function ImageAttachment({ attachment }: { attachment: Attachment }) {
  const [open, setOpen] = useState(false)
  const [failed, setFailed] = useState(false)
  const [loaded, setLoaded] = useState(false)
  if (failed) return <FileAttachment attachment={attachment} />
  return (
    <>
      <button
        type="button"
        className={`attachment-box attachment-image${attachmentBoxStyle(attachment) ? ' sized' : ''}`}
        style={attachmentBoxStyle(attachment) ?? undefined}
        data-testid="attachment-image"
        title={`${attachment.filename} — büyütmek için tıkla`}
        aria-label={`Resmi büyüt: ${attachment.filename}`}
        onClick={() => setOpen(true)}
      >
        <img
          src={attachment.preview_url ?? attachment.url}
          alt={attachment.filename}
          loading="lazy"
          decoding="async"
          className={loaded ? 'loaded' : undefined}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
        />
      </button>
      {open && <Lightbox attachment={attachment} onClose={() => setOpen(false)} />}
    </>
  )
}

function FileAttachment({ attachment }: { attachment: Attachment }) {
  return (
    <div className="attachment-file" data-testid="attachment-file">
      <span className="attachment-file-icon">
        <FileIcon size={22} />
      </span>
      <span className="attachment-file-text">
        <a href={attachment.url} download={attachment.filename} target="_blank" rel="noopener noreferrer">
          {attachment.filename}
        </a>
        <span className="attachment-file-size">{formatSize(attachment.size)}</span>
      </span>
      <a
        className="icon-button"
        href={attachment.url}
        download={attachment.filename}
        target="_blank"
        rel="noopener noreferrer"
        title="İndir"
        aria-label={`İndir: ${attachment.filename}`}
      >
        <DownloadIcon />
      </a>
    </div>
  )
}

function AttachmentView({ attachment }: { attachment: Attachment }) {
  // V6: a voice message is a compact player, whatever its audio type.
  if (attachment.voice) return <VoiceMessage attachment={attachment} voice={attachment.voice} />
  switch (attachmentKind(attachment.content_type)) {
    case 'image':
      return <ImageAttachment attachment={attachment} />
    case 'video':
      return (
        <div className="attachment-media">
          <video
            className="attachment-box"
            data-testid="attachment-video"
            src={attachment.url}
            controls
            preload="metadata"
            playsInline
          />
          <span className="attachment-caption">{attachment.filename}</span>
        </div>
      )
    case 'audio':
      return (
        <div className="attachment-media">
          <span className="attachment-caption">
            {attachment.filename} · {formatSize(attachment.size)}
          </span>
          <audio data-testid="attachment-audio" src={attachment.url} controls preload="none" />
        </div>
      )
    default:
      // svg, html and everything unknown: a download, never rendered.
      return <FileAttachment attachment={attachment} />
  }
}

/** The attachments of one message, in the order they were sent. */
export const MessageAttachments = memo(function MessageAttachments({
  attachments,
}: {
  attachments: readonly Attachment[] | undefined
}) {
  if (!attachments || attachments.length === 0) return null
  return (
    <div className="attachments">
      {attachments.map((attachment) => (
        <AttachmentView key={attachment.id} attachment={attachment} />
      ))}
    </div>
  )
})

function Thumbnail({ file, type }: { file: File | null; type: string }) {
  const [url, setUrl] = useState<string | null>(null)
  // A picture this browser cannot decode (HEIC on Chromium): the file icon, not a broken image.
  const [broken, setBroken] = useState(false)
  useEffect(() => {
    if (!file || !type.startsWith('image/')) return
    const objectUrl = URL.createObjectURL(file)
    setUrl(objectUrl)
    setBroken(false)
    return () => URL.revokeObjectURL(objectUrl)
  }, [file, type])
  if (!url || broken) return <FileIcon size={20} />
  return <img src={url} alt="" onError={() => setBroken(true)} />
}

/** The chips above the composer. */
export function PendingAttachments({
  items,
  files,
  onRemove,
  sendOriginal = false,
  onToggleOriginal,
}: {
  items: readonly PendingAttachment[]
  /** Local files by pending id, for image thumbnails. */
  files?: ReadonlyMap<string, File>
  onRemove: (localId: string) => void
  /** V6: "Orijinali gönder" (per device) and its switch, shown on a picture it changes. */
  sendOriginal?: boolean
  onToggleOriginal?: (value: boolean) => void
}) {
  if (items.length === 0) return null
  return (
    <ul className="pending-attachments" aria-label="Eklenecek dosyalar">
      {items.map((item) => {
        const percent = Math.round(item.progress * 100)
        return (
          <li
            key={item.localId}
            className={`pending-attachment ${item.status}`}
            data-testid="pending-attachment"
            data-status={item.status}
          >
            <span className="pending-thumb">
              <Thumbnail file={files?.get(item.localId) ?? null} type={item.type} />
            </span>
            <span className="pending-text">
              <span className="pending-name" title={item.name}>
                {item.name}
              </span>
              <span className="pending-meta">
                {item.status === 'queued' &&
                  (item.preparing
                    ? 'Hazırlanıyor…'
                    : item.waiting
                      ? 'Başka bir yükleme bitince denenecek…'
                      : 'Sırada bekliyor…')}
                {item.status === 'uploading' && `Yükleniyor… %${percent}`}
                {item.status === 'done' && <PendingSize item={item} />}
                {item.status === 'error' && (item.error ?? 'Yüklenemedi.')}
              </span>
              {item.reducible && onToggleOriginal && item.status !== 'error' && (
                <OriginalToggle checked={sendOriginal} onChange={onToggleOriginal} />
              )}
              {item.status === 'uploading' && (
                <span
                  className="pending-progress"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={percent}
                  aria-label={`${item.name} yükleniyor`}
                >
                  <span style={{ width: `${percent}%` }} />
                </span>
              )}
            </span>
            <button
              type="button"
              className="icon-button small"
              data-testid="pending-remove"
              title={item.status === 'uploading' || item.status === 'queued' ? 'Yüklemeyi iptal et' : 'Kaldır'}
              aria-label={`${item.status === 'uploading' || item.status === 'queued' ? 'Yüklemeyi iptal et' : 'Kaldır'}: ${item.name}`}
              onClick={() => onRemove(item.localId)}
            >
              <CloseIcon size={14} />
            </button>
          </li>
        )
      })}
    </ul>
  )
}
