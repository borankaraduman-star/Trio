import type { ChannelPins } from '../../store'
import type { Member, Message } from '../../types'
import { resolveAuthor } from '../../lib/identity'
import { Avatar } from '../Avatar'
import { excerptOf } from '../../lib/replyQuote'
import { timeLabel, dayLabel } from '../../lib/grouping'
import { PinIcon } from './icons'
import { Popover, type AnchorRect } from './Popover'

function when(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '' : `${dayLabel(date)} ${timeLabel(iso)}`
}

/** "Sabitlenenler": the channel's pins, newest pin first; jump to one, or unpin it. */
export function PinsPanel({
  channelName,
  pins,
  anchor,
  nameOf,
  users,
  onJump,
  onUnpin,
  onRetry,
  onClose,
}: {
  channelName: string
  pins: ChannelPins | undefined
  anchor: AnchorRect | null
  nameOf: (id: number) => string
  /** v4: current members (name and avatar now, the pin's snapshot for a former member). */
  users?: Record<number, Member>
  onJump: (message: Message) => void
  onUnpin: (message: Message) => void
  onRetry: () => void
  onClose: () => void
}) {
  const items = pins?.items ?? []
  return (
    <Popover anchor={anchor} onClose={onClose} label="Sabitlenenler" className="pins-panel" testId="pins-panel">
      <header className="pins-header">
        <PinIcon size={16} />
        <h2>Sabitlenenler</h2>
        <span className="pins-channel">#{channelName}</span>
      </header>
      {pins?.error && !pins.loaded ? (
        <p className="pins-note">
          Sabitlenenler yüklenemedi.{' '}
          <button type="button" className="link" onClick={onRetry}>
            Tekrar dene
          </button>
        </p>
      ) : !pins?.loaded ? (
        <p className="pins-note">Yükleniyor…</p>
      ) : items.length === 0 ? (
        <p className="pins-note">Bu kanalda sabitlenmiş mesaj yok. Bir mesajın menüsünden “Sabitle”yi seç.</p>
      ) : (
        <ol className="pins-list">
          {items.map((message) => {
            const author = resolveAuthor(message.author, users)
            return (
              <li key={message.id} className="pin-item" data-testid="pin-item" data-message-ref={message.id}>
                <Avatar id={author.id} name={author.name} size={28} url={author.avatar_url} />
                <button type="button" className="pin-jump" onClick={() => onJump(message)} title="Mesaja git" data-testid="pin-jump">
                  <span className="pin-meta">
                    <strong data-testid="pin-author">{author.name}</strong>
                    <time dateTime={message.created_at}>{when(message.created_at)}</time>
                  </span>
                  <span className="pin-text">{excerptOf(message)}</span>
                  {message.pinned_by != null && <span className="pin-by">Sabitleyen: {nameOf(message.pinned_by)}</span>}
                </button>
                <button type="button" className="link pin-unpin" onClick={() => onUnpin(message)} data-testid="pin-unpin">
                  Kaldır
                </button>
              </li>
            )
          })}
        </ol>
      )}
    </Popover>
  )
}
