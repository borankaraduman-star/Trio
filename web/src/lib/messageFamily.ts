/**
 * Small pure rules of the message family (CONTRACT-V4 B) shared by the store
 * and the components: which copy of a message wins, which message the
 * up-arrow edits, and the pinned list.
 */
import type { Message } from '../types'

/** A message from a server that predates `rev` counts as 0. */
export function revOf(message: { rev?: number }): number {
  return typeof message.rev === 'number' ? message.rev : 0
}

/**
 * Whether `incoming` should replace `held`: the highest `rev` wins; on a tie
 * the incoming copy (its `reply_to` was resolved later).
 */
export function supersedes(incoming: { rev?: number }, held: { rev?: number }): boolean {
  return revOf(incoming) >= revOf(held)
}

/** My newest confirmed message in a list (the up-arrow in an empty composer edits it). */
export function lastEditable<M extends { id: number; status: string; author: { id: number } }>(
  items: readonly M[],
  meId: number,
): M | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (item.status === 'sent' && item.author.id === meId) return item
  }
  return null
}

/** Pins newest first; a message without `pinned_at` is not a pin. */
export function sortPins(messages: readonly Message[]): Message[] {
  return messages
    .filter((message) => message.pinned_at)
    .sort((a, b) => (b.pinned_at ?? '').localeCompare(a.pinned_at ?? '') || b.id - a.id)
}

/** A pinned list after `message` changed: added, updated or removed (unpinned). */
export function updatePins(pins: readonly Message[], message: Message): Message[] {
  const held = pins.find((pin) => pin.id === message.id)
  if (held && !supersedes(message, held)) return [...pins]
  const rest = pins.filter((pin) => pin.id !== message.id)
  return sortPins(message.pinned_at ? [...rest, message] : rest)
}

/** Whether the person may edit / delete: only the author (any age). */
export function isOwn(message: { author: { id: number } }, meId: number): boolean {
  return message.author.id === meId
}
