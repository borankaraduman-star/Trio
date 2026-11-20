/**
 * CONTRACT-V11-ADDRESS: the server's canonical address and moving a device to it.
 *
 * Every request here goes to THIS page's own origin: the old page asks its
 * origin for a move code, the new page redeems it on its own. Nothing is
 * ever fetched across the two origins, and the token never leaves its origin.
 */
import { ApiError, request } from '../api'
import type { User } from '../types'

// --- the canonical address (GET /api/health's public_url) --------------------

export interface AddressState {
  /** null: not known yet; '' : the server declares none; else an origin. */
  publicUrl: string | null
  /** §8: the address the server will have soon (TRIO_NEXT_URL); '' none, null unknown. */
  nextUrl?: string | null
}

type Listener = () => void
let state: AddressState = { publicUrl: null }
const listeners = new Set<Listener>()
let started = false

/** A plain origin, or null when the value cannot be one. */
export function cleanOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 300) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null
    return url.origin
  } catch {
    return null
  }
}

export async function fetchAddress(): Promise<AddressState> {
  try {
    const response = await fetch('/api/health', { cache: 'no-store' })
    if (response.ok) {
      const body = (await response.json()) as { public_url?: unknown; next_url?: unknown }
      state = { publicUrl: cleanOrigin(body.public_url) ?? '', nextUrl: cleanOrigin(body.next_url) ?? '' }
      for (const listener of listeners) listener()
    }
  } catch {
    // Offline: keep what we knew.
  }
  return state
}

export const addressStore = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener)
    if (!started) {
      started = true
      void fetchAddress()
    }
    return () => listeners.delete(listener)
  },
  getSnapshot(): AddressState {
    return state
  },
}

/** Tests only. */
export function setAddressForTest(next: AddressState): void {
  state = next
  for (const listener of listeners) listener()
}

/** §8: an address is announced and this page is not on it yet. */
export function nextPending(current: string = window.location.origin, known: AddressState = state): boolean {
  return Boolean(known.nextUrl) && known.nextUrl !== current
}

/** Where links should point: the canonical address when declared, else this page's origin. */
export function linkOrigin(current: string = window.location.origin, known: AddressState = state): string {
  return known.publicUrl ? known.publicUrl : current
}

/** True only when the server declares an address and this page is not on it. */
export function offCanonical(current: string = window.location.origin, known: AddressState = state): boolean {
  return Boolean(known.publicUrl) && known.publicUrl !== current
}

export function hostOf(origin: string): string {
  try {
    return new URL(origin).host
  } catch {
    return origin
  }
}

// --- the fragment (#tasi=<code>) ---------------------------------------------

const MOVE_KEY = 'tasi'
const CODE = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{10}$/

export function normalizeMoveCode(raw: string): string | null {
  const code = raw.replace(/[\s-]/g, '').toUpperCase()
  return CODE.test(code) ? code : null
}

export function parseMoveFragment(hash: string): string | null {
  const text = hash.startsWith('#') ? hash.slice(1) : hash
  if (text === '') return null
  const value = new URLSearchParams(text).get(MOVE_KEY)
  return value === null ? null : normalizeMoveCode(value)
}

export function hashWithoutMove(hash: string): string {
  const text = hash.startsWith('#') ? hash.slice(1) : hash
  const params = new URLSearchParams(text)
  params.delete(MOVE_KEY)
  const rest = params.toString()
  return rest === '' ? '' : `#${rest}`
}

let taken: { code: string | null } | null = null

/** Read once per page load, removed from the address bar (and the history) at once. */
export function takeMoveCodeFromLocation(): string | null {
  if (taken) return taken.code
  let code: string | null = null
  try {
    const { hash, pathname, search } = window.location
    const text = hash.startsWith('#') ? hash.slice(1) : hash
    if (text !== '' && new URLSearchParams(text).has(MOVE_KEY)) {
      code = parseMoveFragment(hash)
      window.history.replaceState(window.history.state, '', `${pathname}${search}${hashWithoutMove(hash)}`)
    }
  } catch {
    code = null
  }
  taken = { code }
  return code
}

/** The canonical address, with an invite or device code this page was opened with carried along. */
export function forwardUrl(publicUrl: string, invite: string | null, deviceCode: string | null): string {
  const params = new URLSearchParams()
  if (invite) params.set('davet', invite)
  if (deviceCode) params.set('cihaz', deviceCode)
  const rest = params.toString()
  return `${publicUrl}/${rest ? `#${rest}` : ''}`
}

