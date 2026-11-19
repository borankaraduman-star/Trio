import type { ReplyRef } from '../../types'
import { ReplyIcon } from './icons'

/** The compact quote above a reply's text; a click jumps to the original. */
export function ReplyQuote({
  reply,
  authorName,
  onJump,
}: {
  reply: ReplyRef
  /** v4: the quoted author's CURRENT name when they are still a member (else the quote's own). */
  authorName?: string
  onJump: (messageId: number) => void
}) {
  if (reply.deleted) {
    return (
      <div className="reply-quote deleted" data-testid="reply-quote" data-reply-id={reply.id}>
        <ReplyIcon size={14} />
        <span className="reply-quote-text">silinmiş mesaj</span>
      </div>
    )
  }
  const attachment = reply.excerpt.startsWith('📎 ')
  return (
    <button
      type="button"
      className="reply-quote"
      data-testid="reply-quote"
      data-reply-id={reply.id}
      title="Asıl mesaja git"
      onClick={() => onJump(reply.id)}
    >
      <ReplyIcon size={14} />
      <strong className="reply-quote-author">{authorName ?? reply.author.name}</strong>
      <span className={`reply-quote-text${attachment ? ' attachment' : ''}`}>{reply.excerpt || '…'}</span>
    </button>
  )
}
