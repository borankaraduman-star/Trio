import { describe, expect, it } from 'vitest'
import { ApiError } from '../api'
import { linkify } from '../lib/linkify'
import {
  chooseEncoding,
  fitWithin,
  hasTransparency,
  keepSmaller,
  loadSendOriginal,
  MAX_EDGE,
  photoType,
  planPhoto,
  renamed,
  saveSendOriginal,
  SMALL_BYTES,
} from '../lib/photoPlan'
import { attachmentBoxStyle, fitBox } from '../lib/imageBox'
import {
  extensionFor,
  formatDuration,
  micErrorMessage,
  nextRate,
  pickRecorderType,
  rateLabel,
  slidAway,
  voiceFileName,
  waveformBars,
} from '../lib/voiceNote'
import { anyText, isEmpty, loadDrafts, parseDrafts, saveDrafts, withDraft } from '../lib/drafts'
import { appendPage, groupByMonth, monthLabel, step, swipeDirection } from '../lib/gallery'
import { failedSend } from '../lib/sendFailure'
import { startUpload } from '../lib/mediaUpload'
import { pendingReducer, isUploading, type PendingAttachment } from '../lib/pending'
import type { Attachment, Message } from '../types'
import shared from '../../../shared/linkify-cases.json'

describe('one URL rule with the server (shared/linkify-cases.json)', () => {
  const fixture = shared as { cases: { text: string; links: string[] }[] }
  it('has the tricky cases', () => expect(fixture.cases.length).toBeGreaterThanOrEqual(20))
  for (const c of fixture.cases) {
    it(JSON.stringify(c.text).slice(0, 60), () => {
      expect(linkify(c.text).flatMap((p) => (p.type === 'link' ? [p.value] : []))).toEqual(c.links)
    })
  }
})

describe('photo plan', () => {
  it('fits the longest edge, never enlarging', () => {
    expect(fitWithin(4000, 3000, 2048)).toEqual({ width: 2048, height: 1536 })
    expect(fitWithin(3000, 4000, 2048)).toEqual({ width: 1536, height: 2048 })
    expect(fitWithin(800, 600, 2048)).toEqual({ width: 800, height: 600 })
    expect(fitWithin(10000, 10, 2048)).toEqual({ width: 2048, height: 2 })
    expect(fitWithin(100000, 1, 2048)).toEqual({ width: 2048, height: 1 })
  })

  it('knows which files to decode', () => {
    expect(photoType({ type: 'image/jpeg', name: 'a' })).toBe('image/jpeg')
    expect(photoType({ type: 'image/gif', name: 'a.gif' })).toBeNull()
    expect(photoType({ type: 'image/svg+xml', name: 'a.svg' })).toBeNull()
    expect(photoType({ type: '', name: 'IMG_1.HEIC' })).toBe('image/heic')
    expect(photoType({ type: '', name: 'notes.txt' })).toBeNull()
  })

  it('downscales a big phone photo and makes a preview', () => {
    const plan = planPhoto({ type: 'image/jpeg', size: 5_000_000, width: 3000, height: 4000, sendOriginal: false })
    expect(plan).toEqual({ downscale: true, target: { width: 1536, height: 2048 }, quality: 0.82, preview: { width: 360, height: 480 } })
  })

  it('leaves small pictures, GIFs and "Orijinali gönder" alone', () => {
    expect(planPhoto({ type: 'image/png', size: SMALL_BYTES - 1, width: 640, height: 400, sendOriginal: false }).downscale).toBe(false)
    expect(planPhoto({ type: 'image/png', size: SMALL_BYTES - 1, width: 640, height: 400, sendOriginal: false }).preview).toBeNull()
    // Small in bytes but too large in pixels: done.
    expect(planPhoto({ type: 'image/png', size: 1000, width: MAX_EDGE + 1, height: 10, sendOriginal: false }).downscale).toBe(true)
    // Heavy but small in pixels: re-encoded (same size), PNG at the higher quality.
    const heavy = planPhoto({ type: 'image/png', size: SMALL_BYTES, width: 800, height: 600, sendOriginal: false })
    expect([heavy.downscale, heavy.quality, heavy.target]).toEqual([true, 0.9, { width: 800, height: 600 }])
    expect(planPhoto({ type: 'image/gif', size: 9e6, width: 4000, height: 3000, sendOriginal: false }).downscale).toBe(false)
    const original = planPhoto({ type: 'image/jpeg', size: 9e6, width: 4000, height: 3000, sendOriginal: true })
    expect(original.downscale).toBe(false)
    // The preview is made either way.
    expect(original.preview).toEqual({ width: 480, height: 360 })
    expect(planPhoto({ type: 'image/jpeg', size: 9e6, width: 960, height: 700, sendOriginal: false }).preview).toBeNull()
  })

  it('keeps alpha or keeps the original', () => {
    expect(chooseEncoding(true, true)).toBe('image/webp')
    expect(chooseEncoding(false, false)).toBe('image/jpeg')
    expect(chooseEncoding(false, true)).toBeNull()
    expect(hasTransparency([1, 2, 3, 255, 4, 5, 6, 255])).toBe(false)
    expect(hasTransparency([1, 2, 3, 255, 4, 5, 6, 254])).toBe(true)
  })

  it('uses a copy only when it is smaller, and renames it', () => {
    expect(keepSmaller(1000, 999)).toBe(true)
    expect(keepSmaller(1000, 1000)).toBe(false)
    expect(keepSmaller(1000, 0)).toBe(false)
    expect(renamed('IMG_2041.JPG', 'image/webp')).toBe('IMG_2041.webp')
    expect(renamed('ekran.goruntusu.png', 'image/jpeg')).toBe('ekran.goruntusu.jpg')
    expect(renamed('adsiz', 'image/webp')).toBe('adsiz.webp')
  })

  it('remembers "Orijinali gönder" per device', () => {
    const map = new Map<string, string>()
    const storage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    }
    expect(loadSendOriginal(storage)).toBe(false)
    saveSendOriginal(true, storage)
    expect(loadSendOriginal(storage)).toBe(true)
    saveSendOriginal(false, storage)
    expect(map.size).toBe(0)
    expect(loadSendOriginal({ getItem: () => { throw new Error('blocked') } })).toBe(false)
  })
})

