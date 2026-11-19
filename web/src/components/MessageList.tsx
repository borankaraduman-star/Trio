import { memo, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react'
import { buildRows, dayLabel, timeLabel } from '../lib/grouping'
import { linkify } from '../lib/linkify'
import { captureAnchor, restoreAnchor, type Anchor } from '../lib/scrollAnchor'
import './message-list-jump.css'
import type { ChannelMessages, UiMessage } from '../store'
import { MessageAttachments } from './Attachments'
import { Avatar } from './Avatar'
import { namesSignature, resolveAuthor, stablePeople, type People } from '../lib/identity'
import type { Member, User } from '../types'
import { MessageFamilyLayer, useRowFamily, type ListFamily, type RowFamily } from './message/MessageFamilyLayer'
import { MessageActions } from './message/MessageActions'
import { ReactionChips } from './message/ReactionChips'
import { ReplyQuote } from './message/ReplyQuote'
import { MessageEditor } from './message/MessageEditor'
import { EditedMark, PinMark } from './message/MessageMarks'

const NEAR_EDGE_PX = 120

/** Message text: plain text nodes and anchors. Never HTML. */
const Content = memo(function Content({ text, after }: { text: string; after?: ReactNode }) {
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
      {after}
    </div>
  )
})

/** The other people a row names: the reply's author, who reacted, who pinned. */
function* namedIn(message: UiMessage): Generator<number> {
  const reply = message.reply_to
  if (reply && !reply.deleted) yield reply.author.id
  for (const reaction of message.reactions ?? []) yield* reaction.user_ids
  if (message.pinned_by != null) yield message.pinned_by
}

