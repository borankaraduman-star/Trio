/**
 * CONTRACT-V12-MULTISHARE: several people sharing their screens at once.
 * Pure helpers; the engine and the stage use them.
 */
import { formatMbps, type ProfileSettings } from './shareProfiles'

/**
 * How large a viewer shows a share (V12 §3). Told to the sharer inside the V6
 * `watch` signal (`{"watch": {"stream", "on": true, "size"}}`); a sharer that
 * predates it ignores the key and sends full quality, a viewer that predates
 * it never sends one ("full").
 *
 * - `full`: large on the screen (focused, a big grid cell, fullscreen, a
 *   pop-out window): the profile as chosen.
 * - `mid`: a medium grid cell: at most 720 lines, half the bitrate.
 * - `thumb`: a strip thumbnail, behind "+N", or a collapsed stage, or
 *   "Hafif izleme": at most 360 lines, at most 300 kbit/s and 8 frames a
 *   second. Its sound is not touched (the viewer still hears it and is still
 *   counted as watching).
 * - `audio`: "Sadece ses": the picture is not encoded for this viewer at all
 *   (its video encodings inactive), the share's sound still is.
 */
export type ViewSize = 'full' | 'mid' | 'thumb' | 'audio'

/** Largest first: of several places showing one share, the largest wins. */
export const VIEW_SIZES: readonly ViewSize[] = ['full', 'mid', 'thumb', 'audio']

export function isViewSize(value: unknown): value is ViewSize {
  return value === 'full' || value === 'mid' || value === 'thumb' || value === 'audio'
}

/** The larger of two sizes. */
export function largerSize(a: ViewSize, b: ViewSize): ViewSize {
  return VIEW_SIZES.indexOf(a) <= VIEW_SIZES.indexOf(b) ? a : b
}

/** The smaller of two sizes. */
export function smallerSize(a: ViewSize, b: ViewSize): ViewSize {
  return VIEW_SIZES.indexOf(a) >= VIEW_SIZES.indexOf(b) ? a : b
}

/** Device pixels of picture height at and above which a tile is `full`; `mid` from THUMB_MIN_LINES. */
export const FULL_MIN_LINES = 600
export const THUMB_MAX_LINES = 360
export const MID_MAX_LINES = 720
export const THUMB_MAX_BITRATE = 300_000
export const THUMB_MAX_FRAMERATE = 8

/**
 * The size a tile asks for: its picture height in DEVICE pixels (CSS height ×
 * devicePixelRatio). Not shown at all (folded, collapsed) is `thumb`, never
 * "off": not receiving at all stays the viewer's explicit "İzlemeyi bırak".
 */
export function viewSizeFor(cssHeight: number, dpr: number, shown: boolean): ViewSize {
  if (!shown) return 'thumb'
  const lines = cssHeight * Math.max(1, dpr)
  if (lines >= FULL_MIN_LINES) return 'full'
  if (lines >= 250) return 'mid'
  return 'thumb'
}

/**
 * A size change is told only after it held this long: a window being resized
 * or a tile animating would otherwise send a burst of signals (and keyframes).
 */
export const VIEW_SIZE_SETTLE_MS = 700

export interface SizedEncoding {
  maxBitrate: number
  maxFramerate: number
  scaleResolutionDownBy: number
}

/**
 * One viewer's encoding of my screen: the profile, then the size the viewer
 * shows it at. `sourceHeight` is the captured track's height (0 = unknown:
 * no scaling). Never scales up; never above the profile's own rate.
 */
export function sizedEncoding(settings: ProfileSettings, size: ViewSize, sourceHeight: number): SizedEncoding {
  const scaleTo = (lines: number) => (sourceHeight > lines ? Math.round((sourceHeight / lines) * 100) / 100 : 1)
  switch (size) {
    case 'full':
      return { maxBitrate: settings.maxBitrate, maxFramerate: settings.maxFramerate, scaleResolutionDownBy: 1 }
    case 'mid':
      return {
        maxBitrate: Math.round(settings.maxBitrate / 2),
        maxFramerate: settings.maxFramerate,
        scaleResolutionDownBy: scaleTo(MID_MAX_LINES),
      }
    case 'audio':
    case 'thumb':
      return {
        maxBitrate: Math.min(settings.maxBitrate, THUMB_MAX_BITRATE),
        maxFramerate: Math.min(settings.maxFramerate, THUMB_MAX_FRAMERATE),
        scaleResolutionDownBy: scaleTo(THUMB_MAX_LINES),
      }
  }
}

export const SIZE_LABELS: Record<ViewSize, string> = { full: 'büyük', mid: 'orta', thumb: 'küçük', audio: 'sadece ses' }

