import type { Message } from '../../types'
import { excerptOf } from '../../lib/replyQuote'
import { CloseIcon } from '../icons2'
import { ReplyIcon } from './icons'

/** Above the composer while replying: who and what; Esc or × lets it go. */
export function ReplyBar({
  message,
  authorName,
  onCancel,
}: {
  message: Message
  /** v4: the author's current name when still a member. */
  authorName?: string
  onCancel: () => void
}) {
  return (
    <div className="reply-bar" data-testid="reply-bar">
      <ReplyIcon size={15} />
      <span className="reply-bar-text">
        Yanıtlanıyor: <strong>{authorName ?? message.author.name}</strong> <span className="reply-bar-excerpt">{excerptOf(message)}</span>
      </span>
      <button type="button" className="icon-button" aria-label="Yanıtı iptal et" title="Yanıtı iptal et (Esc)" onClick={onCancel} data-testid="reply-cancel">
        <CloseIcon size={16} />
      </button>
    </div>
  )
}
