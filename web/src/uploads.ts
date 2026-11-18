import { ApiError } from './api'
import type { Attachment } from './types'

export interface UploadHandle {
  promise: Promise<Attachment>
  /** Cancels the upload; `promise` then rejects with code `ABORTED`. */
  abort: () => void
}

function isAttachment(value: unknown): value is Attachment {
  if (typeof value !== 'object' || value === null) return false
  const a = value as Record<string, unknown>
  return (
    typeof a.id === 'string' &&
    typeof a.filename === 'string' &&
    typeof a.content_type === 'string' &&
    typeof a.size === 'number' &&
    typeof a.url === 'string'
  )
}

/**
 * `POST /api/uploads` with one multipart part `file` (CONTRACT-V2 §2).
 * XMLHttpRequest rather than fetch: it reports upload progress and aborts.
 */
export function uploadFile(
  token: string,
  file: Blob,
  filename: string,
  onProgress: (fraction: number) => void,
): UploadHandle {
  const xhr = new XMLHttpRequest()
  const promise = new Promise<Attachment>((resolve, reject) => {
    xhr.open('POST', '/api/uploads')
    xhr.setRequestHeader('Authorization', `Bearer ${token}`)
    xhr.responseType = 'text'
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(Math.min(1, event.loaded / event.total))
    }
    xhr.onload = () => {
      let payload: unknown = null
      try {
        payload = JSON.parse(xhr.responseText)
      } catch {
        // Handled below by status.
      }
      if (xhr.status === 201 || xhr.status === 200) {
        const attachment = (payload as { attachment?: unknown } | null)?.attachment
        if (isAttachment(attachment)) {
          onProgress(1)
          resolve(attachment)
        } else reject(new ApiError(xhr.status, 'BAD_RESPONSE', 'bad response'))
        return
      }
      const error = (payload as { error?: { code?: unknown; message?: unknown } } | null)?.error
      const code =
        typeof error?.code === 'string'
          ? error.code
          : xhr.status === 413
            ? 'FILE_TOO_LARGE'
            : xhr.status === 401
              ? 'UNAUTHORIZED'
              : 'UNKNOWN'
      reject(new ApiError(xhr.status, code, typeof error?.message === 'string' ? error.message : `HTTP ${xhr.status}`))
    }
    xhr.onerror = () => reject(new ApiError(0, 'NETWORK', 'network error'))
    xhr.onabort = () => reject(new ApiError(0, 'ABORTED', 'aborted'))
    const form = new FormData()
    form.append('file', file, filename)
    xhr.send(form)
  })
  return { promise, abort: () => xhr.abort() }
}
