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
import type { Attachment, VoiceMeta } from './types'
import { UploadQueue } from './lib/uploadQueue'
import { uploadFile } from './uploads'
import { startUpload, type UploadSource } from './lib/mediaUpload'
import { loadSendOriginal, saveSendOriginal, worthDecoding } from './lib/photoPlan'
import { preparePhoto } from './lib/photoPrep'

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
  // --- V6 (CONTRACT-V6-MEDIA) ---
  /** "Orijinali gönder": pictures go up as picked (per device). */
  sendOriginal: boolean
  setSendOriginal: (value: boolean) => void
  /** A recorded voice message: uploaded at once (a chip meanwhile), then `onUploaded` sends it by itself. */
  addVoice: (channelId: number, file: File, voice: VoiceMeta, onUploaded: (attachment: Attachment) => void) => void
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
      new UploadQueue<UploadSource>(
        (source, _name, onProgress) =>
          startUpload((blob, name, progress, extras) => uploadFile(token, blob, name, progress, extras), source, onProgress),
        {
        onStart: (id) => dispatch({ type: 'start', localId: id }),
        onProgress: (id, progress) => dispatch({ type: 'progress', localId: id, progress }),
        onDone: (id, attachment) => {
          const sent = voiceDone.current.get(id)
          if (sent) {
            // A voice message leaves the pending list at once and is sent by itself.
            voiceDone.current.delete(id)
            fileMap.current.delete(id)
            dispatch({ type: 'remove', localId: id })
            sent(attachment)
            return
          }
          dispatch({ type: 'done', localId: id, attachment })
        },
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
  const voiceDone = useRef(new Map<string, (attachment: Attachment) => void>())
  const [sendOriginal, setSendOriginalState] = useState(loadSendOriginal)
  const sendOriginalRef = useRef(sendOriginal)
  /** Per item: which preparation is the current one (a toggle starts another). */
  const generation = useRef(new Map<string, number>())

  /** Make a picture ready (smaller copy, preview) and queue it; the file itself when that fails. */
  const prepare = useCallback(
    (id: string, file: File) => {
      const gen = (generation.current.get(id) ?? 0) + 1
      generation.current.set(id, gen)
      void preparePhoto(file, sendOriginalRef.current)
        .catch(() => ({ blob: file as Blob, name: file.name, preview: null, downsized: false, reducible: false }))
        .then((prepared) => {
          if (generation.current.get(id) !== gen || !fileMap.current.has(id)) return
          dispatch({
            type: 'prepared',
            localId: id,
            name: prepared.name,
            size: prepared.blob.size,
            originalSize: file.size,
            downsized: prepared.downsized,
            reducible: prepared.reducible,
          })
          queue.add(id, { blob: prepared.blob, name: prepared.name, preview: prepared.preview }, prepared.name)
        })
    },
    [queue],
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
          ...(worthDecoding(file) ? { preparing: true } : {}),
        }
        items.push(item)
        starts.push({ item, file })
        fileMap.current.set(item.localId, file)
      }
      if (skipped > 0) problems.push(`Bir mesaja en fazla ${MAX_ATTACHMENTS} dosya eklenebilir.`)
      setNotice(problems.length > 0 ? problems.join(' ') : null)
      dispatch({ type: 'add', items })
      for (const { item, file } of starts) {
        if (item.preparing) prepare(item.localId, file)
        else queue.add(item.localId, { blob: file, name: file.name }, file.name)
      }
    },
    [queue, prepare],
  )

  const addVoice = useCallback(
    (channelId: number, file: File, voice: VoiceMeta, onUploaded: (attachment: Attachment) => void) => {
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
        voice: true,
      }
      fileMap.current.set(item.localId, file)
      voiceDone.current.set(item.localId, onUploaded)
      dispatch({ type: 'add', items: [item] })
      queue.add(item.localId, { blob: file, name: file.name, voice }, file.name)
    },
    [queue],
  )

  const setSendOriginal = useCallback(
    (value: boolean) => {
      if (value === sendOriginalRef.current) return
      sendOriginalRef.current = value
      setSendOriginalState(value)
      saveSendOriginal(value)
      // Every picture it changes is prepared again; what it had uploaded is left for the sweep.
      for (const list of Object.values(stateRef.current)) {
        for (const item of list) {
          if (!item.reducible || item.voice || item.status === 'error') continue
          const file = fileMap.current.get(item.localId)
          if (!file) continue
          queue.cancel(item.localId)
          dispatch({ type: 'reprepare', localId: item.localId })
          prepare(item.localId, file)
        }
      }
    },
    [queue, prepare],
  )

  const remove = useCallback(
    (id: string) => {
      queue.cancel(id)
      fileMap.current.delete(id)
      generation.current.delete(id)
      voiceDone.current.delete(id)
      dispatch({ type: 'remove', localId: id })
    },
    [queue],
  )

  const take = useCallback((channelId: number) => {
    const list = stateRef.current[channelId] ?? []
    // A voice message is sent by itself (addVoice), never with the typed message.
    const ready = list.filter((item) => item.status === 'done' && !item.voice)
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
  return {
    pending,
    add,
    remove,
    take,
    uploading,
    failed,
    anyPending,
    notice,
    dismissNotice,
    files: fileMap.current,
    sendOriginal,
    setSendOriginal,
    addVoice,
  }
}