describe('image box', () => {
  it('fits the picture into 400 × 300 without enlarging', () => {
    expect(fitBox(640, 400)).toEqual({ width: 400, height: 250 })
    expect(fitBox(1536, 2048)).toEqual({ width: 225, height: 300 })
    expect(fitBox(120, 80)).toEqual({ width: 120, height: 80 })
    expect(fitBox(null, 10)).toBeNull()
    expect(fitBox(0, 10)).toBeNull()
  })

  it('reserves the box with the aspect ratio, or leaves the fixed letterbox', () => {
    expect(attachmentBoxStyle({ width: 640, height: 400 })).toEqual({ width: 'min(400px, 100%)', height: 'auto', aspectRatio: '640 / 400' })
    expect(attachmentBoxStyle({})).toBeNull()
  })
})

describe('voice notes', () => {
  it('picks the best recorder type this browser has', () => {
    expect(pickRecorderType((t) => t.startsWith('audio/webm'))).toBe('audio/webm;codecs=opus')
    expect(pickRecorderType((t) => t === 'audio/mp4')).toBe('audio/mp4')
    expect(pickRecorderType(() => { throw new Error('x') })).toBe('')
    expect(extensionFor('audio/mp4;codecs=opus')).toBe('m4a')
    expect(extensionFor('audio/webm;codecs=opus')).toBe('webm')
    expect(voiceFileName('audio/webm', new Date(2026, 10, 19, 9, 5, 3))).toBe('sesli-mesaj-20261119-090503.webm')
  })

  it('draws 64 bars scaled to the loudest', () => {
    const bars = waveformBars(Array.from({ length: 640 }, (_, i) => (i % 10) / 20))
    expect(bars).toHaveLength(64)
    expect(Math.max(...bars)).toBe(255)
    expect(bars.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)).toBe(true)
    expect(waveformBars([])).toEqual(new Array(64).fill(0))
    expect(waveformBars([0, 0, 0])).toEqual(new Array(64).fill(0))
    // Fewer levels than bars: every bar still has a value.
    expect(waveformBars([0.1, 0.2]).filter((b) => b > 0)).toHaveLength(64)
  })

  it('writes times, speeds and gestures', () => {
    expect(formatDuration(7400)).toBe('0:07')
    expect(formatDuration(120_000)).toBe('2:00')
    expect(formatDuration(Infinity)).toBe('0:00')
    expect([nextRate(1), nextRate(1.5), nextRate(2)]).toEqual([1.5, 2, 1])
    expect(rateLabel(1.5)).toBe('1,5×')
    expect(slidAway(-81, 0)).toBe(true)
    expect(slidAway(40, 40)).toBe(false)
    expect(micErrorMessage({ name: 'NotAllowedError' })).toMatch(/Mikrofon izni verilmedi/)
    expect(micErrorMessage({ name: 'NotFoundError' })).toMatch(/bulunamadı/)
  })
})

const message = (id: number): Message => ({ id, channel_id: 1, author: { id: 2, name: 'Ayşe' }, content: 'selam', created_at: '' })

describe('drafts', () => {
  it('keeps text and reply per channel, drops empty ones', () => {
    let d = withDraft({}, 1, { text: 'yarım', reply: null })
    d = withDraft(d, 2, { text: '', reply: message(9) })
    expect(Object.keys(d)).toEqual(['1', '2'])
    expect(anyText(d)).toBe(true)
    d = withDraft(d, 1, { text: '  ', reply: null })
    expect(Object.keys(d)).toEqual(['2'])
    expect(anyText(d)).toBe(false)
    expect(isEmpty(undefined)).toBe(true)
  })

  it('reads back only well-formed drafts', () => {
    const raw = JSON.stringify({ 1: { text: 'a', reply: null }, 2: { text: 5 }, x: { text: 'b', reply: null }, 3: { text: '', reply: message(4) } })
    expect(Object.keys(parseDrafts(raw))).toEqual(['1', '3'])
    expect(parseDrafts('{bozuk')).toEqual({})
    expect(parseDrafts('[1]')).toEqual({})
    const map = new Map<string, string>()
    const store = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k) }
    saveDrafts({ 1: { text: 'x', reply: null } }, store)
    expect(loadDrafts(store)).toEqual({ 1: { text: 'x', reply: null } })
    saveDrafts({}, store)
    expect(map.size).toBe(0)
  })
})

