import { memo, useLayoutEffect, useMemo, useRef } from 'react'
import { buildRows, dayLabel, timeLabel } from '../lib/grouping'
import { linkify } from '../lib/linkify'
import { captureAnchor, restoreAnchor, type Anchor } from '../lib/scrollAnchor'
import './message-list-jump.css'
import type { ChannelMessages, UiMessage } from '../store'
import { MessageAttachments } from './Attachments'
import { Avatar } from './Avatar'

const NEAR_EDGE_PX = 120

/** Message text: plain text nodes and anchors. Never HTML. */
const Content = memo(function Content({ text }: { text: string }) {
  const parts = useMemo(() => linkify(text), [text])
  return (
    <div className="message-content">
      {parts.map((part, index) =>
        part.type === 'link' ? (
          <a key={index} href={part.href} target="_blank" rel="noopener noreferrer">
            {part.value}
          </a>
        ) : (
          <span key={index}>{part.value}</span>
        ),
      )}
    </div>
  )
})

const MessageRow = memo(function MessageRow({
  message,
  showHeader,
  former,
  onRetry,
}: {
  message: UiMessage
  showHeader: boolean
  /** v3: the author is no longer a member (removed by the admin). */
  former: boolean
  onRetry: (message: UiMessage) => void
}) {
  const time = timeLabel(message.created_at)
  return (
    <li
      className={`message${showHeader ? ' with-header' : ''} ${message.status}`}
      data-testid="message"
      data-key={message.key}
      data-status={message.status}
      data-author-id={message.author.id}
    >
      <div className="message-gutter">
        {showHeader ? (
          <Avatar id={message.author.id} name={message.author.name} size={38} />
        ) : (
          <time className="message-hover-time">{time}</time>
        )}
      </div>
      <div className="message-body">
        {showHeader && (
          <div className="message-header">
            <strong>{message.author.name}</strong>
            {former && (
              <span className="author-former" data-testid="author-former" title="Bu hesap sunucudan kaldırıldı">
                eski üye
              </span>
            )}
            <time dateTime={message.created_at}>{time}</time>
          </div>
        )}
        {message.content !== '' && <Content text={message.content} />}
        <MessageAttachments attachments={message.attachments} />
        {message.status === 'failed' && (
          <div className="message-failed">
            Gönderilemedi.{' '}
            <button type="button" className="link" onClick={() => onRetry(message)}>
              Tekrar dene
            </button>
          </div>
        )}
      </div>
    </li>
  )
})

export function MessageList({
  channel,
  myId,
  onLoadOlder,
  onRetryLoad,
  onRetry,
  onJumpToLatest,
  onAtBottomChange,
  isMember,
}: {
  channel: ChannelMessages
  myId: number
  /** Whether an author id is a current member; unknown authors are shown as former members. */
  isMember?: (userId: number) => boolean
  onLoadOlder: () => void
  onRetryLoad: () => void
  onRetry: (message: UiMessage) => void
  /** The list is `behind` (a gap after a long drop): load the newest and go there. */
  onJumpToLatest?: () => void
  onAtBottomChange?: (atBottom: boolean) => void
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const previous = useRef<{ lastKey?: string }>({})
  /** The row being read; kept in place across every change of the list (lib/scrollAnchor.ts). */
  const anchor = useRef<Anchor | null>(null)
  const reportedAtBottom = useRef(true)
  const rows = useMemo(() => buildRows(channel.items), [channel.items])
  const { items, hasMore, loadingOlder, loaded } = channel

  const maybeLoadOlder = () => {
    const element = scroller.current
    if (!element || !loaded || !hasMore || loadingOlder) return
    if (element.scrollTop < NEAR_EDGE_PX) onLoadOlder()
  }

  useLayoutEffect(() => {
    const element = scroller.current
    if (!element) return
    const last = items[items.length - 1]
    const before = previous.current
    const ownNew = last !== undefined && last.key !== before.lastKey && last.author.id === myId

    if (stickToBottom.current || ownNew) {
      element.scrollTop = element.scrollHeight
      stickToBottom.current = true
    } else if (anchor.current) {
      // Older messages above, a merge after a reconnect: what the reader sees stays put.
      restoreAnchor(element, anchor.current)
    }
    previous.current = { lastKey: last?.key }
    anchor.current = captureAnchor(element)
    // A page that does not fill the view cannot be scrolled to ask for more.
    maybeLoadOlder()
  })

  const onScroll = () => {
    const element = scroller.current
    if (!element) return
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight
    const atBottom = distance < NEAR_EDGE_PX
    if (atBottom !== reportedAtBottom.current) {
      reportedAtBottom.current = atBottom
      onAtBottomChange?.(atBottom)
    }
    stickToBottom.current = atBottom
    anchor.current = captureAnchor(element)
    maybeLoadOlder()
  }

  return (
    <div className="message-scroll" ref={scroller} onScroll={onScroll} data-testid="message-list">
      {channel.error && (
        <div className="list-note">
          Mesajlar yüklenemedi.{' '}
          <button type="button" className="link" onClick={onRetryLoad}>
            Tekrar dene
          </button>
        </div>
      )}
      {!loaded && !channel.error && <div className="list-note">Yükleniyor…</div>}
      {loaded && loadingOlder && <div className="list-note">Eski mesajlar yükleniyor…</div>}
      {loaded && !hasMore && (
        <div className="list-note start">
          {items.length === 0 ? 'Henüz mesaj yok. İlk mesajı sen yaz!' : 'Kanalın başlangıcı.'}
        </div>
      )}
      <ol className="message-list">
        {rows.map((row) =>
          row.type === 'day' ? (
            <li key={row.key} className="day-separator" role="separator">
              <span>{dayLabel(row.date)}</span>
            </li>
          ) : (
            <MessageRow
              key={row.key}
              message={row.message}
              showHeader={row.showHeader}
              former={isMember ? !isMember(row.message.author.id) : false}
              onRetry={onRetry}
            />
          ),
        )}
      </ol>
      {channel.behind && onJumpToLatest && (
        <button
          type="button"
          className="jump-to-latest"
          data-testid="jump-to-latest"
          onClick={() => {
            stickToBottom.current = true
            onJumpToLatest()
          }}
        >
          Yeni mesajlar var — en yeniye git
        </button>
      )}
    </div>
  )
}
