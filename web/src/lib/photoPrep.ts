/**
 * Preparing a picture for upload (CONTRACT-V6-MEDIA §1): in the photo worker
 * when this browser can run one with an OffscreenCanvas, else on the page.
 * Whatever goes wrong, the answer is "send the file as it is".
 */
import { photoType, renamed } from './photoPlan'
import { processPhoto, type ProcessResult } from './photoProcess'

export interface PreparedPhoto {
  /** What to upload: the smaller copy, or the file itself. */
  blob: Blob
  name: string
  preview: Blob | null
  /** A smaller copy is being sent. */
  downsized: boolean
  /** "Orijinali gönder" would change something for this picture. */
  reducible: boolean
}

let worker: Worker | null | undefined
let nextId = 0
const waiting = new Map<number, (result: ProcessResult) => void>()

function photoWorker(): Worker | null {
  if (worker !== undefined) return worker
  worker = null
  if (typeof Worker !== 'function' || typeof OffscreenCanvas !== 'function') return null
  try {
    worker = new Worker(new URL('./photoWorker.ts', import.meta.url), { type: 'module', name: 'trio-photo' })
    worker.onmessage = (event: MessageEvent<{ id: number; result: ProcessResult }>) => {
      waiting.get(event.data.id)?.(event.data.result)
      waiting.delete(event.data.id)
    }
    worker.onerror = () => {
      // A worker that cannot start (or died): every waiting picture goes up as it is,
      // and the next ones are done on the page.
      for (const resolve of waiting.values()) resolve({ decoded: false })
      waiting.clear()
      worker?.terminate()
      worker = null
    }
  } catch {
    worker = null
  }
  return worker
}

function inWorker(target: Worker, request: Parameters<typeof processPhoto>[0]): Promise<ProcessResult> {
  return new Promise((resolve) => {
    nextId += 1
    waiting.set(nextId, resolve)
    target.postMessage({ id: nextId, request })
  })
}

export async function preparePhoto(file: File, sendOriginal: boolean): Promise<PreparedPhoto> {
  const unchanged: PreparedPhoto = { blob: file, name: file.name, preview: null, downsized: false, reducible: false }
  const type = photoType(file)
  if (type === null) return unchanged
  const request = { file, type, sendOriginal }
  let result: ProcessResult
  try {
    const target = photoWorker()
    result = target ? await inWorker(target, request) : await processPhoto(request)
  } catch {
    return unchanged
  }
  if (!result.decoded) return unchanged
  const encoded = result.encoded
  return {
    blob: encoded ?? file,
    name: encoded ? renamed(file.name, encoded.type) : file.name,
    preview: result.preview,
    downsized: encoded !== null,
    reducible: result.reducible,
  }
}
