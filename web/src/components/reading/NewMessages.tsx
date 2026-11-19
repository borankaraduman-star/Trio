import { newCountLabel } from '../../lib/newMessages'

/**
 * CONTRACT-V7-READING §2: the line above the first message that was unread
 * when the channel was opened. No `data-key`: the scroll anchor
 * (lib/scrollAnchor.ts) only ever holds on message rows.
 */
export function NewMessagesDivider() {
  return (
    <li className="new-messages-divider" role="separator" data-testid="new-messages-divider">
      <span>Yeni mesajlar</span>
    </li>
  )
}

/** §3: back to the newest message, with how many arrived since the reader scrolled up. */
export function JumpToBottom({ count, onClick }: { count: number; onClick: () => void }) {
  const label = count > 0 ? `${newCountLabel(count)} · en alta git` : 'En alta git'
  return (
    <div className="jump-to-bottom-dock">
    <button
      type="button"
      className={`jump-to-bottom${count > 0 ? ' has-new' : ''}`}
      data-testid="jump-to-bottom"
      data-count={count}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {count > 0 && (
        <span className="jump-to-bottom-count" data-testid="jump-to-bottom-count">
          {count > 99 ? '99+' : count}
        </span>
      )}
      <svg width={18} height={18} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 5v14M6 13l6 6 6-6" />
      </svg>
    </button>
    </div>
  )
}
