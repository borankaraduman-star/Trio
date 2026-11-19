/**
 * CONTRACT-V7-READING §2–3: where "Yeni mesajlar" goes in a list, and how many
 * new messages a reader who scrolled up has below them.
 */

interface Row {
  id: number
  key: string
  status: 'sent' | 'pending' | 'failed'
  author: { id: number }
}

/** Older pages a channel may load to reach its first unread message before giving up. */
export const MAX_LANDING_PAGES = 4

export type DividerPlace =
  /** The key of the first unread row: the divider goes right above it. */
  | { kind: 'row'; key: string }
  /** The first unread message is older than what is loaded: load more. */
  | { kind: 'older' }
  /** Nothing after the mark is held (deleted meanwhile): no divider. */
  | { kind: 'none' }

export function dividerPlace(items: readonly Row[], after: number, hasMore: boolean): DividerPlace {
  let sawOlder = false
  for (const item of items) {
    if (item.status !== 'sent') continue
    if (item.id <= after) {
      sawOlder = true
      continue
    }
    // The first held message after the mark is the first unread only when the
    // mark itself (or the channel's start) is held too.
    return sawOlder || !hasMore ? { kind: 'row', key: item.key } : { kind: 'older' }
  }
  return { kind: 'none' }
}

/** Messages by somebody else newer than `baseId` (what the jump button counts). */
export function countNewSince(items: readonly Row[], baseId: number, myId: number): number {
  let count = 0
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item.status !== 'sent') continue
    if (item.id <= baseId) break
    if (item.author.id !== myId) count += 1
  }
  return count
}

/** The newest confirmed id in `items`, or 0. */
export function newestSentId(items: readonly Row[]): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].status === 'sent') return items[index].id
  }
  return 0
}

/** "3 yeni mesaj", "99+ yeni mesaj". */
export function newCountLabel(count: number): string {
  return `${count > 99 ? '99+' : count} yeni mesaj`
}