/**
 * What the sharer's menu says it sends (V12 §3): "3 izleyici ≈ 3,9 Mbps:
 * Ayşe büyük, Mehmet küçük, Zeynep orta". `rates` is each watching viewer's
 * max bitrate as written.
 */
export function sendingText(viewers: readonly { name: string; size: ViewSize; maxBitrate: number }[]): string {
  if (viewers.length === 0) return 'Şu an kimse izlemiyor: yükleme yok.'
  const total = viewers.reduce((sum, v) => sum + (v.size === 'audio' ? 0 : v.maxBitrate), 0)
  return `${viewers.length} izleyici ≈ en çok ${formatMbps(total)}: ${viewers.map((v) => `${v.name} ${SIZE_LABELS[v.size]}`).join(', ')}`
}

/** "Ayşe", "Ayşe ve Mehmet", "Ayşe, Mehmet ve Zeynep", "Ayşe, Mehmet +2" */
export function namesAnd(names: readonly string[]): string {
  if (names.length <= 1) return names.join('')
  if (names.length <= 3) return `${names.slice(0, -1).join(', ')} ve ${names[names.length - 1]}`
  return `${names.slice(0, 2).join(', ')} +${names.length - 2}`
}

/** "Ayşe ve Mehmet ekran paylaşıyor" (null when nobody shares). */
export function sharingLine(names: readonly string[]): string | null {
  if (names.length === 0) return null
  return `${namesAnd(names)} ekran paylaşıyor`
}

/**
 * The share button's words (V12 §5). `others` = people in my room sharing
 * now (not me); `max` = `ready.screen_shares_max` (null: a server that
 * predates it, no cap known).
 */
export function shareButtonText(input: { sharing: boolean; others: number; max: number | null }): {
  label: string
  title: string
  full: boolean
} {
  if (input.sharing) return { label: 'Paylaşımı durdur', title: 'Paylaşımı durdur', full: false }
  const full = input.max !== null && input.others >= input.max
  if (full) {
    return {
      label: `Ekran paylaşımı dolu (${input.others}/${input.max})`,
      title: `Bu odada aynı anda en çok ${input.max} kişi ekran paylaşabilir.`,
      full: true,
    }
  }
  if (input.others > 0) {
    return {
      label: 'Sen de paylaş',
      title: 'Sen de paylaş: aynı anda birden fazla kişi ekran paylaşabilir, kimsenin paylaşımı durmaz.',
      full: false,
    }
  }
  return { label: 'Ekran paylaş', title: 'Ekran paylaş', full: false }
}

export function sharesFullMessage(max: number, names: readonly string[]): string {
  const who = names.length > 0 ? ` Şu an paylaşanlar: ${namesAnd(names)}.` : ''
  return `Bu odada aynı anda en çok ${max} kişi ekran paylaşabilir.${who} Biri durdurunca paylaşabilirsin.`
}

// --- the stage's layout, per device -----------------------------------------------

export type StageMode = 'side' | 'focus'

const LAYOUT_KEY = 'trio.v12.stageLayout'
const TIP_KEY = 'trio.v12.multishareTip'

export function loadStageMode(): StageMode {
  try {
    return localStorage.getItem(LAYOUT_KEY) === 'focus' ? 'focus' : 'side'
  } catch {
    return 'side'
  }
}

export function saveStageMode(mode: StageMode): void {
  try {
    if (mode === 'focus') localStorage.setItem(LAYOUT_KEY, 'focus')
    else localStorage.removeItem(LAYOUT_KEY)
  } catch {
    // Private mode: not remembered.
  }
}

export function tipSeen(): boolean {
  try {
    return localStorage.getItem(TIP_KEY) === '1'
  } catch {
    return true
  }
}

export function markTipSeen(): void {
  try {
    localStorage.setItem(TIP_KEY, '1')
  } catch {
    // Not remembered.
  }
}

/**
 * Columns × rows for `count` screens side by side in a box of `width` ×
 * `height` CSS px, each of aspect `aspect` (width / height of the pictures,
 * their average): the arrangement whose tiles are largest. 2 screens on a
 * wide stage are two columns; 2 portrait ones too; 2 ultrawide ones stack.
 */
export function sideBySide(count: number, width: number, height: number, aspect: number): { columns: number; rows: number } {
  let best = { columns: 1, rows: Math.max(1, count), area: 0 }
  const ratio = aspect > 0 ? aspect : 16 / 9
  for (let columns = 1; columns <= Math.max(1, count); columns += 1) {
    const rows = Math.ceil(count / columns)
    const cellW = width / columns
    const cellH = height / rows
    const tileW = Math.min(cellW, cellH * ratio)
    const area = tileW * (tileW / ratio)
    if (area > best.area + 0.5) best = { columns, rows, area }
  }
  return { columns: best.columns, rows: best.rows }
}