// --- preferences that move (§3's allowlist; the server checks it again) -------

export const MOVE_PREF_KEYS = [
  'trio.settings',
  'trio.voice6',
  'trio.music8',
  'trio.channel',
  'trio.lastName',
  'trio.seenVersion',
  'trio.invite',
  'trio.v7.stageCollapsed',
  'trio.v10.membersHidden',
  'trio.v10.showChannel',
  'trio.sendOriginal',
  'trio.gameShare',
  'trio.recentEmoji',
  'trio.desktopUpdateDismissed',
  'trio.desktopUpdateLater',
  'trio.desktopUpdateHint',
  'trio.lastRead',
  'trio.drafts',
  'trio.v11.listen',
  'trio.v11.listenAck',
  'trio.v11.listenBrowsers',
  'trio.v12.stageLayout',
  'trio.v12.watch',
  'trio.v12.multishareTip',
  'trio.duck12',
] as const

const PREF_VALUE_MAX = 32 * 1024
const PREFS_TOTAL_MAX = 64 * 1024

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export function collectMovePrefs(storage: Store): Record<string, string> {
  const out: Record<string, string> = {}
  let total = 0
  for (const key of MOVE_PREF_KEYS) {
    let value: string | null = null
    try {
      value = storage.getItem(key)
    } catch {
      value = null
    }
    if (value === null) continue
    const size = key.length + new TextEncoder().encode(value).length
    if (size - key.length > PREF_VALUE_MAX || total + size > PREFS_TOTAL_MAX) continue
    out[key] = value
    total += size
  }
  return out
}

/** Writes only allowlisted string values; `onlyMissing` keeps what this origin already has. */
export function applyMovePrefs(storage: Store, prefs: unknown, onlyMissing = false): number {
  if (!prefs || typeof prefs !== 'object') return 0
  let written = 0
  for (const key of MOVE_PREF_KEYS) {
    const value = (prefs as Record<string, unknown>)[key]
    if (typeof value !== 'string') continue
    try {
      if (onlyMissing && storage.getItem(key) !== null) continue
      storage.setItem(key, value)
      written++
    } catch {
      // Storage full or blocked: that preference starts fresh here.
    }
  }
  return written
}

/** Back on the old origin after a completed move: what moved is not kept twice. */
export function forgetMovedPrefs(storage: Store): void {
  for (const key of MOVE_PREF_KEYS) {
    try {
      storage.removeItem(key)
    } catch {
      // Nothing to clear.
    }
  }
}

// --- what the old origin remembers ------------------------------------------------

/** Set on the old origin when the person tapped "Bu cihazı taşı": where they went. */
export const MOVED_TO_KEY = 'trio.movedTo'
/** Set on the new origin until the old session has been ended (§3, confirm). */
export const MOVE_CONFIRM_KEY = 'trio.moveConfirm'

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // A convenience only.
  }
}

export const loadMovedTo = (): string | null => cleanOrigin(read(MOVED_TO_KEY))
export const saveMovedTo = (origin: string | null): void => write(MOVED_TO_KEY, origin)

// --- the API -----------------------------------------------------------------------

export interface MoveCode {
  code: string
  expiresAt: string
  publicUrl: string
  url: string
}

export interface MovePeek {
  user: User
  expiresAt: string
}

