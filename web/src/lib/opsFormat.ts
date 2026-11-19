/** Pure text for the owner page and the storage section (CONTRACT-V6-OPS), in Turkish. */

export interface LastBackup {
  at: string
  counts: { messages: number; attachments: number; users?: number; channels?: number }
  upload_files: number
  bytes: number
}

const DAY_MS = 24 * 60 * 60 * 1000
/** Older than this (or never): the owner's settings button gets a red dot. */
export const BACKUP_STALE_DAYS = 14

/** "14.203": Turkish thousands separator, no ICU needed. */
export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return '?'
  const sign = n < 0 ? '-' : ''
  const digits = String(Math.round(Math.abs(n)))
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.')
}

/** "az önce", "5 dakika önce", "3 saat önce", "3 gün önce". A time in the future reads "az önce". */
export function relativeTime(fromMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - fromMs) / 1000))
  if (seconds < 60) return 'az önce'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} dakika önce`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} saat önce`
  return `${Math.floor(hours / 24)} gün önce`
}

/** "Son yedek: 3 gün önce · 14.203 mesaj, 312 dosya", or that there is none. */
export function lastBackupLine(last: LastBackup | null, nowMs: number): string {
  if (!last) return 'Henüz yedek alınmadı.'
  const at = Date.parse(last.at)
  const when = Number.isFinite(at) ? relativeTime(at, nowMs) : '?'
  return `Son yedek: ${when} · ${formatCount(last.counts.messages)} mesaj, ${formatCount(last.upload_files)} dosya`
}

export function backupStale(last: LastBackup | null, nowMs: number): boolean {
  if (!last) return true
  const at = Date.parse(last.at)
  return !Number.isFinite(at) || nowMs - at > BACKUP_STALE_DAYS * DAY_MS
}

const MB = 1024 * 1024

function megabytes(bytes: number): string {
  const value = bytes / MB
  if (value > 0 && value < 10) return (Math.round(value * 10) / 10).toFixed(1).replace('.', ',').replace(',0', '')
  return String(Math.round(value))
}

/** "412 / 1024 MB" (1 MB = 1024² bytes, like the quota setting). */
export function usageText(usedBytes: number, quotaBytes: number): string {
  return `${megabytes(usedBytes)} / ${megabytes(quotaBytes)} MB`
}

/** 0…1 for a bar. */
export function usageRatio(usedBytes: number, quotaBytes: number): number {
  if (!(quotaBytes > 0) || !(usedBytes > 0)) return 0
  return Math.min(1, usedBytes / quotaBytes)
}

/** "3 gün 4 saat", "5 saat 12 dk", "12 dk", "az önce açıldı" under a minute. */
export function formatUptime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const days = Math.floor(s / 86400)
  const hours = Math.floor((s % 86400) / 3600)
  const minutes = Math.floor((s % 3600) / 60)
  if (days > 0) return `${days} gün ${hours} saat`
  if (hours > 0) return `${hours} saat ${minutes} dk`
  if (minutes > 0) return `${minutes} dk`
  return '1 dakikadan az'
}

export type TurnProvider = 'cloudflare' | 'coturn' | 'none'

export function turnLabel(provider: TurnProvider): string {
  switch (provider) {
    case 'cloudflare':
      return 'Cloudflare TURN'
    case 'coturn':
      return 'coturn (kendi sunucun)'
    default:
      return 'Yok (yalnızca STUN)'
  }
}

/** The owner's per-action error codes, in Turkish. */
export function ownerErrorMessage(code: string, retryAfter: number | null = null): string {
  switch (code) {
    case 'INVALID_CONFIRM_CODE':
      return 'Davet kodu yanlış.'
    case 'RATE_LIMITED':
      return retryAfter
        ? `Çok fazla deneme oldu. ${Math.ceil(retryAfter / 60)} dakika sonra yeniden dene.`
        : 'Çok fazla deneme oldu. Biraz sonra yeniden dene.'
    case 'CANNOT_REMOVE_OWNER':
      return 'Sunucunun sahibi kendini çıkaramaz.'
    case 'TOO_MANY_LINK_CODES':
      return 'Bu kişinin henüz kullanılmamış 5 kodu var; birinin süresi dolsun (en çok 10 dakika).'
    case 'NOT_FOUND':
      return 'Bu kişi artık sunucuda değil.'
    case 'BACKUP_IN_PROGRESS':
      return 'Şu anda başka bir yedek indiriliyor; bitince yeniden dene.'
    case 'FORBIDDEN':
      return 'Bunu yalnızca sunucunun sahibi yapabilir.'
    case 'NETWORK':
      return 'Sunucuya ulaşılamadı.'
    default:
      return 'İşlem yapılamadı.'
  }
}
