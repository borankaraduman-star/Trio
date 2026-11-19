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
  /** v3: `queued` waits its turn (one upload at a time per user). */
  status: 'queued' | 'uploading' | 'done' | 'error'
  /** 0..1 */
  progress: number
  /** Queued again because another tab or device of this user was uploading. */
  waiting?: boolean
  attachment: Attachment | null
  error: string | null
  // --- V6 (CONTRACT-V6-MEDIA) ---
  /** The picture is being made smaller (or looked at) before it is queued. */
  preparing?: boolean
  /** The picked file's size, when what is sent is a smaller copy (`size` is then the copy's). */
  originalSize?: number
  /** A smaller copy is sent. */
  downsized?: boolean
  /** "Orijinali gönder" would change what is sent (the chip offers it). */
  reducible?: boolean
  /** A voice message: sent by itself as soon as it is uploaded. */
  voice?: boolean
}

export type PendingState = Record<number, PendingAttachment[]>

export type PendingAction =
  | { type: 'add'; items: PendingAttachment[] }
  | { type: 'start'; localId: string }
  | { type: 'waiting'; localId: string }
  | { type: 'progress'; localId: string; progress: number }
  | { type: 'done'; localId: string; attachment: Attachment }
  | { type: 'error'; localId: string; error: string }
  | { type: 'remove'; localId: string }
  /** V6: the picture was prepared; it is queued now under this name and size. */
  | { type: 'prepared'; localId: string; name: string; size: number; originalSize: number; downsized: boolean; reducible: boolean }
  /** V6: prepared again ("Orijinali gönder" changed): back to waiting, nothing uploaded counts. */
  | { type: 'reprepare'; localId: string }
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
    case 'start':
      return mapItem(state, action.localId, (item) =>
        item.status === 'queued' || item.status === 'uploading'
          ? { ...item, status: 'uploading', progress: 0, waiting: false }
          : item,
      )
    case 'waiting':
      return mapItem(state, action.localId, (item) =>
        item.status === 'uploading' || item.status === 'queued'
          ? { ...item, status: 'queued', progress: 0, waiting: true }
          : item,
      )
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
    case 'prepared':
      return mapItem(state, action.localId, (item) => ({
        ...item,
        preparing: false,
        name: action.name,
        size: action.size,
        originalSize: action.downsized ? action.originalSize : undefined,
        downsized: action.downsized,
        reducible: action.reducible,
      }))
    case 'reprepare':
      return mapItem(state, action.localId, (item) =>
        item.status === 'error'
          ? item
          : { ...item, status: 'queued', preparing: true, progress: 0, attachment: null, waiting: false },
      )
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

/** Something is still on its way (being sent or waiting its turn): the message must wait for it. */
export function isUploading(list: readonly PendingAttachment[]): boolean {
  return list.some((item) => item.status === 'uploading' || item.status === 'queued')
}

/** A chip that failed: the message is held until it is removed, so nothing is silently left out. */
export function hasFailed(list: readonly PendingAttachment[]): boolean {
  return list.some((item) => item.status === 'error')
}
