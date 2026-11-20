/**
 * CONTRACT-V10-GROUPS §4: the owner's Yönetim with ten or fifteen people:
 * finding somebody in the list, and the quota arithmetic said honestly.
 */
import { formatSize } from './attachments'
import { fold } from './notify/mentions'

export type OwnerSort = 'joined' | 'name' | 'seen' | 'storage'

export const OWNER_SORTS: { id: OwnerSort; label: string }[] = [
  { id: 'joined', label: 'Katılma sırası' },
  { id: 'name', label: 'Ad' },
  { id: 'seen', label: 'Son görülme' },
  { id: 'storage', label: 'Depolama' },
]

/** The search box appears from this many active people on. */
export const OWNER_SEARCH_FROM = 8

interface Row {
  id: number
  name: string
  online: boolean
  last_seen_at: string | null
  stored_bytes: number
}

function key(text: string): string {
  return fold(text).folded.join('')
}

/** The owner's list, filtered by a query (folded like names) and sorted. */
export function ownerRows<T extends Row>(users: readonly T[], query: string, sort: OwnerSort): T[] {
  const q = key(query.trim())
  const found = q === '' ? [...users] : users.filter((user) => key(user.name).includes(q))
  const seen = (user: Row) => (user.online ? Number.POSITIVE_INFINITY : user.last_seen_at ? Date.parse(user.last_seen_at) : -1)
  switch (sort) {
    case 'name':
      return found.sort((a, b) => a.name.localeCompare(b.name, 'tr'))
    case 'seen':
      return found.sort((a, b) => seen(b) - seen(a) || a.id - b.id)
    case 'storage':
      return found.sort((a, b) => b.stored_bytes - a.stored_bytes || a.id - b.id)
    default:
      return found.sort((a, b) => a.id - b.id)
  }
}

/**
 * The quota promise against the disk: what everybody could still upload
 * (each person's quota minus what they stored) against the free space above
 * the reserve. Null when it fits. Uploads beyond the disk are refused with
 * "disk dolu" (507) whatever the quota says, so this is the sentence that
 * tells the owner before people meet it.
 */
export function quotaShortfall(
  users: readonly { stored_bytes: number }[],
  storage: { user_quota_bytes: number; disk_free_bytes: number; disk_reserve_bytes: number },
): { promised: number; room: number } | null {
  const promised = users.reduce((sum, user) => sum + Math.max(0, storage.user_quota_bytes - user.stored_bytes), 0)
  const room = Math.max(0, storage.disk_free_bytes - storage.disk_reserve_bytes)
  return promised > room ? { promised, room } : null
}

export function quotaLine(count: number, storage: { user_quota_bytes: number }): string {
  return `${count} kişi × ${formatSize(storage.user_quota_bytes)} kota = en çok ${formatSize(count * storage.user_quota_bytes)}`
}

export function shortfallLine(shortfall: { promised: number; room: number }): string {
  return `Herkes kotasını doldurursa disk yetmez: kalan kotalar toplam ${formatSize(shortfall.promised)}, diskte ayrılan pay dışında ${formatSize(shortfall.room)} boş. Disk dolunca yeni yüklemeler “disk dolu” ile reddedilir; TRIO_USER_QUOTA_MB değerini düşür ya da diski büyüt.`
}
