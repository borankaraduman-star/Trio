import { useMemo } from 'react'
import { splitMentions, type MentionNames } from '../../lib/notify/mentions'

/** A plain-text run of a message with its `@ad` / `@herkes` emphasised. Never HTML. */
export function MentionText({ value, mention }: { value: string; mention: MentionNames }) {
  const parts = useMemo(() => splitMentions(value, mention.names, mention.myId), [value, mention])
  if (parts.length === 1 && parts[0].type === 'text') return <span>{value}</span>
  return (
    <span>
      {parts.map((part, index) =>
        part.type === 'mention' ? (
          <span key={index} className={part.me ? 'mention mention-me' : 'mention'} data-testid="mention">
            {part.value}
          </span>
        ) : (
          <span key={index}>{part.value}</span>
        ),
      )}
    </span>
  )
}
