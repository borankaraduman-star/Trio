import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { fileProblem, MAX_ATTACHMENTS, uploadErrorMessage } from './lib/attachments'
import {
  hasFailed,
  isUploading,
  pendingReducer,
  readyAttachments,
  remainingSlots,
  type PendingAttachment,
} from './lib/pending'
import type { Attachment } from './types'
import { UploadQueue } from './lib/uploadQueue'
import { uploadFile } from './uploads'

let counter = 0
function localId(): string {
  counter += 1
  return `p${Date.now().toString(36)}-${counter}`
}

export interface AttachmentsApi {
  pending: (channelId: number | null) => PendingAttachment[]
  /** Adds files (from the paperclip, a paste or a drop) to a channel's composer. */
  add: (channelId: number, files: readonly File[]) => void
  remove: (localId: string) => void
  /** The uploaded attachments of a channel, removed from the pending list. */
  take: (channelId: number) => Attachment[]
  uploading: (channelId: number | null) => boolean
  /** A chip of this channel failed; the message waits until it is removed. */
  failed: (channelId: number | null) => boolean
  /** Any channel holds a chosen file (uploading, waiting, done or failed); read at call time. */
  anyPending: () => boolean
  /** A Turkish sentence about files that were not added, or null. */
  notice: string | null
  dismissNotice: () => void
  /** The local file of each pending item, for thumbnails. */
  files: ReadonlyMap<string, File>
}

/**
 * Pending attachments per channel, uploaded as soon as they are added — one
 * at a time, in the order they were added (CONTRACT-V3 §4).
 */
export function useAttachments(token: string, onUnauthorized: () => void): AttachmentsApi {
  const [state, dispatch] = useReducer(pendingReducer, {})
  const stateRef = useRef(state)
  stateRef.current = state
  const fileMap = useRef(new Map<string, File>())
  const [notice, setNotice] = useState<string | null>(null)
  const unauthorized = useRef(onUnauthorized)
  unauthorized.current = onUnauthorized

  const [queue] = useState(
    () =>
      new UploadQueue<File>((file, name, onProgress) => uploadFile(token, file, name, onProgress), {
        onStart: (id) => dispatch({ type: 'start', localId: id }),
        onProgress: (id, progress) => dispatch({ type: 'progress', localId: id, progress }),
        onDone: (id, attachment) => dispatch({ type: 'done', localId: id, attachment }),
        onWaiting: (id) => dispatch({ type: 'waiting', localId: id }),
        onError: (id, code, status) => {
          if (code === 'ABORTED') return
          if (code === 'UNAUTHORIZED' || status === 401) {
            unauthorized.current()
            return
          }
          dispatch({ type: 'error', localId: id, error: uploadErrorMessage(code) })
        },
      }),
  )

  // Leaving the session cancels whatever is still uploading or waiting.
  useEffect(() => () => queue.stop(), [queue])

  const add = useCallback(
    (channelId: number, files: readonly File[]) => {
      if (files.length === 0) return
      const list = stateRef.current[channelId] ?? []
      let slots = remainingSlots(list)
      const items: PendingAttachment[] = []
      const problems: string[] = []
      let skipped = 0
      const starts: { item: PendingAttachment; file: File }[] = []
      for (const file of files) {
        const problem = fileProblem(file)
        if (problem) {
          problems.push(problem)
          continue
        }
        if (slots <= 0) {
          skipped += 1
          continue
        }
        slots -= 1
        const item: PendingAttachment = {
          localId: localId(),
          channelId,
          name: file.name,
          size: file.size,
          type: file.type,
          status: 'queued',
          progress: 0,
          attachment: null,
          error: null,
        }
        items.push(item)
        starts.push({ item, file })
        fileMap.current.set(item.localId, file)
      }
      if (skipped > 0) problems.push(`Bir mesaja en fazla ${MAX_ATTACHMENTS} dosya eklenebilir.`)
      setNotice(problems.length > 0 ? problems.join(' ') : null)
      dispatch({ type: 'add', items })
      for (const { item, file } of starts) queue.add(item.localId, file, file.name)
    },
    [queue],
  )

  const remove = useCallback(
    (id: string) => {
      queue.cancel(id)
      fileMap.current.delete(id)
      dispatch({ type: 'remove', localId: id })
    },
    [queue],
  )

  const take = useCallback((channelId: number) => {
    const list = stateRef.current[channelId] ?? []
    const ready = list.filter((item) => item.status === 'done')
    for (const item of ready) fileMap.current.delete(item.localId)
    if (ready.length > 0) dispatch({ type: 'taken', channelId, localIds: ready.map((item) => item.localId) })
    return readyAttachments(ready)
  }, [])

  const pending = useCallback(
    (channelId: number | null) => (channelId === null ? [] : (state[channelId] ?? [])),
    [state],
  )
  const uploading = useCallback(
    (channelId: number | null) => (channelId === null ? false : isUploading(state[channelId] ?? [])),
    [state],
  )
  const failed = useCallback(
    (channelId: number | null) => (channelId === null ? false : hasFailed(state[channelId] ?? [])),
    [state],
  )

  const anyPending = useCallback(() => Object.values(stateRef.current).some((list) => list.length > 0), [])

  const dismissNotice = useCallback(() => setNotice(null), [])
  return { pending, add, remove, take, uploading, failed, anyPending, notice, dismissNotice, files: fileMap.current }
}
