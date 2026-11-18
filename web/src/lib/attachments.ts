/** Pure helpers for attachments: how to render one, how big it is, what may be added. */

export type AttachmentKind = 'image' | 'video' | 'audio' | 'file'

/** Exactly the types the server serves inline (CONTRACT-V2 §2); svg and html are NOT here. */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm'])
const AUDIO_TYPES = new Set(['audio/mpeg', 'audio/ogg', 'audio/wav'])

/** Default server limit (`TRIO_MAX_UPLOAD_MB`). The server still decides; this only saves a doomed upload. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
export const MAX_ATTACHMENTS = 10

/** Decides how an attachment is shown from its SERVER-decided content type. Anything unknown is a file row. */
export function attachmentKind(contentType: string): AttachmentKind {
  const type = contentType.split(';')[0].trim().toLowerCase()
  if (IMAGE_TYPES.has(type)) return 'image'
  if (VIDEO_TYPES.has(type)) return 'video'
  if (AUDIO_TYPES.has(type)) return 'audio'
  return 'file'
}

const UNITS = ['KB', 'MB', 'GB'] as const

/** "512 B", "1,5 KB", "12 MB", "1,2 GB" — Turkish decimal comma, 1024 steps. */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '?'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }
  // One decimal below 10, none above: "9,8 MB", "25 MB", "120 MB".
  const rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value)
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1).replace('.', ',')
  return `${text} ${UNITS[unit]}`
}

/** A Turkish sentence when a file cannot be uploaded at all, else null. */
export function fileProblem(file: { name: string; size: number }, maxBytes = MAX_UPLOAD_BYTES): string | null {
  if (file.size === 0) return `“${file.name}” boş bir dosya, gönderilemez.`
  if (file.size > maxBytes) {
    return `“${file.name}” çok büyük (${formatSize(file.size)}). En fazla ${formatSize(maxBytes)} yüklenebilir.`
  }
  return null
}

/** Upload error codes from the server, in Turkish. */
export function uploadErrorMessage(code: string): string {
  switch (code) {
    case 'FILE_TOO_LARGE':
      return `Dosya çok büyük. En fazla ${formatSize(MAX_UPLOAD_BYTES)} yüklenebilir.`
    case 'INVALID_UPLOAD':
      return 'Dosya yüklenemedi (boş ya da geçersiz).'
    case 'QUOTA_EXCEEDED':
      // A lifetime figure: files cannot be deleted, so only the admin can make room.
      return 'Yükleme kotan doldu; bu dosya sığmıyor. Kota yüklediğin tüm dosyaların toplamıdır, sunucuyu yöneten kişi artırabilir.'
    case 'UPLOAD_IN_PROGRESS':
      return 'Başka bir sekmede ya da cihazda yükleme sürüyor. O bitince bu dosyayı yeniden ekle.'
    case 'STORAGE_FULL':
      return 'Sunucunun diski dolu, dosya kaydedilemedi. Sunucuyu yöneten kişiye haber ver.'
    case 'UNAUTHORIZED':
      return 'Oturum geçersiz. Yeniden giriş yap.'
    case 'NETWORK':
      return 'Bağlantı hatası, dosya yüklenemedi.'
    default:
      return 'Dosya yüklenemedi.'
  }
}

/** A clipboard image has no useful name ("image.png"); give it one with a timestamp. */
export function pastedFileName(type: string, now: Date): string {
  const ext = type === 'image/jpeg' ? 'jpg' : (type.split('/')[1] ?? 'bin').replace(/[^a-z0-9]/gi, '') || 'bin'
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `yapistirilan-${stamp}.${ext}`
}
