/**
 * A draft per channel (CONTRACT-V6-MEDIA §5): the composer's text and the
 * message being replied to survive switching channels and a reload of the
 * tab. Kept in `sessionStorage` (this tab only; a closed tab forgets), and
 * cleared when the message is sent.
 */
import type { Message } from '../types'

export interface Draft {
  text: string
  /** The message being answered, as it was when the reply started. */
  reply: Message | null
}

export type Drafts = Record<number, Draft>

const KEY = 'trio.drafts'
/** A draft longer than a message can be is still kept; this only bounds what storage holds. */
const MAX_TEXT = 20_000

export function isEmpty(draft: Draft | undefined): boolean {
  return !draft || (draft.text.trim() === '' && draft.reply === null)
}

/** `drafts` with `channelId`'s draft replaced (an empty draft removes the entry). */
export function withDraft(drafts: Drafts, channelId: number, draft: Draft): Drafts {
  const next = { ...drafts }
  if (isEmpty(draft)) delete next[channelId]
  else next[channelId] = { text: draft.text.slice(0, MAX_TEXT), reply: draft.reply }
  return next
}

/** Unsent text anywhere (the reload guard's "draft"); a reply alone is not text. */
export function anyText(drafts: Drafts): boolean {
  return Object.values(drafts).some((draft) => draft.text.trim() !== '')
}

function isDraft(value: unknown): value is Draft {
  if (typeof value !== 'object' || value === null) return false
  const d = value as Record<string, unknown>
  const reply = d.reply
  const replyOk =
    reply === null ||
    (typeof reply === 'object' &&
      reply !== null &&
      typeof (reply as Message).id === 'number' &&
      typeof (reply as Message).channel_id === 'number' &&
      typeof (reply as Message).content === 'string' &&
      typeof (reply as Message).author?.id === 'number')
  return typeof d.text === 'string' && replyOk
}

export function parseDrafts(raw: string | null): Drafts {
  if (!raw) return {}
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return {}
  const out: Drafts = {}
  for (const [key, value] of Object.entries(data)) {
    const id = Number(key)
    if (Number.isInteger(id) && id > 0 && isDraft(value) && !isEmpty(value)) out[id] = value
  }
  return out
}

function storage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

export function loadDrafts(store: Pick<Storage, 'getItem'> | null = storage()): Drafts {
  try {
    return parseDrafts(store?.getItem(KEY) ?? null)
  } catch {
    return {}
  }
}

export function saveDrafts(drafts: Drafts, store: Pick<Storage, 'setItem' | 'removeItem'> | null = storage()): void {
  try {
    if (Object.keys(drafts).length === 0) store?.removeItem(KEY)
    else store?.setItem(KEY, JSON.stringify(drafts))
  } catch {
    // Full or blocked storage: the draft lives as long as the page.
  }
}
