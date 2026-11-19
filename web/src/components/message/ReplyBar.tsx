import type { Message } from '../../types'
import { excerptOf } from '../../lib/replyQuote'
import { CloseIcon } from '../icons2'
import { ReplyIcon } from './icons'

/** Above the composer while replying: who and what; Esc or × lets it go. */
export function ReplyBar({ message, onCancel }: { message: Message; onCancel: () => void }) {
  return (
    <div className="reply-bar" data-testid="reply-bar">
      <ReplyIcon size={15} />
      <span className="reply-bar-text">
        Yanıtlanıyor: <strong>{message.author.name}</strong> <span className="reply-bar-excerpt">{excerptOf(message)}</span>
      </span>
      <button type="button" className="icon-button" aria-label="Yanıtı iptal et" title="Yanıtı iptal et (Esc)" onClick={onCancel} data-testid="reply-cancel">
        <CloseIcon size={16} />
      </button>
    </div>
  )
}
