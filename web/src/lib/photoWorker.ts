/// <reference lib="webworker" />
/**
 * The photo worker (CONTRACT-V6-MEDIA §1): decoding a 12-megapixel photo and
 * encoding it again happen here, off the page's thread, so the composer never
 * freezes. One request at a time is answered in order; each carries an id.
 */
import { processPhoto, type ProcessRequest } from './photoProcess'

declare const self: DedicatedWorkerGlobalScope

self.onmessage = async (event: MessageEvent<{ id: number; request: ProcessRequest }>) => {
  const { id, request } = event.data
  let result
  try {
    result = await processPhoto(request)
  } catch {
    result = { decoded: false as const }
  }
  self.postMessage({ id, result })
}
