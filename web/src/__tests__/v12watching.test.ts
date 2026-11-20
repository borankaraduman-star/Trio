import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  largerSize,
  namesAnd,
  shareButtonText,
  sharesFullMessage,
  sharingLine,
  sideBySide,
  sizedEncoding,
  smallerSize,
  viewSizeFor,
} from '../lib/multishare'
import { profileSettings } from '../lib/shareProfiles'
import { parseWatch } from '../lib/watch'
import { SizeCoordinator, wantedSize } from '../watching/sizes'
import { focusedShare, nextShare, shareOrder } from '../watching/store'
import { baseCode, effectiveWatchKeys, WATCH_REASONS, watchKeyConflict, watchKeyRefusal } from '../watching/keys'
import { miniUrl, miniWindowName } from '../mini/controller'

const NO_KEYS = {
  toggleMini: null,
  nextShare: null,
  clickThrough: null,
  muteShare: null,
  shareVolumeUp: null,
  shareVolumeDown: null,
  theatre: null,
}

describe('view sizes (CONTRACT-V12-WATCHING §3)', () => {
  it('a tile asks by its height in device pixels; not shown is a thumbnail, never off', () => {
    expect(viewSizeFor(400, 1, true)).toBe('mid')
    expect(viewSizeFor(400, 2, true)).toBe('full')
    expect(viewSizeFor(96, 1, true)).toBe('thumb')
    expect(viewSizeFor(900, 1, false)).toBe('thumb')
  })
  it('the largest place wins and the viewer’s choice caps it', () => {
    expect(wantedSize(['thumb', 'full'], { light: false, audioOnly: false })).toBe('full')
    expect(wantedSize(['full'], { light: true, audioOnly: false })).toBe('thumb')
    expect(wantedSize(['full'], { light: false, audioOnly: true })).toBe('audio')
    // Shown nowhere (page hidden, no mini): the picture is not sent.
    expect(wantedSize([], { light: false, audioOnly: false })).toBe('audio')
    expect(largerSize('mid', 'thumb')).toBe('mid')
    expect(smallerSize('mid', 'thumb')).toBe('thumb')
  })
  it('a size is an encoding for one viewer: scaled from the capture, never above the profile', () => {
    const film = profileSettings('film', 'mid')
    expect(sizedEncoding(film, 'full', 1080)).toEqual({ maxBitrate: 3_000_000, maxFramerate: 30, scaleResolutionDownBy: 1 })
    expect(sizedEncoding(film, 'mid', 1080)).toEqual({ maxBitrate: 1_500_000, maxFramerate: 30, scaleResolutionDownBy: 1.5 })
    expect(sizedEncoding(film, 'thumb', 1080)).toEqual({ maxBitrate: 300_000, maxFramerate: 12, scaleResolutionDownBy: 3 })
    // A small capture is never scaled up.
    expect(sizedEncoding(film, 'thumb', 300).scaleResolutionDownBy).toBe(1)
    // Unknown height: no scaling.
    expect(sizedEncoding(film, 'mid', 0).scaleResolutionDownBy).toBe(1)
    // Düşük stays under its own rate.
    expect(sizedEncoding(profileSettings('game', 'low'), 'thumb', 1080).maxBitrate).toBe(300_000)
  })
  it('the watch signal carries a size only with on:true; a bad one is ignored', () => {
    expect(parseWatch({ watch: { stream: 'a', on: true, size: 'thumb' } })).toEqual({ stream: 'a', on: true, size: 'thumb' })
    expect(parseWatch({ watch: { stream: 'a', on: true, size: 'huge' } })).toEqual({ stream: 'a', on: true })
    expect(parseWatch({ watch: { stream: 'a', on: false, size: 'thumb' } })).toEqual({ stream: 'a', on: false })
    expect(parseWatch({ watch: { stream: 'a', on: true } })).toEqual({ stream: 'a', on: true })
  })
})

describe('the size coordinator', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('tells growth at once, shrinking after it settled, and only changes', () => {
    const told: [number, string][] = []
    const c = new SizeCoordinator()
    c.attach({ setViewSize: (id, size) => told.push([id, size]) })
    c.report(7, 'tile', 'full')
    vi.advanceTimersByTime(100)
    expect(told).toEqual([]) // full is what the sharer starts with
    c.report(7, 'tile', 'thumb')
    vi.advanceTimersByTime(300)
    expect(told).toEqual([])
    vi.advanceTimersByTime(500)
    expect(told).toEqual([[7, 'thumb']])
    c.report(7, 'mini', 'full')
    vi.advanceTimersByTime(80)
    expect(told).toEqual([[7, 'thumb'], [7, 'full']])
    // A flicker shorter than the settle time sends nothing.
    c.report(7, 'mini', null)
    vi.advanceTimersByTime(200)
    c.report(7, 'mini', 'full')
    vi.advanceTimersByTime(1000)
    expect(told).toHaveLength(2)
  })
  it('the viewer’s choice applies through refresh', () => {
    const told: string[] = []
    let light = false
    const c = new SizeCoordinator()
    c.attach({ setViewSize: (_id, size) => told.push(size) }, () => ({ light, audioOnly: false }))
    c.report(3, 'tile', 'full')
    light = true
    c.refresh(3)
    vi.advanceTimersByTime(1000)
    expect(told).toEqual(['thumb'])
  })
})

