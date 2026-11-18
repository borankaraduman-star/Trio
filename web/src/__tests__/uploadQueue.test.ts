import { describe, expect, it } from 'vitest'
import { pendingReducer, isUploading, type PendingAttachment } from '../lib/pending'
import { BUSY_RETRY_DELAYS_MS, UploadQueue, type QueueTimers } from '../lib/uploadQueue'
import type { Attachment } from '../types'

class FakeUpload {
  resolve!: (a: Attachment) => void
  reject!: (e: unknown) => void
  aborted = false
  progress!: (f: number) => void
  promise: Promise<Attachment>
  constructor(readonly name: string) {
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    })
  }
  abort = () => {
    this.aborted = true
    this.reject({ code: 'ABORTED', status: 0 })
  }
}

function attachment(id: string): Attachment {
  return { id, filename: `${id}.png`, content_type: 'image/png', size: 1, url: `/api/files/${id}/x` }
}

class FakeTimers implements QueueTimers {
  pending: { callback: () => void; ms: number; handle: number }[] = []
  private next = 1
  setTimeout = (callback: () => void, ms: number) => {
    const handle = this.next++
    this.pending.push({ callback, ms, handle })
    return handle
  }
  clearTimeout = (handle: unknown) => {
    this.pending = this.pending.filter((t) => t.handle !== handle)
  }
  fire(): number {
    const timer = this.pending.shift()
    if (!timer) throw new Error('no timer')
    timer.callback()
    return timer.ms
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function setup() {
  const started: FakeUpload[] = []
  const log: string[] = []
  const timers = new FakeTimers()
  const queue = new UploadQueue<string>(
    (file, _name, onProgress) => {
      const upload = new FakeUpload(file)
      upload.progress = onProgress
      started.push(upload)
      return upload
    },
    {
      onStart: (id) => log.push(`start ${id}`),
      onProgress: (id, f) => log.push(`progress ${id} ${f}`),
      onDone: (id, a) => log.push(`done ${id} ${a.id}`),
      onError: (id, code) => log.push(`error ${id} ${code}`),
      onWaiting: (id, ms) => log.push(`waiting ${id} ${ms}`),
    },
    timers,
  )
  return { queue, started, log, timers }
}

describe('UploadQueue', () => {
  it('sends one file at a time, in order', async () => {
    const { queue, started, log } = setup()
    queue.add('a', 'A', 'a.png')
    queue.add('b', 'B', 'b.png')
    queue.add('c', 'C', 'c.png')
    expect(started.map((u) => u.name)).toEqual(['A'])
    expect(queue.pendingIds).toEqual(['a', 'b', 'c'])
    started[0].progress(0.5)
    started[0].resolve(attachment('x'))
    await flush()
    expect(started.map((u) => u.name)).toEqual(['A', 'B'])
    started[1].reject({ code: 'FILE_TOO_LARGE', status: 413 })
    await flush()
    expect(started.map((u) => u.name)).toEqual(['A', 'B', 'C'])
    started[2].resolve(attachment('z'))
    await flush()
    expect(log).toEqual([
      'start a',
      'progress a 0.5',
      'done a x',
      'start b',
      'error b FILE_TOO_LARGE',
      'start c',
      'done c z',
    ])
    expect(queue.pendingIds).toEqual([])
  })

  it('cancelling the running file aborts it and starts the next; its abort is not reported', async () => {
    const { queue, started, log } = setup()
    queue.add('a', 'A', 'a')
    queue.add('b', 'B', 'b')
    queue.cancel('a')
    expect(started[0].aborted).toBe(true)
    expect(started.map((u) => u.name)).toEqual(['A', 'B'])
    await flush()
    expect(log).toEqual(['start a', 'start b'])
  })

  it('cancelling a waiting file drops it without starting anything', async () => {
    const { queue, started } = setup()
    queue.add('a', 'A', 'a')
    queue.add('b', 'B', 'b')
    queue.add('c', 'C', 'c')
    queue.cancel('b')
    started[0].resolve(attachment('x'))
    await flush()
    expect(started.map((u) => u.name)).toEqual(['A', 'C'])
  })

  it('retries UPLOAD_IN_PROGRESS after a wait, a few times, then reports it', async () => {
    const { queue, started, log, timers } = setup()
    queue.add('a', 'A', 'a')
    queue.add('b', 'B', 'b')
    for (let i = 0; i < BUSY_RETRY_DELAYS_MS.length; i += 1) {
      started[started.length - 1].reject({ code: 'UPLOAD_IN_PROGRESS', status: 429 })
      await flush()
      // Nothing else starts while the busy file sleeps.
      expect(started.every((u) => u.name === 'A')).toBe(true)
      expect(timers.fire()).toBe(BUSY_RETRY_DELAYS_MS[i])
    }
    started[started.length - 1].reject({ code: 'UPLOAD_IN_PROGRESS', status: 429 })
    await flush()
    expect(log.filter((l) => l.startsWith('waiting')).length).toBe(BUSY_RETRY_DELAYS_MS.length)
    expect(log).toContain('error a UPLOAD_IN_PROGRESS')
    expect(started[started.length - 1].name).toBe('B')
  })

  it('a busy file that gets through on a retry is done', async () => {
    const { queue, started, log, timers } = setup()
    queue.add('a', 'A', 'a')
    started[0].reject({ code: 'UPLOAD_IN_PROGRESS', status: 429 })
    await flush()
    timers.fire()
    started[1].resolve(attachment('x'))
    await flush()
    expect(log).toEqual(['start a', 'waiting a 1000', 'start a', 'done a x'])
  })

  it('cancelling a sleeping file clears its timer and moves on', async () => {
    const { queue, started, timers } = setup()
    queue.add('a', 'A', 'a')
    queue.add('b', 'B', 'b')
    started[0].reject({ code: 'UPLOAD_IN_PROGRESS', status: 429 })
    await flush()
    queue.cancel('a')
    expect(timers.pending).toHaveLength(0)
    expect(started.map((u) => u.name)).toEqual(['A', 'B'])
  })

  it('stop aborts everything and reports nothing more', async () => {
    const { queue, started, log } = setup()
    queue.add('a', 'A', 'a')
    queue.add('b', 'B', 'b')
    queue.stop()
    await flush()
    expect(started).toHaveLength(1)
    expect(started[0].aborted).toBe(true)
    queue.add('c', 'C', 'c')
    expect(started).toHaveLength(1)
    expect(log).toEqual(['start a'])
  })
})

describe('pending chips with a queue', () => {
  const item = (id: string): PendingAttachment => ({
    localId: id,
    channelId: 1,
    name: id,
    size: 1,
    type: 'image/png',
    status: 'queued',
    progress: 0,
    attachment: null,
    error: null,
  })

  it('queued → uploading → waiting → uploading → done; queued counts as uploading', () => {
    let state = pendingReducer({}, { type: 'add', items: [item('a')] })
    expect(isUploading(state[1])).toBe(true)
    state = pendingReducer(state, { type: 'start', localId: 'a' })
    expect(state[1][0].status).toBe('uploading')
    state = pendingReducer(state, { type: 'waiting', localId: 'a' })
    expect(state[1][0]).toMatchObject({ status: 'queued', waiting: true })
    state = pendingReducer(state, { type: 'start', localId: 'a' })
    expect(state[1][0]).toMatchObject({ status: 'uploading', waiting: false })
    state = pendingReducer(state, { type: 'done', localId: 'a', attachment: attachment('x') })
    expect(isUploading(state[1])).toBe(false)
  })
})