export const moveApi = {
  async create(token: string, prefs: Record<string, string>): Promise<MoveCode> {
    const body = await request<{ code?: unknown; expires_at?: unknown; public_url?: unknown; url?: unknown }>(
      '/api/move',
      { method: 'POST', token, body: { prefs } },
    )
    const publicUrl = cleanOrigin(body.public_url)
    if (typeof body.code !== 'string' || typeof body.expires_at !== 'string' || !publicUrl) {
      throw new ApiError(201, 'BAD_RESPONSE', 'bad response')
    }
    // The address we go to is the server's own answer, rebuilt here: never anything else.
    return { code: body.code, expiresAt: body.expires_at, publicUrl, url: `${publicUrl}/#tasi=${body.code}` }
  },
  /** §8: a 7-day code for the announced address (TRIO_NEXT_URL). */
  async createNext(token: string, prefs: Record<string, string>): Promise<MoveCode> {
    const body = await request<{ code?: unknown; expires_at?: unknown; next_url?: unknown }>('/api/move/next', {
      method: 'POST',
      token,
      body: { prefs },
    })
    const nextUrl = cleanOrigin(body.next_url)
    if (typeof body.code !== 'string' || typeof body.expires_at !== 'string' || !nextUrl) {
      throw new ApiError(201, 'BAD_RESPONSE', 'bad response')
    }
    return { code: body.code, expiresAt: body.expires_at, publicUrl: nextUrl, url: `${nextUrl}/#tasi=${body.code}` }
  },
  async peek(code: string): Promise<MovePeek> {
    const body = await request<{ user: User; expires_at: string }>('/api/move/peek', {
      method: 'POST',
      body: { code },
    })
    return { user: body.user, expiresAt: body.expires_at }
  },
  adopt(token: string, code: string): Promise<{ user: User; prefs: Record<string, string>; ended: number }> {
    return request('/api/move/adopt', { method: 'POST', token, body: { code } })
  },
  confirm(token: string): Promise<{ ended: number }> {
    return request('/api/move/confirm', { method: 'POST', token, body: {} })
  },
}

/** After a move was redeemed: the old session ends; retried on the next load if it fails. */
export async function confirmMove(token: string): Promise<void> {
  write(MOVE_CONFIRM_KEY, '1')
  try {
    await moveApi.confirm(token)
    write(MOVE_CONFIRM_KEY, null)
  } catch (error) {
    // 401: this session is gone itself; nothing left to confirm.
    if (error instanceof ApiError && error.status === 401) write(MOVE_CONFIRM_KEY, null)
  }
}

export function confirmPending(): boolean {
  return read(MOVE_CONFIRM_KEY) === '1'
}

/** The join result of a move code (`POST /api/join` answered with `move`): prefs land here. */
export function finishRedeemedMove(token: string, move: unknown): void {
  if (!move || typeof move !== 'object') return
  applyMovePrefs(localStorage, (move as { prefs?: unknown }).prefs)
  void confirmMove(token)
}

// --- recovery (§6) -------------------------------------------------------------------

export const RECOVERY_MIN_LENGTH = 24

/** What the one "Zaten hesabım var" field holds: longer than a device code = a recovery code. */
export function looksLikeRecovery(raw: string): boolean {
  return raw.replace(/[\s-]/g, '').length > 10
}

export function recover(code: string): Promise<{ token: string; user: User }> {
  return request('/api/join', { method: 'POST', body: { recovery_code: code } })
}

export const RECOVERY_ERRORS: Record<string, string> = {
  INVALID_RECOVERY_CODE: 'Kurtarma kodu yanlış (ya da bu sunucuda kurtarma kodu ayarlı değil).',
  RECOVERY_LIMIT: 'Kurtarma kodu bu açılışta çok kullanıldı. Sunucuyu yeniden başlatıp tekrar dene.',
  NO_OWNER: 'Bu sunucunun sahibi yok: TRIO_OWNER kimsenin adı değil.',
  RATE_LIMITED: 'Çok fazla deneme yapıldı. Biraz sonra tekrar dene.',
  NETWORK: 'Sunucuya ulaşılamadı.',
}

export const MOVE_ERRORS: Record<string, string> = {
  INVALID_MOVE_CODE:
    'Bu taşıma bağlantısı artık geçerli değil: süresi dolmuş ya da kullanılmış. Eski adreste “Bu cihazı taşı”ya yeniden bas.',
  NOT_CANONICAL: 'Bu bağlantı sunucunun yeni adresinde açılmalı.',
  OTHER_ACCOUNT: 'Bu taşıma bağlantısı başka bir hesaba ait.',
  NO_PUBLIC_URL: 'Sunucunun yeni bir adresi yok.',
  NO_NEXT_URL: 'Sunucu yeni bir adres duyurmadı.',
  ALREADY_HERE: 'Zaten yeni adrestesin.',
  RATE_LIMITED: 'Çok fazla deneme yapıldı. Biraz sonra tekrar dene.',
  NETWORK: 'Sunucuya ulaşılamadı.',
}

export function errorText(table: Record<string, string>, error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status >= 500 || error.status === 0) return table.NETWORK ?? 'Sunucuya ulaşılamadı.'
    return table[error.code] ?? 'Olmadı, tekrar dene.'
  }
  return 'Olmadı, tekrar dene.'
}