describe('the stage', () => {
  it('Yan yana: two 16:9 screens side by side on a wide stage, ultrawide ones stacked, portrait side by side', () => {
    expect(sideBySide(2, 960, 520, 16 / 9)).toMatchObject({ columns: 2, rows: 1 })
    expect(sideBySide(2, 960, 520, 32 / 9)).toMatchObject({ columns: 1, rows: 2 })
    expect(sideBySide(2, 960, 520, 9 / 16)).toMatchObject({ columns: 2, rows: 1 })
    expect(sideBySide(3, 960, 520, 16 / 9)).toMatchObject({ columns: 2, rows: 2 })
    expect(sideBySide(4, 1200, 700, 16 / 9)).toMatchObject({ columns: 2, rows: 2 })
    expect(sideBySide(2, 960, 520, 16 / 9).tileHeight).toBe(267)
  })
  it('the order, the next share and the focused one', () => {
    expect(shareOrder([5, 2, 9], null)).toEqual([2, 5, 9])
    expect(shareOrder([5, 2, 9], 9)).toEqual([9, 2, 5])
    expect(nextShare([2, 5, 9], 9)).toBe(2)
    expect(nextShare([2, 5, 9], 2, -1)).toBe(9)
    expect(nextShare([2, 5, 9], null)).toBe(2)
    expect(nextShare([], null)).toBeNull()
    expect(focusedShare([2, 5], 5, null)).toBe(5)
    expect(focusedShare([2, 5], 7, 5)).toBe(5)
    expect(focusedShare([2, 5], null, null)).toBe(2)
  })
})

describe('words', () => {
  it('who is sharing', () => {
    expect(sharingLine([])).toBeNull()
    expect(sharingLine(['Ayşe'])).toBe('Ayşe ekran paylaşıyor')
    expect(sharingLine(['Ayşe', 'Mehmet'])).toBe('Ayşe ve Mehmet ekran paylaşıyor')
    expect(sharingLine(['Ayşe', 'Mehmet', 'Sen'])).toBe('Ayşe, Mehmet ve Sen ekran paylaşıyor')
    expect(namesAnd(['A', 'B', 'C', 'D', 'E'])).toBe('A, B +3')
  })
  it('the share button tells that sharing too stops nobody, and the cap', () => {
    expect(shareButtonText({ sharing: false, others: 0, max: 4 }).label).toBe('Ekran paylaş')
    const too = shareButtonText({ sharing: false, others: 1, max: 4 })
    expect(too.label).toBe('Sen de paylaş')
    expect(too.title).toMatch(/aynı anda birden fazla kişi/)
    expect(shareButtonText({ sharing: false, others: 4, max: 4 })).toMatchObject({ full: true, label: 'Ekran paylaşımı dolu (4/4)' })
    expect(shareButtonText({ sharing: false, others: 9, max: null }).full).toBe(false)
    expect(shareButtonText({ sharing: true, others: 3, max: 4 }).label).toBe('Paylaşımı durdur')
    expect(sharesFullMessage(4, ['Ayşe', 'Mehmet', 'Ali', 'Cem'])).toBe(
      'Bu odada aynı anda en çok 4 kişi ekran paylaşabilir. Şu an paylaşanlar: Ayşe, Mehmet +2. Biri durdurunca paylaşabilirsin.',
    )
  })
})

describe('watching keys (the shell’s rules, CONTRACT-V12-MINI-DESKTOP §4)', () => {
  const taken = { ptt: 'Backquote', mute: 'F7', deafen: null }
  it('a chord on the PTT or mute key is refused with the shell’s sentence', () => {
    expect(baseCode('Ctrl+Shift+F9')).toBe('F9')
    expect(watchKeyRefusal({ ...NO_KEYS, toggleMini: 'Ctrl+Backquote' }, 'toggleMini', taken)).toBe(WATCH_REASONS.ptt)
    expect(watchKeyRefusal({ ...NO_KEYS, theatre: 'Ctrl+Shift+F7' }, 'theatre', taken)).toBe(WATCH_REASONS.mute)
    expect(watchKeyRefusal({ ...NO_KEYS, theatre: 'Ctrl+Shift+F8' }, 'theatre', taken)).toBeNull()
  })
  it('one key does one thing: the first action keeps it', () => {
    const keys = { ...NO_KEYS, toggleMini: 'Ctrl+Shift+F9', theatre: 'Ctrl+Shift+F9' }
    expect(watchKeyRefusal(keys, 'toggleMini', taken)).toBeNull()
    expect(watchKeyRefusal(keys, 'theatre', taken)).toBe(WATCH_REASONS.duplicate)
    expect(watchKeyConflict(keys, taken)).toBe(WATCH_REASONS.duplicate)
    expect(effectiveWatchKeys(keys, taken)).toMatchObject({ toggleMini: 'Ctrl+Shift+F9', theatre: null })
  })
})

describe('the mini window seam', () => {
  it('opens exactly the route and name the shell allows', () => {
    expect(miniUrl('share-12')).toBe('/mini.html?m=share-12')
    expect(miniWindowName('share-12')).toBe('trio-mini-share-12')
  })
})
