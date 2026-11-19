/**
 * Screen-share profiles (CONTRACT-V6-VOICE §1). Pure: what a profile and a
 * quality mean for the captured track and for each video sender.
 *
 * Nothing here renegotiates. `track.contentHint` and `track.applyConstraints`
 * act on the capture; `RTCRtpSender.setParameters` (max bitrate, max frame
 * rate, degradation preference, `active`) acts on one encoder. None of them
 * changes the session description.
 *
 * In a full mesh every viewer costs its own encode and its own upload, so the
 * bitrate is chosen PER VIEWER and the total upload is that times the viewers.
 */

export type ShareProfile = 'game' | 'text' | 'film'
export type ShareQuality = 'low' | 'mid' | 'high'

export const SHARE_PROFILES: readonly ShareProfile[] = ['game', 'text', 'film']
export const SHARE_QUALITIES: readonly ShareQuality[] = ['low', 'mid', 'high']

export const PROFILE_LABELS: Record<ShareProfile, string> = {
  game: 'Oyun',
  text: 'Metin',
  film: 'Film',
}

export const PROFILE_HINTS: Record<ShareProfile, string> = {
  game: 'Akıcı hareket: 60 kare/sn, çözünürlük gerekirse düşer.',
  text: 'Keskin yazı: tam çözünürlük, 15 kare/sn.',
  film: 'Dengeli: 30 kare/sn.',
}

export const QUALITY_LABELS: Record<ShareQuality, string> = {
  low: 'Düşük',
  mid: 'Orta',
  high: 'Yüksek',
}

/** Bits per second per viewer. */
export const QUALITY_BITRATE: Record<ShareQuality, number> = {
  low: 1_500_000,
  mid: 3_000_000,
  high: 6_000_000,
}

export type DegradationPreference = 'maintain-framerate' | 'maintain-resolution' | 'balanced'

export interface ProfileSettings {
  contentHint: 'motion' | 'detail'
  /** For `track.applyConstraints`: a missing width/height means the source's own (full) size. */
  constraints: { frameRate: number; width?: number; height?: number }
  maxBitrate: number
  maxFramerate: number
  degradationPreference: DegradationPreference
}

/**
 * The table. Oyun caps the resolution by the bitrate chosen (1080p only at
 * Yüksek: 60 fps of 1080p in 3 Mbps is mush); Metin keeps the source's full
 * resolution at a low frame rate; Film is 30 fps, capped at 1080p.
 */
export function profileSettings(profile: ShareProfile, quality: ShareQuality): ProfileSettings {
  const maxBitrate = QUALITY_BITRATE[quality]
  switch (profile) {
    case 'game': {
      const big = quality === 'high'
      return {
        contentHint: 'motion',
        constraints: { frameRate: 60, width: big ? 1920 : 1280, height: big ? 1080 : 720 },
        maxBitrate,
        maxFramerate: 60,
        degradationPreference: 'maintain-framerate',
      }
    }
    case 'text':
      return {
        contentHint: 'detail',
        constraints: { frameRate: 15 },
        maxBitrate,
        maxFramerate: 15,
        degradationPreference: 'maintain-resolution',
      }
    case 'film':
      return {
        contentHint: 'motion',
        constraints: { frameRate: 30, width: 1920, height: 1080 },
        maxBitrate,
        maxFramerate: 30,
        degradationPreference: 'balanced',
      }
  }
}

/** `applyConstraints` input: caps as `max` (a smaller source is never scaled up). */
export function trackConstraints(settings: ProfileSettings): MediaTrackConstraints {
  const { frameRate, width, height } = settings.constraints
  return {
    frameRate: { max: frameRate },
    ...(width !== undefined ? { width: { max: width } } : {}),
    ...(height !== undefined ? { height: { max: height } } : {}),
  }
}

export interface UploadEstimate {
  viewers: number
  perViewer: number
  total: number
}

export function estimateUpload(viewers: number, quality: ShareQuality): UploadEstimate {
  const perViewer = QUALITY_BITRATE[quality]
  const count = Math.max(0, Math.floor(viewers))
  return { viewers: count, perViewer, total: perViewer * count }
}

/** "1,5 Mbps", "6 Mbps" (Turkish decimal comma). */
export function formatMbps(bps: number): string {
  const mbps = Math.round((bps / 1_000_000) * 10) / 10
  return `${String(mbps).replace('.', ',')} Mbps`
}

/** "2 izleyici × 3 Mbps ≈ 6 Mbps" */
export function estimateText(estimate: UploadEstimate): string {
  if (estimate.viewers === 0) return 'Şu an kimse izlemiyor: yükleme yok.'
  return `${estimate.viewers} izleyici × ${formatMbps(estimate.perViewer)} ≈ ${formatMbps(estimate.total)}`
}

/**
 * Whether the measured upload looks too small for the choice. `available` is
 * each watching peer's `availableOutgoingBitrate` (the sender's bandwidth
 * estimate for that path; null when not reported yet). They share one uplink,
 * so the warning fires when any watcher's own path is below the per-viewer
 * rate, or when the estimates together are below the total.
 */
export function uploadWarning(estimate: UploadEstimate, available: readonly (number | null)[]): string | null {
  const known = available.filter((value): value is number => typeof value === 'number' && value > 0)
  if (estimate.viewers === 0 || known.length === 0) return null
  const sum = known.reduce((a, b) => a + b, 0)
  const lowest = Math.min(...known)
  if (lowest < estimate.perViewer || (known.length === estimate.viewers && sum < estimate.total)) {
    return `Ölçülen yükleme (${formatMbps(sum)}) seçilen kaliteye yetmeyebilir; görüntü bulanıklaşabilir ya da takılabilir. Daha düşük bir aktarım seç.`
  }
  return null
}

export function isShareProfile(value: unknown): value is ShareProfile {
  return value === 'game' || value === 'text' || value === 'film'
}

export function isShareQuality(value: unknown): value is ShareQuality {
  return value === 'low' || value === 'mid' || value === 'high'
}
