import { memo } from 'react'
import type { Reaction } from '../../types'
import { SmilePlusIcon } from './icons'
import { rectOf, type AnchorRect } from './Popover'

/** "Ayşe, Mehmet ve Zeynep" */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} ve ${names[names.length - 1]}`
}

export function reactionTitle(reaction: Reaction, nameOf: (id: number) => string): string {
  return `${joinNames(reaction.user_ids.map(nameOf))}: ${reaction.key}`
}

/** Chips under a message: emoji and count, mine highlighted; a click toggles mine. */
export const ReactionChips = memo(function ReactionChips({
  reactions,
  meId,
  nameOf,
  onToggle,
  onAdd,
}: {
  reactions: readonly Reaction[]
  meId: number
  nameOf: (id: number) => string
  onToggle: (key: string) => void
  onAdd: (anchor: AnchorRect) => void
}) {
  if (reactions.length === 0) return null
  return (
    <div className="msg-reactions" data-testid="reactions">
      {reactions.map((reaction) => {
        const mine = reaction.user_ids.includes(meId)
        const title = reactionTitle(reaction, nameOf)
        return (
          <button
            key={reaction.key}
            type="button"
            className={`reaction-chip${mine ? ' mine' : ''}`}
            data-testid="reaction-chip"
            data-reaction={reaction.key}
            aria-pressed={mine}
            aria-label={`${reaction.key} ${reaction.count} — ${title}`}
            title={title}
            onClick={() => onToggle(reaction.key)}
          >
            <span className="reaction-emoji" aria-hidden="true">
              {reaction.key}
            </span>
            <span className="reaction-count">{reaction.count}</span>
          </button>
        )
      })}
      <button
        type="button"
        className="reaction-chip add"
        data-testid="reaction-add"
        aria-label="Tepki ekle"
        title="Tepki ekle"
        onClick={(event) => onAdd(rectOf(event.currentTarget))}
      >
        <SmilePlusIcon size={16} />
      </button>
    </div>
  )
})
