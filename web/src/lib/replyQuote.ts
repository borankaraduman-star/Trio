/**
 * Reply quotes (CONTRACT-V4 B). The server resolves `reply_to` whenever it
 * serialises a message, but sends no update for a reply when its TARGET is
 * edited or deleted. So the client derives each shown quote from the target
 * itself when it holds it, falls back to the server's snapshot when it does
 * not, and treats a deletion as final (ids are never reused).
 */
import type { Message, ReplyRef } from '../types'

export const EXCERPT_LENGTH = 140

/** What the server would put in `excerpt`: the first 140 code points, or "📎 <file>". */
export function excerptOf(message: Pick<Message, 'content' | 'attachments'>): string {
  if (message.content !== '') return [...message.content].slice(0, EXCERPT_LENGTH).join('')
  const first = message.attachments?.[0]
  return first ? `📎 ${first.filename}` : ''
}

export function quoteFrom(target: Pick<Message, 'id' | 'author' | 'content' | 'attachments'>): ReplyRef {
  return { id: target.id, author: { id: target.author.id, name: target.author.name }, excerpt: excerptOf(target) }
}

export function sameQuote(a: ReplyRef | null | undefined, b: ReplyRef | null | undefined): boolean {
  if (!a || !b) return !a && !b
  if (a.id !== b.id) return false
  if (a.deleted || b.deleted) return a.deleted === b.deleted
  return a.excerpt === b.excerpt && a.author.id === b.author.id && a.author.name === b.author.name
}

/**
 * The quote a message should show: deleted if the target is known deleted
 * (by a `message.deleted`, or by any snapshot that says so), else derived
 * from the held target, else the snapshot as it came.
 */
export function resolveQuote(
  reply: ReplyRef,
  held: ReadonlyMap<number, Pick<Message, 'id' | 'author' | 'content' | 'attachments'>>,
  deleted: Readonly<Record<number, true>>,
): ReplyRef {
  if (reply.deleted || deleted[reply.id]) return reply.deleted ? reply : { id: reply.id, deleted: true }
  const target = held.get(reply.id)
  return target ? quoteFrom(target) : reply
}

/**
 * `items` with every quote brought up to date. Unchanged messages keep their
 * identity (the rows are memoised on it); the same array is returned when
 * nothing changed.
 */
export function refreshQuotes<M extends Message & { status?: string }>(
  items: readonly M[],
  deleted: Readonly<Record<number, true>>,
): readonly M[] {
  if (!items.some((item) => item.reply_to)) return items
  const held = new Map<number, M>()
  for (const item of items) if (item.status === undefined || item.status === 'sent') held.set(item.id, item)
  let changed = false
  const next = items.map((item) => {
    if (!item.reply_to) return item
    const quote = resolveQuote(item.reply_to, held, deleted)
    if (sameQuote(quote, item.reply_to)) return item
    changed = true
    return { ...item, reply_to: quote }
  })
  return changed ? next : items
}
