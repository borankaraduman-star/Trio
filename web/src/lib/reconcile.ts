/**
 * Pairing a stored message from me with this tab's unconfirmed copy of it.
 *
 * A message whose `message.new` echo was lost (the connection dropped between
 * the server storing it and the frame reaching us) stays as a pending row,
 * turns failed on `connection.down`, and comes back from the server in the
 * next page or live frame without a nonce. Unpaired, it would show twice.
 *
 * The pairing is by nonce when the stored message carries one (a live echo;
 * a server that de-duplicates a repeated nonce re-sends the original with it).
 * Otherwise by what the message is: my message, the same content, the same
 * attachments, created within a few minutes of a send of the local row
 * (its first send, or its latest retry). One stored message pairs with at
 * most one local row and the other way round, oldest first.
 */
import type { Message } from '../types'
import type { UiMessage } from '../store'

/** How far apart the local send and the server's `created_at` may be (clock skew, a slow send). */
export const RECONCILE_WINDOW_MS = 5 * 60_000

function attachmentKey(message: Message): string {
  return (message.attachments ?? [])
    .map((attachment) => attachment.id)
    .sort()
    .join(',')
}

function nonceOf(message: Message): string | undefined {
  const nonce = (message as { nonce?: unknown }).nonce
  return typeof nonce === 'string' ? nonce : undefined
}

/** Whether `stored` is the server's copy of the unconfirmed row `local`. */
export function isEchoOf(local: UiMessage, stored: Message, meId: number): boolean {
  if (local.status === 'sent' || stored.author.id !== meId || local.channel_id !== stored.channel_id) {
    return false
  }
  const nonce = nonceOf(stored)
  if (nonce !== undefined) return local.nonce === nonce
  if (local.content !== stored.content || attachmentKey(local) !== attachmentKey(stored)) return false
  const at = Date.parse(stored.created_at)
  if (!Number.isFinite(at)) return false
  return [Date.parse(local.created_at), local.sentAt ?? NaN].some(
    (sent) => Number.isFinite(sent) && Math.abs(at - sent) <= RECONCILE_WINDOW_MS,
  )
}

/**
 * Takes the unconfirmed rows of `items` that `incoming` (stored messages)
 * confirms out of `items`, and gives those incoming messages the local row's
 * key and nonce, status sent. Everything else passes through unchanged.
 */
export function claimEchoes(
  items: readonly UiMessage[],
  incoming: readonly UiMessage[],
  meId: number,
): { items: UiMessage[]; incoming: UiMessage[] } {
  const unsent = items.filter((item) => item.status !== 'sent')
  if (unsent.length === 0) return { items: [...items], incoming: [...incoming] }

  // A stored message already held and paired (its key is a nonce) is taken.
  const paired = new Set(
    items.filter((item) => item.status === 'sent' && item.key !== `m${item.id}`).map((item) => item.id),
  )
  const claimed = new Set<UiMessage>()
  const byId = new Map<number, UiMessage>()
  for (const stored of [...incoming].sort((a, b) => a.id - b.id)) {
    // Its key is already a nonce (kept across a refetch): it was paired before.
    if (stored.author.id !== meId || paired.has(stored.id) || stored.key !== `m${stored.id}`) continue
    const local = unsent.find((item) => !claimed.has(item) && isEchoOf(item, stored, meId))
    if (!local) continue
    claimed.add(local)
    byId.set(stored.id, { ...stored, key: local.key, nonce: local.nonce, status: 'sent' })
  }
  if (claimed.size === 0) return { items: [...items], incoming: [...incoming] }
  return {
    items: items.filter((item) => !claimed.has(item)),
    incoming: incoming.map((message) => byId.get(message.id) ?? message),
  }
}
