/**
 * The channel's "Medya" panel (CONTRACT-V6-MEDIA §3), the pure part: fetching
 * pages, merging them, grouping by month, and moving through the lightbox.
 */
import { ApiError, request } from '../api'
import type { Attachment, User } from '../types'

export type GalleryTab = 'media' | 'links' | 'files'

export interface GalleryAttachment {
  attachment: Attachment
  message_id: number
  author: User
  created_at: string
}

export interface GalleryLink {
  url: string
  message_id: number
  author: User
  created_at: string
  excerpt: string
}

export interface GalleryPage<T> {
  items: T[]
  has_more: boolean
  next_before: string | null
}

export const PAGE_LIMIT = 60

export function fetchAttachments(
  token: string,
  channelId: number,
  kind: 'media' | 'file',
  before: string | null,
  limit = PAGE_LIMIT,
): Promise<GalleryPage<GalleryAttachment>> {
  const params = new URLSearchParams({ kind, limit: String(limit) })
  if (before) params.set('before', before)
  return request(`/api/channels/${channelId}/attachments?${params}`, { token })
}

export function fetchLinks(token: string, channelId: number, before: string | null, limit = PAGE_LIMIT): Promise<GalleryPage<GalleryLink>> {
  const params = new URLSearchParams({ limit: String(limit) })
  if (before) params.set('before', before)
  return request(`/api/channels/${channelId}/links?${params}`, { token })
}

/** Older pages appended; an item seen twice (a page that overlapped after a change) once. */
export function appendPage<T>(held: readonly T[], page: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set(held.map(key))
  return [...held, ...page.filter((item) => !seen.has(key(item)))]
}

export const attachmentKey = (item: GalleryAttachment): string => item.attachment.id
export const linkKey = (item: GalleryLink): string => `${item.message_id}:${item.url}:${item.created_at}`

const MONTHS = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık']

/** "Kasım 2026", in the viewer's time zone. */
export function monthLabel(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return `${MONTHS[date.getMonth()]} ${date.getFullYear()}`
}

/** Consecutive items of the same month (the list is newest first, so months come in order). */
export function groupByMonth<T extends { created_at: string }>(items: readonly T[]): { label: string; items: T[] }[] {
  const groups: { label: string; items: T[] }[] = []
  for (const item of items) {
    const label = monthLabel(item.created_at)
    const last = groups[groups.length - 1]
    if (last && last.label === label) last.items.push(item)
    else groups.push({ label, items: [item] })
  }
  return groups
}

/** The lightbox's next index: wraps neither way (the ends stop). */
export function step(index: number, delta: number, length: number): number {
  return Math.max(0, Math.min(length - 1, index + delta))
}

/** A horizontal swipe of at least 50 px, more sideways than up or down: +1 (next: swiped left), -1 (previous), 0 (not a swipe). */
export function swipeDirection(dx: number, dy: number): -1 | 0 | 1 {
  if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return 0
  return dx < 0 ? 1 : -1
}

export function galleryErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 0) return 'Bağlantı yok; liste yüklenemedi.'
  return 'Liste yüklenemedi.'
}
