/**
 * Uploads one file at a time (CONTRACT-V3 §4: the server takes ONE upload in
 * flight per user and answers a second with `429 UPLOAD_IN_PROGRESS`).
 *
 * Files wait in order; the next starts when the running one finishes, fails
 * or is cancelled. A file refused with UPLOAD_IN_PROGRESS — another tab or
 * device of the same user is uploading — is tried again after a short wait,
 * a few times, before the error is reported. Pure: the upload function and
 * the timers are injected.
 */
import type { Attachment } from '../types'

export interface QueueUpload {
  promise: Promise<Attachment>
  abort: () => void
}

export interface QueueTimers {
  setTimeout: (callback: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

export interface QueueEvents {
  /** The file is being sent now (again, after a wait). */
  onStart: (id: string) => void
  onProgress: (id: string, fraction: number) => void
  onDone: (id: string, attachment: Attachment) => void
  /** Given up: `code` is the server's error code (or NETWORK, UNKNOWN…). */
  onError: (id: string, code: string, status: number) => void
  /** Refused because another upload of this user is running; tried again in `delayMs`. */
  onWaiting: (id: string, delayMs: number) => void
}

/** Waits before each retry of an UPLOAD_IN_PROGRESS refusal; its length is the number of retries. */
export const BUSY_RETRY_DELAYS_MS = [1000, 2500, 5000] as const

interface Job<F> {
  id: string
  file: F
  name: string
  attempt: number
}

export type StartUpload<F> = (file: F, name: string, onProgress: (fraction: number) => void) => QueueUpload

function errorFields(error: unknown): { code: string; status: number } {
  if (typeof error === 'object' && error !== null) {
    const e = error as { code?: unknown; status?: unknown }
    return {
      code: typeof e.code === 'string' ? e.code : 'UNKNOWN',
      status: typeof e.status === 'number' ? e.status : 0,
    }
  }
  return { code: 'UNKNOWN', status: 0 }
}

export class UploadQueue<F> {
  private readonly waiting: Job<F>[] = []
  private running: { job: Job<F>; upload: QueueUpload } | null = null
  /** A job between a busy refusal and its retry. */
  private sleeping: { job: Job<F>; timer: unknown } | null = null
  private stopped = false

  constructor(
    private readonly start: StartUpload<F>,
    private readonly events: QueueEvents,
    private readonly timers: QueueTimers = {
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    },
    private readonly retryDelays: readonly number[] = BUSY_RETRY_DELAYS_MS,
  ) {}

  /** Ids not finished yet, in the order they will be sent (the running one first). */
  get pendingIds(): string[] {
    const ids: string[] = []
    if (this.running) ids.push(this.running.job.id)
    if (this.sleeping) ids.push(this.sleeping.job.id)
    for (const job of this.waiting) ids.push(job.id)
    return ids
  }

  add(id: string, file: F, name: string): void {
    if (this.stopped) return
    this.waiting.push({ id, file, name, attempt: 0 })
    this.next()
  }

  /** Stops one file wherever it is: waiting, sleeping before a retry, or being sent. */
  cancel(id: string): void {
    const index = this.waiting.findIndex((job) => job.id === id)
    if (index >= 0) {
      this.waiting.splice(index, 1)
      return
    }
    if (this.sleeping?.job.id === id) {
      this.timers.clearTimeout(this.sleeping.timer)
      this.sleeping = null
      this.next()
      return
    }
    if (this.running?.job.id === id) {
      const { upload } = this.running
      // Cleared first: the rejection that follows the abort is then not ours.
      this.running = null
      upload.abort()
      this.next()
    }
  }

  /** Everything stops; nothing more is reported. */
  stop(): void {
    this.stopped = true
    this.waiting.length = 0
    if (this.sleeping) this.timers.clearTimeout(this.sleeping.timer)
    this.sleeping = null
    const running = this.running
    this.running = null
    running?.upload.abort()
  }

  private next(): void {
    if (this.stopped || this.running || this.sleeping) return
    const job = this.waiting.shift()
    if (job) this.run(job)
  }

  private run(job: Job<F>): void {
    this.events.onStart(job.id)
    let upload: QueueUpload
    try {
      upload = this.start(job.file, job.name, (fraction) => {
        if (this.running?.job === job) this.events.onProgress(job.id, fraction)
      })
    } catch (error) {
      const { code, status } = errorFields(error)
      this.events.onError(job.id, code, status)
      this.next()
      return
    }
    const entry = { job, upload }
    this.running = entry
    upload.promise.then(
      (attachment) => {
        if (this.running !== entry) return
        this.running = null
        this.events.onDone(job.id, attachment)
        this.next()
      },
      (error: unknown) => {
        if (this.running !== entry) return
        this.running = null
        const { code, status } = errorFields(error)
        if (code === 'UPLOAD_IN_PROGRESS' && job.attempt < this.retryDelays.length) {
          const delay = this.retryDelays[job.attempt]
          job.attempt += 1
          this.events.onWaiting(job.id, delay)
          const timer = this.timers.setTimeout(() => {
            if (this.sleeping?.job !== job) return
            this.sleeping = null
            this.run(job)
          }, delay)
          this.sleeping = { job, timer }
          return
        }
        this.events.onError(job.id, code, status)
        this.next()
      },
    )
  }
}
