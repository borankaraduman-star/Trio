import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { ApiError } from './api'
import { fileProblem, MAX_ATTACHMENTS, uploadErrorMessage } from './lib/attachments'
import {
  isUploading,
  pendingReducer,
  readyAttachments,
  remainingSlots,
  type PendingAttachment,
} from './lib/pending'
import type { Attachment } from './types'
import { uploadFile, type UploadHandle } from './uploads'

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
  /** A Turkish sentence about files that were not added, or null. */
  notice: string | null
  dismissNotice: () => void
  /** The local file of each pending item, for thumbnails. */
  files: ReadonlyMap<string, File>
}

/** Pending attachments per channel, uploaded as soon as they are added. */
export function useAttachments(token: string, onUnauthorized: () => void): AttachmentsApi {
  const [state, dispatch] = useReducer(pendingReducer, {})
  const stateRef = useRef(state)
  stateRef.current = state
  const uploads = useRef(new Map<string, UploadHandle>())
  const fileMap = useRef(new Map<string, File>())
  const [notice, setNotice] = useState<string | null>(null)

  // Leaving the session cancels whatever is still uploading.
  useEffect(() => {
    const running = uploads.current
    return () => {
      for (const handle of running.values()) handle.abort()
      running.clear()
    }
  }, [])

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
          status: 'uploading',
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

      for (const { item, file } of starts) {
        const handle = uploadFile(token, file, file.name, (progress) =>
          dispatch({ type: 'progress', localId: item.localId, progress }),
        )
        uploads.current.set(item.localId, handle)
        handle.promise.then(
          (attachment) => {
            uploads.current.delete(item.localId)
            dispatch({ type: 'done', localId: item.localId, attachment })
          },
          (error: unknown) => {
            uploads.current.delete(item.localId)
            const code = error instanceof ApiError ? error.code : 'UNKNOWN'
            if (code === 'ABORTED') return
            if (code === 'UNAUTHORIZED' || (error instanceof ApiError && error.status === 401)) {
              onUnauthorized()
              return
            }
            dispatch({ type: 'error', localId: item.localId, error: uploadErrorMessage(code) })
          },
        )
      }
    },
    [token, onUnauthorized],
  )

  const remove = useCallback((id: string) => {
    uploads.current.get(id)?.abort()
    uploads.current.delete(id)
    fileMap.current.delete(id)
    dispatch({ type: 'remove', localId: id })
  }, [])

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

  const dismissNotice = useCallback(() => setNotice(null), [])
  return { pending, add, remove, take, uploading, notice, dismissNotice, files: fileMap.current }
}
