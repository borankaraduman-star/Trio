/**
 * Fetching the newest messages of a channel after a reconnect, far enough
 * back to meet what is already held, so the result can be MERGED into the
 * list instead of replacing it (a reader deep in history keeps their place
 * and every message they had loaded).
 */
import type { Message } from '../types'

export interface Page {
  messages: Message[]
  has_more: boolean
}

export interface Covering {
  /** Oldest first, contiguous. */
  messages: Message[]
  /** There are messages older than the first one. */
  hasMore: boolean
  /** Reaches back to `newestHeld` (or there is nothing held to meet): no gap. */
  covers: boolean
}

/** Pages fetched at most before giving up on meeting the held messages (a gap). */
export const MAX_CATCH_UP_PAGES = 10

/**
 * The newest page, then older ones until the first message is at or before
 * `newestHeld` (the newest confirmed id held), or there is nothing older, or
 * `maxPages` pages were fetched.
 */
export async function fetchCovering(
  fetchPage: (before?: number) => Promise<Page>,
  newestHeld: number | null,
  maxPages = MAX_CATCH_UP_PAGES,
): Promise<Covering> {
  let page = await fetchPage()
  let messages = page.messages
  let hasMore = page.has_more
  let pages = 1
  const met = () => newestHeld === null || messages.length === 0 || messages[0].id <= newestHeld
  while (!met() && hasMore && pages < maxPages) {
    page = await fetchPage(messages[0].id)
    pages += 1
    // Defensive: never step on the same page twice.
    const older = page.messages.filter((message) => message.id < messages[0].id)
    if (older.length === 0) break
    messages = [...older, ...messages]
    hasMore = page.has_more
  }
  return { messages, hasMore, covers: met() || !hasMore }
}

/** The newest id of the confirmed messages held, or null when none are. */
export function newestConfirmedId(items: readonly { id: number; status: string }[]): number | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].status === 'sent') return items[index].id
  }
  return null
}
