import { memo, useLayoutEffect, useMemo, useRef } from 'react'
import { buildRows, dayLabel, timeLabel } from '../lib/grouping'
import { linkify } from '../lib/linkify'
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
  onRetry,
}: {
  message: UiMessage
  showHeader: boolean
  onRetry: (message: UiMessage) => void
}) {
  const time = timeLabel(message.created_at)
  return (
    <li
      className={`message${showHeader ? ' with-header' : ''} ${message.status}`}
      data-testid="message"
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
}: {
  channel: ChannelMessages
  myId: number
  onLoadOlder: () => void
  onRetryLoad: () => void
  onRetry: (message: UiMessage) => void
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const previous = useRef<{ firstKey?: string; lastKey?: string; height: number }>({ height: 0 })
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
    const firstKey = items[0]?.key
    const last = items[items.length - 1]
    const before = previous.current
    const prepended =
      before.firstKey !== undefined && firstKey !== before.firstKey && last?.key === before.lastKey
    const ownNew = last !== undefined && last.key !== before.lastKey && last.author.id === myId

    if (prepended) {
      // Older messages were added above: keep what the reader sees in place.
      element.scrollTop += element.scrollHeight - before.height
    } else if (stickToBottom.current || ownNew) {
      element.scrollTop = element.scrollHeight
      stickToBottom.current = true
    }
    previous.current = { firstKey, lastKey: last?.key, height: element.scrollHeight }
    // A page that does not fill the view cannot be scrolled to ask for more.
    maybeLoadOlder()
  })

  const onScroll = () => {
    const element = scroller.current
    if (!element) return
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight
    stickToBottom.current = distance < NEAR_EDGE_PX
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
              onRetry={onRetry}
            />
          ),
        )}
      </ol>
    </div>
  )
}
