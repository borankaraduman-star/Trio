import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ApiError } from '../../api'
import { attachmentKind, formatSize } from '../../lib/attachments'
import {
  appendPage,
  attachmentKey,
  fetchAttachments,
  fetchLinks,
  galleryErrorMessage,
  groupByMonth,
  linkKey,
  type GalleryAttachment,
  type GalleryLink,
  type GalleryPage,
  type GalleryTab,
} from '../../lib/gallery'
import { dayLabel, timeLabel } from '../../lib/grouping'
import { linkify } from '../../lib/linkify'
import { CloseIcon, DownloadIcon, FileIcon } from '../icons2'
import { GalleryLightbox } from './GalleryLightbox'

interface List<T> {
  items: T[]
  next: string | null
  hasMore: boolean
  loading: boolean
  error: string | null
  loaded: boolean
}

const EMPTY = { items: [], next: null, hasMore: true, loading: false, error: null, loaded: false }

function when(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : `${dayLabel(date)} ${timeLabel(iso)}`
}

/** The link's address the way the message shows it (lib/linkify.ts), or null. */
function hrefOf(value: string): string | null {
  const part = linkify(value).find((p) => p.type === 'link')
  return part && part.type === 'link' ? part.href : null
}

function useList<T>(load: (before: string | null) => Promise<GalleryPage<T>>, key: (item: T) => string, onUnauthorized: () => void) {
  const [list, setList] = useState<List<T>>(EMPTY)
  const busy = useRef(false)
  const listRef = useRef(list)
  listRef.current = list
  const more = useCallback(async () => {
    const current = listRef.current
    if (busy.current || (!current.hasMore && current.loaded)) return
    busy.current = true
    setList((l) => ({ ...l, loading: true, error: null }))
    try {
      const page = await load(current.loaded ? current.next : null)
      setList((l) => ({
        items: appendPage(l.items, page.items, key),
        next: page.next_before,
        hasMore: page.has_more,
        loading: false,
        error: null,
        loaded: true,
      }))
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onUnauthorized()
      setList((l) => ({ ...l, loading: false, error: galleryErrorMessage(error) }))
    } finally {
      busy.current = false
    }
  }, [load, key, onUnauthorized])
  return { list, more }
}

/** Asks for the next page when the end of the list comes into view. */
function Sentinel({ root, onVisible, active }: { root: HTMLElement | null; onVisible: () => void; active: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = ref.current
    if (!element || !active || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) onVisible()
    }, { root, rootMargin: '400px' })
    observer.observe(element)
    return () => observer.disconnect()
  }, [root, onVisible, active])
  return <div ref={ref} className="gallery-sentinel" aria-hidden="true" />
}

function Status<T>({ list, empty, onRetry }: { list: List<T>; empty: string; onRetry: () => void }) {
  if (list.error) {
    return (
      <p className="gallery-note">
        {list.error}{' '}
        <button type="button" className="link" onClick={onRetry}>
          Tekrar dene
        </button>
      </p>
    )
  }
  if (list.loading) return <p className="gallery-note">Yükleniyor…</p>
  if (list.loaded && list.items.length === 0) return <p className="gallery-note">{empty}</p>
  return null
}

function JumpButton({ messageId, onJump }: { messageId: number; onJump: (id: number) => void }) {
  return (
    <button type="button" className="link gallery-jump" data-testid="gallery-jump" onClick={() => onJump(messageId)}>
      mesaja git
    </button>
  )
}

/**
 * "Medya" (CONTRACT-V6-MEDIA §3): the channel's pictures and videos by month,
 * every link ever posted, and the other files — each newest first, loaded
 * page by page as the list is scrolled.
 */
