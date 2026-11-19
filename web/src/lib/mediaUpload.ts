/**
 * One upload of the queue (CONTRACT-V2 §2 + V6): the file and, for V6, its
 * preview or voice marker. A server that refuses the preview
 * (`422 INVALID_PREVIEW`) still gets the file: it is sent again without one,
 * because the file is what matters.
 */
import { ApiError } from '../api'
import type { Attachment, VoiceMeta } from '../types'
import type { UploadExtras, UploadHandle } from '../uploads'

export interface UploadSource {
  blob: Blob
  name: string
  preview?: Blob | null
  voice?: VoiceMeta | null
}

export type UploadFn = (
  blob: Blob,
  name: string,
  onProgress: (fraction: number) => void,
  extras: UploadExtras,
) => UploadHandle

export function startUpload(upload: UploadFn, source: UploadSource, onProgress: (fraction: number) => void): UploadHandle {
  let current = upload(source.blob, source.name, onProgress, { preview: source.preview, voice: source.voice })
  let aborted = false
  const promise: Promise<Attachment> = current.promise.catch((error: unknown) => {
    if (aborted || !source.preview || !(error instanceof ApiError) || error.code !== 'INVALID_PREVIEW') throw error
    current = upload(source.blob, source.name, onProgress, { voice: source.voice })
    return current.promise
  })
  return {
    promise,
    abort: () => {
      aborted = true
      current.abort()
    },
  }
}