const MessageRow = memo(function MessageRow({
  message,
  author = message.author,
  showHeader,
  former,
  onRetry,
  family,
  editing = false,
}: {
  message: UiMessage
  /** v4: the author as shown now (current name and avatar), else the message's snapshot. */
  author?: User
  showHeader: boolean
  /** v3: the author is no longer a member (removed by the admin). */
  former: boolean
  onRetry: (message: UiMessage) => void
  /** v4: the message family's callbacks (one stable object for every row). */
  family?: RowFamily
  /** v4: this row is being edited in place. */
  editing?: boolean
  /**
   * v4: the current names of the other people this row shows (reply author,
   * reactors, pinner; lib/identity.ts `namesSignature`). Only there so that a
   * rename re-renders exactly the rows that show the renamed person; the
   * names themselves are read through `family`.
   */
  names?: string
}) {
  const time = timeLabel(message.created_at)
  family?.probe(message.key)
  const sent = message.status === 'sent'
  return (
    <li
      className={`message${showHeader ? ' with-header' : ''} ${message.status}${message.pinned_at ? ' pinned' : ''}`}
      data-testid="message"
      data-key={message.key}
      data-status={message.status}
      data-author-id={message.author.id}
      data-message-id={sent ? message.id : undefined}
      tabIndex={sent && family ? 0 : undefined}
    >
      <div className="message-gutter">
        {showHeader ? (
          <Avatar id={author.id} name={author.name} size={38} url={author.avatar_url} />
        ) : (
          <time className="message-hover-time">{time}</time>
        )}
      </div>
      <div className="message-body">
        {showHeader && (
          <div className="message-header">
            <strong data-testid="message-author">{author.name}</strong>
            {former && (
              <span className="author-former" data-testid="author-former" title="Bu hesap sunucudan kaldırıldı">
                eski üye
              </span>
            )}
            <time dateTime={message.created_at}>{time}</time>
          </div>
        )}
        {message.reply_to && family && (
          <ReplyQuote
            reply={message.reply_to}
            authorName={message.reply_to.deleted ? undefined : family.currentName(message.reply_to.author.id)}
            onJump={family.onJump}
          />
        )}
        {editing && family ? (
          <MessageEditor
            initial={message.pendingEdit ?? message.content}
            hasAttachments={(message.attachments?.length ?? 0) > 0}
            onSave={(content) => family.onSaveEdit(message, content)}
            onCancel={family.onCancelEdit}
          />
        ) : (message.pendingEdit ?? message.content) !== '' ? (
          <Content
            text={message.pendingEdit ?? message.content}
            after={(message.edited_at || message.pendingEdit !== undefined) && <EditedMark at={message.edited_at ?? null} />}
          />
        ) : (
          (message.edited_at || message.pendingEdit !== undefined) && (
            <div className="message-content">
              <EditedMark at={message.edited_at ?? null} />
            </div>
          )
        )}
        <MessageAttachments attachments={message.attachments} />
        {family && message.reactions && message.reactions.length > 0 && (
          <ReactionChips
            reactions={message.reactions}
            meId={family.meId}
            nameOf={family.nameOf}
            onToggle={(key) => family.onToggleReaction(message, key)}
            onAdd={(anchor) => family.onAction(message, 'react', anchor)}
          />
        )}
        {message.status === 'failed' && (
          <div className="message-failed">
            Gönderilemedi.{' '}
            <button type="button" className="link" onClick={() => onRetry(message)}>
              Tekrar dene
            </button>
          </div>
        )}
      </div>
      {family && sent && message.pinned_at && <PinMark by={message.pinned_by != null ? family.nameOf(message.pinned_by) : null} />}
      {family && sent && !editing && (
        <MessageActions own={message.author.id === family.meId} onAction={(kind, anchor) => family.onAction(message, kind, anchor)} />
      )}
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
  users,
  family,
}: {
  channel: ChannelMessages
  /** v4: current members, so a row shows its author's current name and avatar. */
  users?: Record<number, Member>
  myId: number
  /** Whether an author id is a current member; unknown authors are shown as former members. */
  isMember?: (userId: number) => boolean
  onLoadOlder: () => void
  onRetryLoad: () => void
  onRetry: (message: UiMessage) => void
  /** The list is `behind` (a gap after a long drop): load the newest and go there. */
  onJumpToLatest?: () => void
  onAtBottomChange?: (atBottom: boolean) => void
  /** v4: edit, delete, reactions, replies, pins (components/message). */
  family?: ListFamily
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const previous = useRef<{ lastKey?: string }>({})
  /** The row being read; kept in place across every change of the list (lib/scrollAnchor.ts). */
  const anchor = useRef<Anchor | null>(null)
  const reportedAtBottom = useRef(true)
  const rows = useMemo(() => buildRows(channel.items), [channel.items])
  const { items, hasMore, loadingOlder, loaded } = channel
  const rowFamily = useRowFamily(family, myId)
  // Names and avatars without presence: somebody coming online re-renders no row.
  const peopleRef = useRef<People>({})
  const people = useMemo(() => (peopleRef.current = stablePeople(peopleRef.current, users)), [users])
  const jumpHandled = useRef(0)

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
    // v4: a quoted or pinned message to bring into view, once its row is there.
    const jump = family?.jump
    if (jump && jump.seq !== jumpHandled.current) {
      const row = element.querySelector<HTMLElement>(`[data-message-id="${jump.messageId}"]`)
      if (row) {
        jumpHandled.current = jump.seq
        stickToBottom.current = false
        rowFamily.reveal(element, row)
        family.onJumpDone()
      }
    }
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
      <ol className="message-list" {...rowFamily.gestures}>
        {rows.map((row) =>
          row.type === 'day' ? (
            <li key={row.key} className="day-separator" role="separator">
              <span>{dayLabel(row.date)}</span>
            </li>
          ) : (
            <MessageRow
              key={row.key}
              message={row.message}
              author={resolveAuthor(row.message.author, people)}
              showHeader={row.showHeader}
              former={isMember ? !isMember(row.message.author.id) : false}
              onRetry={onRetry}
              family={rowFamily.row}
              editing={family?.editingId === row.message.id && row.message.status === 'sent'}
              names={family ? namesSignature(namedIn(row.message), people) : ''}
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
      {family && <MessageFamilyLayer family={family} items={items} myId={myId} rowFamily={rowFamily} />}
    </div>
  )
}
