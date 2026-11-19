import { useMemo, useRef, useState } from 'react'
import { EMOJI_GROUPS, searchEmoji, type EmojiEntry } from '../../lib/emojiData'
import { loadRecent } from '../../lib/recentEmoji'
import { Popover, type AnchorRect } from './Popover'

/** A small built-in picker: recent first, then the groups; a Turkish keyword search. */
export function EmojiPicker({
  anchor,
  mine,
  onPick,
  onClose,
}: {
  anchor: AnchorRect | null
  /** Keys I already reacted with on this message (shown pressed). */
  mine: ReadonlySet<string>
  onPick: (emoji: string) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const search = useRef<HTMLInputElement>(null)
  const recent = useMemo(() => loadRecent(), [])
  const groups = useMemo(() => {
    if (query.trim() !== '') return [{ id: 'search', label: 'Sonuçlar', items: searchEmoji(query) }]
    const all = [...EMOJI_GROUPS]
    if (recent.length > 0) all.unshift({ id: 'recent', label: 'Son kullanılanlar', items: recent.map((emoji) => ({ emoji, words: '' })) })
    return all
  }, [query, recent])

  const cell = (entry: EmojiEntry, group: string) => (
    <button
      key={`${group}-${entry.emoji}`}
      type="button"
      className={`emoji-cell${mine.has(entry.emoji) ? ' mine' : ''}`}
      aria-label={entry.words ? `${entry.emoji} ${entry.words.split(' ')[0]}` : entry.emoji}
      aria-pressed={mine.has(entry.emoji)}
      title={entry.words.split(' ')[0] || undefined}
      data-emoji={entry.emoji}
      onClick={() => onPick(entry.emoji)}
    >
      {entry.emoji}
    </button>
  )

  return (
    <Popover anchor={anchor} onClose={onClose} label="Tepki seç" className="emoji-picker" testId="emoji-picker">
      <input
        ref={search}
        type="search"
        className="emoji-search"
        placeholder="Ara: kalp, gülen, tamam…"
        aria-label="Emoji ara"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            const first = groups[0]?.items[0]
            if (first) onPick(first.emoji)
          }
        }}
        data-testid="emoji-search"
      />
      <div className="emoji-groups">
        {groups.map((group) => (
          <section key={group.id} aria-label={group.label}>
            <h3>{group.label}</h3>
            {group.items.length === 0 ? (
              <p className="emoji-none">Bulunamadı.</p>
            ) : (
              <div className="emoji-grid">{group.items.map((entry) => cell(entry, group.id))}</div>
            )}
          </section>
        ))}
      </div>
    </Popover>
  )
}