export function MediaGallery({
  token,
  channelId,
  channelName,
  onClose,
  onJump,
  onUnauthorized,
}: {
  token: string
  channelId: number
  channelName: string
  onClose: () => void
  /** Close the panel and bring the message into view. */
  onJump: (messageId: number) => void
  onUnauthorized: () => void
}) {
  const [tab, setTab] = useState<GalleryTab>('media')
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null)
  const [open, setOpen] = useState<number | null>(null)
  const media = useList<GalleryAttachment>(
    useCallback((before) => fetchAttachments(token, channelId, 'media', before), [token, channelId]),
    attachmentKey,
    onUnauthorized,
  )
  const files = useList<GalleryAttachment>(
    useCallback((before) => fetchAttachments(token, channelId, 'file', before), [token, channelId]),
    attachmentKey,
    onUnauthorized,
  )
  const links = useList<GalleryLink>(
    useCallback((before) => fetchLinks(token, channelId, before), [token, channelId]),
    linkKey,
    onUnauthorized,
  )
  const current = tab === 'media' ? media : tab === 'files' ? files : links

  useEffect(() => {
    if (!current.list.loaded && !current.list.loading && !current.list.error) void current.more()
  }, [current])

  const closeRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && open === null) {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      previous?.focus?.()
    }
  }, [onClose, open])

  const loadMoreMedia = useCallback(() => void media.more(), [media])
  const jump = (messageId: number) => {
    setOpen(null)
    onJump(messageId)
  }

  const tabs: { id: GalleryTab; label: string }[] = [
    { id: 'media', label: 'Medya' },
    { id: 'links', label: 'Bağlantılar' },
    { id: 'files', label: 'Dosyalar' },
  ]

  return createPortal(
    <div className="gallery-backdrop" data-testid="gallery-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <section className="gallery-panel" role="dialog" aria-modal="true" aria-label={`#${channelName} kanalında paylaşılanlar`} data-testid="media-gallery">
        <header className="gallery-header">
          <h2>
            Paylaşılanlar <span className="gallery-channel">#{channelName}</span>
          </h2>
          <button ref={closeRef} type="button" className="icon-button" data-testid="gallery-close" aria-label="Kapat" title="Kapat (Esc)" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>
        <div className="gallery-tabs" role="tablist">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={tab === t.id ? 'active' : undefined}
              data-testid={`gallery-tab-${t.id}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="gallery-scroll" ref={setScroller} data-testid="gallery-scroll">
          {tab === 'media' && (
            <>
              {groupByMonth(media.list.items).map((group) => (
                <section key={group.label} className="gallery-month">
                  <h3 data-testid="gallery-month">{group.label}</h3>
                  <ul className="gallery-grid">
                    {group.items.map((item) => {
                      const index = media.list.items.indexOf(item)
                      const { attachment } = item
                      const video = attachmentKind(attachment.content_type) === 'video'
                      return (
                        <li key={attachment.id}>
                          <button
                            type="button"
                            className="gallery-item"
                            data-testid="gallery-item"
                            data-kind={video ? 'video' : 'image'}
                            data-message-id={item.message_id}
                            aria-label={`${attachment.filename} — ${item.author.name}`}
                            onClick={() => setOpen(index)}
                          >
                            {video ? (
                              <>
                                <video src={`${attachment.url}#t=0.1`} preload="metadata" muted playsInline tabIndex={-1} />
                                <span className="gallery-play" aria-hidden="true">▶</span>
                              </>
                            ) : (
                              <img src={attachment.preview_url ?? attachment.url} alt="" loading="lazy" decoding="async" />
                            )}
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                </section>
              ))}
              <Status list={media.list} empty="Bu kanalda henüz fotoğraf ya da video yok." onRetry={() => void media.more()} />
            </>
          )}
          {tab === 'links' && (
            <>
              <ul className="gallery-rows">
                {links.list.items.map((item) => {
                  const href = hrefOf(item.url)
                  return (
                    <li key={linkKey(item)} className="gallery-row" data-testid="gallery-link" data-message-id={item.message_id}>
                      {href ? (
                        <a className="gallery-link-url" href={href} target="_blank" rel="noopener noreferrer">
                          {item.url}
                        </a>
                      ) : (
                        <span className="gallery-link-url">{item.url}</span>
                      )}
                      <span className="gallery-row-meta">
                        {item.author.name} · {when(item.created_at)} · <JumpButton messageId={item.message_id} onJump={jump} />
                      </span>
                      {item.excerpt && <span className="gallery-excerpt">{item.excerpt}</span>}
                    </li>
                  )
                })}
              </ul>
              <Status list={links.list} empty="Bu kanalda henüz bağlantı paylaşılmadı." onRetry={() => void links.more()} />
            </>
          )}
          {tab === 'files' && (
            <>
              <ul className="gallery-rows">
                {files.list.items.map((item) => (
                  <li key={item.attachment.id} className="gallery-row gallery-file" data-testid="gallery-file" data-message-id={item.message_id}>
                    <span className="attachment-file-icon">
                      <FileIcon size={20} />
                    </span>
                    <span className="gallery-file-text">
                      <a href={item.attachment.url} download={item.attachment.filename} target="_blank" rel="noopener noreferrer">
                        {item.attachment.filename}
                      </a>
                      <span className="gallery-row-meta">
                        {formatSize(item.attachment.size)} · {item.author.name} · {when(item.created_at)} ·{' '}
                        <JumpButton messageId={item.message_id} onJump={jump} />
                      </span>
                    </span>
                    <a
                      className="icon-button"
                      href={item.attachment.url}
                      download={item.attachment.filename}
                      aria-label={`İndir: ${item.attachment.filename}`}
                      title="İndir"
                    >
                      <DownloadIcon />
                    </a>
                  </li>
                ))}
              </ul>
              <Status list={files.list} empty="Bu kanalda henüz dosya paylaşılmadı." onRetry={() => void files.more()} />
            </>
          )}
          <Sentinel
            key={tab}
            root={scroller}
            active={current.list.loaded && current.list.hasMore && !current.list.error}
            onVisible={() => void current.more()}
          />
        </div>
      </section>
      {open !== null && (
        <GalleryLightbox
          items={media.list.items}
          index={open}
          onIndex={setOpen}
          onClose={() => setOpen(null)}
          onJump={jump}
          onNeedMore={loadMoreMedia}
        />
      )}
    </div>,
    document.body,
  )
}

export function MediaButton({ active, onClick }: { active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`icon-button media-button${active ? ' active' : ''}`}
      data-testid="btn-media"
      aria-label="Medya"
      title="Medya, bağlantılar ve dosyalar"
      onClick={onClick}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3" y="3" width="18" height="18" rx="3" />
        <circle cx="9" cy="9" r="2" />
        <path d="M21 15l-5-5L5 21" />
      </svg>
    </button>
  )
}
