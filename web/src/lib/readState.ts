/**
 * CONTRACT-V7-READING: read state kept on the server, per user and channel.
 *
 * The device's own memory (`trio.lastRead` in localStorage, how unread worked
 * before) is merged with what the server says: each channel's mark is the
 * larger of the two, so a device that had read further than the server knows
 * (it never had a server to tell, or the frame was lost) tells it, and one
 * that is behind catches up. Marks only ever move forward.
 */
import type { ReadStateEntry } from '../types'

export interface MergedRead {
  /** The mark this device keeps. */
  lastRead: number
  /** What the server holds (its mark), so the device knows what is left to tell it. */
  serverRead: number
  latest: number
  unread: number
}

/**
 * One channel of `ready.read_state` against the device's own mark. `unread`
 * is the server's exact count when the server's mark is the one kept; when the
 * device had read further the count after ITS mark is unknown: 1 ("at least
 * one") while there is anything newer, else 0.
 */
export function mergeEntry(local: number | undefined, server: ReadStateEntry, latestKnown = 0): MergedRead {
  const mine = local ?? 0
  const latest = Math.max(server.latest, latestKnown)
  const lastRead = Math.max(mine, server.last_read)
  let unread: number
  if (lastRead >= latest) unread = 0
  else if (mine > server.last_read) unread = 1
  else unread = Math.max(server.unread, latest > server.latest ? 1 : 0)
  return { lastRead, serverRead: server.last_read, latest, unread }
}

/** Is `value` a well-formed `read_state` entry? (A newer server may add keys.) */
export function isReadStateEntry(value: unknown): value is ReadStateEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return (
    Number.isInteger(entry.last_read) && Number.isInteger(entry.latest) && Number.isInteger(entry.unread)
  )
}

/** The channels whose mark the server has not been told yet: [channel id, mark]. */
export function readsToSend(
  lastRead: Record<number, number>,
  serverRead: Record<number, number>,
  textChannelIds: readonly number[],
): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (const id of textChannelIds) {
    const mine = lastRead[id]
    if (mine !== undefined && mine > 0 && mine > (serverRead[id] ?? 0)) out.push([id, mine])
  }
  return out
}
