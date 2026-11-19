/**
 * `@ad` and `@herkes` (CONTRACT-V6-PUSH §4): the client's copy of
 * `server/trio_server/mentions.py`, the same algorithm character for character,
 * held to it by the shared cases in `mentionCases.json`. The server decides who
 * is pushed; this only draws the emphasis and the row highlight.
 */

export const EVERYONE = 'herkes'

/** One character folded (NFKC, Turkish İ/ı → i, lower case, no combining dot above). */
export function foldChar(ch: string): string {
  return ch.normalize('NFKC').replace(/İ/g, 'i').replace(/ı/g, 'i').toLowerCase().replace(/̇/g, '')
}

/** The folded text and, per folded code point, the UTF-16 index range of its source character. */
export function fold(text: string): { folded: string[]; from: number[]; to: number[] } {
  const nfc = text.normalize('NFC')
  const folded: string[] = []
  const from: number[] = []
  const to: number[] = []
  let index = 0
  for (const ch of nfc) {
    for (const out of foldChar(ch)) {
      folded.push(out)
      from.push(index)
      to.push(index + ch.length)
    }
    index += ch.length
  }
  return { folded, from, to }
}

const WORDISH = /^[\p{L}\p{N}\p{M}_]$/u

export interface MentionSpan {
  /** UTF-16 offsets in `text.normalize('NFC')`. */
  start: number
  end: number
  /** null: `@herkes`. */
  userId: number | null
}

function indexOf(haystack: string[], needle: string[], from: number): number {
  outer: for (let i = from; i + needle.length <= haystack.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) if (haystack[i + j] !== needle[j]) continue outer
    return i
  }
  return -1
}

/** Every mention in `text`, in order; longer names first, a span used once. */
export function findMentions(text: string, names: ReadonlyMap<number, string> | Record<number, string>): MentionSpan[] {
  const { folded, from, to } = fold(text)
  const entries: Array<[number, string]> =
    names instanceof Map ? [...names.entries()] : Object.entries(names).map(([id, name]) => [Number(id), name as string])
  const candidates: Array<{ name: string[]; userId: number | null }> = entries.map(([id, name]) => ({
    name: fold(name).folded,
    userId: id,
  }))
  candidates.push({ name: [...EVERYONE], userId: null })
  candidates.sort((a, b) => b.name.length - a.name.length || (a.userId ?? -1) - (b.userId ?? -1))
  const taken = new Array<boolean>(folded.length).fill(false)
  const spans: MentionSpan[] = []
  for (const { name, userId } of candidates) {
    if (name.length === 0) continue
    const needle = ['@', ...name]
    let start = indexOf(folded, needle, 0)
    while (start !== -1) {
      const end = start + needle.length
      const beforeOk = start === 0 || !WORDISH.test(folded[start - 1])
      const afterOk = end === folded.length || !WORDISH.test(folded[end])
      if (beforeOk && afterOk && !taken.slice(start, end).some(Boolean)) {
        for (let i = start; i < end; i += 1) taken[i] = true
        spans.push({ start: from[start], end: to[end - 1], userId })
      }
      start = indexOf(folded, needle, start + 1)
    }
  }
  return spans.sort((a, b) => a.start - b.start)
}

/** Whether `text` names `myId` (or says @herkes). Pure: the row highlight comes from this. */
export function mentionsUser(text: string, names: Record<number, string>, myId: number): boolean {
  return findMentions(text, names).some((span) => span.userId === null || span.userId === myId)
}

export type MentionPart = { type: 'text'; value: string } | { type: 'mention'; value: string; me: boolean }

/** `text` cut into plain runs and mention runs (for `Content`). */
export function splitMentions(text: string, names: Record<number, string>, myId: number): MentionPart[] {
  const nfc = text.normalize('NFC')
  const spans = findMentions(nfc, names)
  if (spans.length === 0) return [{ type: 'text', value: text }]
  const parts: MentionPart[] = []
  let at = 0
  for (const span of spans) {
    if (span.start > at) parts.push({ type: 'text', value: nfc.slice(at, span.start) })
    parts.push({ type: 'mention', value: nfc.slice(span.start, span.end), me: span.userId === null || span.userId === myId })
    at = span.end
  }
  if (at < nfc.length) parts.push({ type: 'text', value: nfc.slice(at) })
  return parts
}

/** What a message list needs to find mentions: everybody's current name, and who I am. */
export interface MentionNames {
  names: Record<number, string>
  myId: number
}

export function mentionNamesOf(users: Record<number, { name: string }> | undefined, myId: number): MentionNames {
  const names: Record<number, string> = {}
  for (const [id, user] of Object.entries(users ?? {})) names[Number(id)] = user.name
  return { names, myId }
}

/** The extra class of a message row: ` mentions-me` when it names me (or @herkes) and I did not write it. */
export function mentionRowClass(text: string, authorId: number, mention: MentionNames | undefined): string {
  if (!mention || authorId === mention.myId || !text.includes('@') && !text.includes('＠')) return ''
  return mentionsUser(text, mention.names, mention.myId) ? ' mentions-me' : ''
}
