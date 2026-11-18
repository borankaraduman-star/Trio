import type { Attachment } from '../types'
import { MAX_ATTACHMENTS } from './attachments'

/** A file waiting above the composer: being uploaded, uploaded, or refused. */
export interface PendingAttachment {
  localId: string
  channelId: number
  name: string
  size: number
  /** The type the browser claims; only used for the chip's thumbnail. */
  type: string
  status: 'uploading' | 'done' | 'error'
  /** 0..1 */
  progress: number
  attachment: Attachment | null
  error: string | null
}

export type PendingState = Record<number, PendingAttachment[]>

export type PendingAction =
  | { type: 'add'; items: PendingAttachment[] }
  | { type: 'progress'; localId: string; progress: number }
  | { type: 'done'; localId: string; attachment: Attachment }
  | { type: 'error'; localId: string; error: string }
  | { type: 'remove'; localId: string }
  /** The uploaded ones were sent: drop them from the channel. */
  | { type: 'taken'; channelId: number; localIds: string[] }

function mapItem(
  state: PendingState,
  localId: string,
  update: (item: PendingAttachment) => PendingAttachment,
): PendingState {
  for (const [key, list] of Object.entries(state)) {
    const index = list.findIndex((item) => item.localId === localId)
    if (index < 0) continue
    const next = [...list]
    next[index] = update(list[index])
    return { ...state, [Number(key)]: next }
  }
  return state
}

export function pendingReducer(state: PendingState, action: PendingAction): PendingState {
  switch (action.type) {
    case 'add': {
      if (action.items.length === 0) return state
      const next = { ...state }
      for (const item of action.items) next[item.channelId] = [...(next[item.channelId] ?? []), item]
      return next
    }
    case 'progress':
      return mapItem(state, action.localId, (item) =>
        item.status === 'uploading' ? { ...item, progress: action.progress } : item,
      )
    case 'done':
      return mapItem(state, action.localId, (item) => ({
        ...item,
        status: 'done',
        progress: 1,
        attachment: action.attachment,
        error: null,
      }))
    case 'error':
      return mapItem(state, action.localId, (item) => ({ ...item, status: 'error', error: action.error }))
    case 'remove': {
      for (const [key, list] of Object.entries(state)) {
        if (list.some((item) => item.localId === action.localId)) {
          return { ...state, [Number(key)]: list.filter((item) => item.localId !== action.localId) }
        }
      }
      return state
    }
    case 'taken': {
      const list = state[action.channelId]
      if (!list) return state
      const ids = new Set(action.localIds)
      return { ...state, [action.channelId]: list.filter((item) => !ids.has(item.localId)) }
    }
    default:
      return state
  }
}

/** How many more files a channel can take (failed chips do not count: they are not sent). */
export function remainingSlots(list: readonly PendingAttachment[]): number {
  return Math.max(0, MAX_ATTACHMENTS - list.filter((item) => item.status !== 'error').length)
}

export function readyAttachments(list: readonly PendingAttachment[]): Attachment[] {
  return list.flatMap((item) => (item.status === 'done' && item.attachment ? [item.attachment] : []))
}

export function isUploading(list: readonly PendingAttachment[]): boolean {
  return list.some((item) => item.status === 'uploading')
}