describe('gallery', () => {
  it('groups by month in Turkish', () => {
    const items = [
      { created_at: '2026-11-18T10:00:00.000Z' },
      { created_at: '2026-11-01T10:00:00.000Z' },
      { created_at: '2026-10-30T10:00:00.000Z' },
    ]
    expect(groupByMonth(items).map((g) => [g.label, g.items.length])).toEqual([
      ['Kasım 2026', 2],
      ['Ekim 2026', 1],
    ])
    expect(monthLabel('bozuk')).toBe('')
  })

  it('appends pages without repeats and moves within bounds', () => {
    expect(appendPage([1, 2], [2, 3], String)).toEqual([1, 2, 3])
    expect([step(0, -1, 5), step(4, 1, 5), step(2, 1, 5)]).toEqual([0, 4, 3])
    expect(swipeDirection(-80, 10)).toBe(1)
    expect(swipeDirection(80, 10)).toBe(-1)
    expect(swipeDirection(-80, 70)).toBe(0)
    expect(swipeDirection(-20, 0)).toBe(0)
  })
})

describe('a refused send names its nonce', () => {
  const row = (nonce: string, status: 'pending' | 'failed' | 'sent') => ({ ...message(-1), key: nonce, nonce, status })
  const messages = {
    1: { items: [row('a', 'pending'), row('b', 'pending')], hasMore: false, loaded: true, loadingOlder: false, error: false },
    5: { items: [row('c', 'failed')], hasMore: false, loaded: true, loadingOlder: false, error: false },
  }
  it('finds exactly that row', () => {
    expect(failedSend({ nonce: 'a' }, messages)).toEqual({ channelId: 1, nonce: 'a' })
    expect(failedSend({ nonce: 'b' }, messages)).toEqual({ channelId: 1, nonce: 'b' })
    expect(failedSend({ nonce: 'c' }, messages)).toBeNull()
    expect(failedSend({}, messages)).toBeNull()
    expect(failedSend({ nonce: 'zzz' }, messages)).toBeNull()
  })
})

describe('uploading with a preview', () => {
  const attachment: Attachment = { id: 'x', filename: 'a', content_type: 'image/webp', size: 1, url: '/x' }
  it('sends the file again without a refused preview', async () => {
    const calls: unknown[] = []
    const handle = startUpload(
      (_blob, _name, _progress, extras) => {
        calls.push(extras.preview ?? null)
        return calls.length === 1
          ? { promise: Promise.reject(new ApiError(422, 'INVALID_PREVIEW', '')), abort: () => undefined }
          : { promise: Promise.resolve(attachment), abort: () => undefined }
      },
      { blob: new Blob(['a']), name: 'a', preview: new Blob(['p']) },
      () => undefined,
    )
    await expect(handle.promise).resolves.toBe(attachment)
    expect(calls).toHaveLength(2)
    expect(calls[1]).toBeNull()
  })

  it('passes any other refusal through', async () => {
    const handle = startUpload(
      () => ({ promise: Promise.reject(new ApiError(413, 'QUOTA_EXCEEDED', '')), abort: () => undefined }),
      { blob: new Blob(['a']), name: 'a', preview: new Blob(['p']) },
      () => undefined,
    )
    await expect(handle.promise).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' })
  })
})

describe('pending pictures', () => {
  const item: PendingAttachment = {
    localId: 'p1', channelId: 1, name: 'IMG.JPG', size: 5_000_000, type: 'image/jpeg', status: 'queued',
    progress: 0, attachment: null, error: null, preparing: true,
  }
  it('are waited for while being prepared, then carry before and after', () => {
    let state = pendingReducer({}, { type: 'add', items: [item] })
    expect(isUploading(state[1])).toBe(true)
    state = pendingReducer(state, { type: 'prepared', localId: 'p1', name: 'IMG.webp', size: 600_000, originalSize: 5_000_000, downsized: true, reducible: true })
    expect(state[1][0]).toMatchObject({ preparing: false, name: 'IMG.webp', size: 600_000, originalSize: 5_000_000, downsized: true })
    state = pendingReducer(state, { type: 'done', localId: 'p1', attachment: { id: 'a', filename: 'IMG.webp', content_type: 'image/webp', size: 600_000, url: '/a' } })
    state = pendingReducer(state, { type: 'reprepare', localId: 'p1' })
    expect(state[1][0]).toMatchObject({ status: 'queued', preparing: true, attachment: null })
  })
})
