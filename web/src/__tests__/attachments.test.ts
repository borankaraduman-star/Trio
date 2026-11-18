import { describe, expect, it } from 'vitest'
import {
  attachmentKind,
  fileProblem,
  formatSize,
  MAX_UPLOAD_BYTES,
  pastedFileName,
  uploadErrorMessage,
} from '../lib/attachments'
import { isUploading, pendingReducer, readyAttachments, remainingSlots, type PendingAttachment } from '../lib/pending'

describe('attachmentKind', () => {
  it.each([
    ['image/png', 'image'],
    ['image/jpeg', 'image'],
    ['image/gif', 'image'],
    ['IMAGE/WEBP', 'image'],
    ['video/mp4', 'video'],
    ['video/webm', 'video'],
    ['audio/mpeg', 'audio'],
    ['audio/ogg', 'audio'],
    ['audio/wav', 'audio'],
    ['audio/ogg; codecs=opus', 'audio'],
  ])('%s is shown as %s', (type, kind) => {
    expect(attachmentKind(type)).toBe(kind)
  })

  it.each(['image/svg+xml', 'text/html', 'application/pdf', 'application/octet-stream', 'video/quicktime', 'image/bmp', ''])(
    '%s is a file row (never rendered)',
    (type) => {
      expect(attachmentKind(type)).toBe('file')
    },
  )
})

describe('formatSize', () => {
  it.each([
    [0, '0 B'],
    [512, '512 B'],
    [1023, '1023 B'],
    [1024, '1 KB'],
    [1536, '1,5 KB'],
    [10 * 1024, '10 KB'],
    [1024 * 1024 * 9.84, '9,8 MB'],
    [25 * 1024 * 1024, '25 MB'],
    [1.25 * 1024 ** 3, '1,3 GB'],
  ])('%d → %s', (bytes, text) => {
    expect(formatSize(bytes)).toBe(text)
  })

  it('does not crash on nonsense', () => {
    expect(formatSize(-1)).toBe('?')
    expect(formatSize(Number.NaN)).toBe('?')
  })
})

describe('fileProblem', () => {
  it('refuses a file over the limit with a Turkish sentence naming it', () => {
    const message = fileProblem({ name: 'film.mkv', size: MAX_UPLOAD_BYTES + 1 })
    expect(message).toContain('film.mkv')
    expect(message).toContain('çok büyük')
    expect(message).toContain('25 MB')
  })

  it('accepts a file at the limit and refuses an empty one', () => {
    expect(fileProblem({ name: 'a', size: MAX_UPLOAD_BYTES })).toBeNull()
    expect(fileProblem({ name: 'bos.txt', size: 0 })).toContain('boş')
  })

  it('has a sentence for every server error', () => {
    expect(uploadErrorMessage('FILE_TOO_LARGE')).toContain('25 MB')
    expect(uploadErrorMessage('INVALID_UPLOAD')).toMatch(/yüklenemedi/)
    expect(uploadErrorMessage('WHATEVER')).toBe('Dosya yüklenemedi.')
  })

  it('names pasted images with a timestamp', () => {
    expect(pastedFileName('image/png', new Date(2026, 10, 18, 9, 5, 7))).toBe('yapistirilan-20261118-090507.png')
    expect(pastedFileName('image/jpeg', new Date(2026, 0, 1, 0, 0, 0))).toBe('yapistirilan-20260101-000000.jpg')
  })
})

function item(localId: string, channelId: number, status: PendingAttachment['status'] = 'uploading'): PendingAttachment {
  return {
    localId,
    channelId,
    name: `${localId}.png`,
    size: 10,
    type: 'image/png',
    status,
    progress: 0,
    attachment: null,
    error: null,
  }
}

const ATTACHMENT = { id: 'x', filename: 'a.png', content_type: 'image/png', size: 10, url: '/api/files/x/a.png' }

describe('pending attachments', () => {
  it('adds per channel, tracks progress, completion and errors', () => {
    let state = pendingReducer({}, { type: 'add', items: [item('a', 1), item('b', 1), item('c', 2)] })
    expect(state[1].map((p) => p.localId)).toEqual(['a', 'b'])
    state = pendingReducer(state, { type: 'progress', localId: 'a', progress: 0.5 })
    expect(state[1][0].progress).toBe(0.5)
    state = pendingReducer(state, { type: 'done', localId: 'a', attachment: ATTACHMENT })
    state = pendingReducer(state, { type: 'error', localId: 'b', error: 'Dosya yüklenemedi.' })
    // Progress after completion is ignored.
    state = pendingReducer(state, { type: 'progress', localId: 'a', progress: 0.1 })
    expect(state[1][0]).toMatchObject({ status: 'done', progress: 1, attachment: ATTACHMENT })
    expect(state[1][1]).toMatchObject({ status: 'error', error: 'Dosya yüklenemedi.' })
    expect(readyAttachments(state[1])).toEqual([ATTACHMENT])
    expect(isUploading(state[1])).toBe(false)
    expect(isUploading(state[2])).toBe(true)
  })

  it('removes one and takes the sent ones', () => {
    let state = pendingReducer({}, { type: 'add', items: [item('a', 1, 'done'), item('b', 1)] })
    state = pendingReducer(state, { type: 'remove', localId: 'b' })
    expect(state[1].map((p) => p.localId)).toEqual(['a'])
    state = pendingReducer(state, { type: 'taken', channelId: 1, localIds: ['a'] })
    expect(state[1]).toEqual([])
    expect(pendingReducer(state, { type: 'remove', localId: 'nope' })).toBe(state)
  })

  it('counts free slots out of ten, ignoring failed uploads', () => {
    const list = [...Array.from({ length: 9 }, (_, i) => item(`u${i}`, 1)), item('bad', 1, 'error')]
    expect(remainingSlots(list)).toBe(1)
    expect(remainingSlots([...list, item('z', 1)])).toBe(0)
  })
})
