import { EditIcon, MoreIcon, ReplyIcon, SmilePlusIcon } from './icons'
import { rectOf, type AnchorRect } from './Popover'

export type ActionKind = 'react' | 'reply' | 'edit' | 'menu'

/**
 * The bar a desktop pointer (or a keyboard focus inside the row) shows on a
 * message: Tepki, Yanıtla, Düzenle (own), and "⋯" for the rest.
 */
export function MessageActions({ own, onAction }: { own: boolean; onAction: (kind: ActionKind, anchor: AnchorRect) => void }) {
  const button = (kind: ActionKind, label: string, icon: JSX.Element) => (
    <button
      type="button"
      className="msg-action"
      data-testid={`msg-action-${kind}`}
      aria-label={label}
      title={label}
      onClick={(event) => onAction(kind, rectOf(event.currentTarget))}
    >
      {icon}
    </button>
  )
  return (
    <div className="msg-actions" role="toolbar" aria-label="Mesaj işlemleri">
      {button('react', 'Tepki ekle', <SmilePlusIcon size={17} />)}
      {button('reply', 'Yanıtla', <ReplyIcon size={17} />)}
      {own && button('edit', 'Düzenle', <EditIcon size={17} />)}
      {button('menu', 'Diğer işlemler', <MoreIcon size={17} />)}
    </div>
  )
}
