import { QUICK_REACTIONS } from '../../lib/emojiData'
import type { Message } from '../../types'
import { CopyIcon, EditIcon, PinIcon, ReplyIcon, SmilePlusIcon, TrashIcon } from './icons'
import { Popover, type AnchorRect } from './Popover'
import { joinNames } from './ReactionChips'

export type MenuChoice = 'react' | 'reply' | 'edit' | 'pin' | 'copy' | 'delete'

/**
 * Everything one can do with a message: the "⋯" menu next to the pointer on a
 * wide screen, the long-press sheet at phone width (with a row of quick
 * reactions and who reacted with what).
 */
export function ActionMenu({
  message,
  own,
  meId,
  anchor,
  nameOf,
  onChoose,
  onReact,
  onClose,
}: {
  message: Message
  own: boolean
  meId: number
  anchor: AnchorRect | null
  nameOf: (id: number) => string
  onChoose: (choice: MenuChoice) => void
  onReact: (key: string) => void
  onClose: () => void
}) {
  const reactions = message.reactions ?? []
  const item = (choice: MenuChoice, label: string, icon: JSX.Element, danger = false) => (
    <button
      type="button"
      role="menuitem"
      className={`msg-menu-item${danger ? ' danger-text' : ''}`}
      data-testid={`msg-menu-${choice}`}
      onClick={() => onChoose(choice)}
    >
      {icon}
      <span>{label}</span>
    </button>
  )
  return (
    <Popover anchor={anchor} onClose={onClose} label="Mesaj işlemleri" className="msg-menu" testId="message-menu">
      <div className="msg-quick-reactions" role="group" aria-label="Hızlı tepki">
        {QUICK_REACTIONS.map((key) => {
          const mine = reactions.find((reaction) => reaction.key === key)?.user_ids.includes(meId) ?? false
          return (
            <button
              key={key}
              type="button"
              className={`msg-quick${mine ? ' mine' : ''}`}
              aria-label={`${key} tepkisi`}
              aria-pressed={mine}
              data-testid="quick-reaction"
              onClick={() => onReact(key)}
            >
              {key}
            </button>
          )
        })}
      </div>
      <div role="menu" aria-label="Mesaj işlemleri" className="msg-menu-items">
        {item('react', 'Tepki ekle', <SmilePlusIcon size={18} />)}
        {item('reply', 'Yanıtla', <ReplyIcon size={18} />)}
        {own && item('edit', 'Düzenle', <EditIcon size={18} />)}
        {item('pin', message.pinned_at ? 'Sabitlemeyi kaldır' : 'Sabitle', <PinIcon size={18} off={Boolean(message.pinned_at)} />)}
        {message.content !== '' && item('copy', 'Metni kopyala', <CopyIcon size={18} />)}
        {own && item('delete', 'Sil', <TrashIcon size={18} />, true)}
      </div>
      {reactions.length > 0 && (
        <div className="msg-menu-reactions" data-testid="menu-reactions">
          <h3>Tepkiler</h3>
          <ul>
            {reactions.map((reaction) => (
              <li key={reaction.key}>
                <span className="reaction-emoji">{reaction.key}</span>
                <span>{joinNames(reaction.user_ids.map(nameOf))}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Popover>
  )
}
