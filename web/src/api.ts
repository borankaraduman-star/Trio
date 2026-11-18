import type { Channel, ChannelKind, Message, User } from './types'

/** A non-2xx answer from the API, or a request that never got one (status 0). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; token?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = {}
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  if (options.token) headers['Authorization'] = `Bearer ${options.token}`

  let response: Response
  try {
    response = await fetch(path, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })
  } catch {
    throw new ApiError(0, 'NETWORK', 'network error')
  }

  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    // An empty or non-JSON body: handled below by status.
  }

  if (!response.ok) {
    const error = (payload as { error?: { code?: unknown; message?: unknown } } | null)?.error
    throw new ApiError(
      response.status,
      typeof error?.code === 'string' ? error.code : 'UNKNOWN',
      typeof error?.message === 'string' ? error.message : `HTTP ${response.status}`,
    )
  }
  if (payload === null) throw new ApiError(response.status, 'BAD_RESPONSE', 'bad response')
  return payload as T
}

export interface JoinResult {
  token: string
  user: User
}

export interface MessagePage {
  messages: Message[]
  has_more: boolean
}

export const api = {
  join(inviteCode: string, name: string): Promise<JoinResult> {
    return request('/api/join', { method: 'POST', body: { invite_code: inviteCode, name } })
  },
  me(token: string): Promise<{ user: User }> {
    return request('/api/me', { token })
  },
  channels(token: string): Promise<{ channels: Channel[] }> {
    return request('/api/channels', { token })
  },
  createChannel(token: string, name: string, kind: ChannelKind): Promise<{ channel: Channel }> {
    return request('/api/channels', { method: 'POST', token, body: { name, kind } })
  },
  messages(
    token: string,
    channelId: number,
    query: { before?: number; limit?: number } = {},
  ): Promise<MessagePage> {
    const params = new URLSearchParams()
    if (query.before !== undefined) params.set('before', String(query.before))
    if (query.limit !== undefined) params.set('limit', String(query.limit))
    const suffix = params.size > 0 ? `?${params}` : ''
    return request(`/api/channels/${channelId}/messages${suffix}`, { token })
  },
  async ice(token: string): Promise<RTCIceServer[]> {
    const result = await request<{ iceServers: RTCIceServer[] }>('/api/ice', { token })
    return Array.isArray(result.iceServers) ? result.iceServers : []
  },
}

const JOIN_ERRORS: Record<string, string> = {
  INVALID_INVITE: 'Davet kodu yanlış.',
  NAME_TAKEN: 'Bu isim alınmış, başka bir isim dene.',
  SERVER_FULL: 'Sunucu dolu, yeni üye alınamıyor.',
  INVALID_NAME: 'İsim 1–32 karakter olmalı.',
  RATE_LIMITED: 'Çok fazla deneme yapıldı. Biraz sonra tekrar dene.',
  NETWORK: 'Sunucuya ulaşılamadı.',
}

export function joinErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    // A proxy with no backend behind it answers 5xx with no error code.
    if (error.status >= 500) return JOIN_ERRORS.NETWORK
    return JOIN_ERRORS[error.code] ?? 'Katılma başarısız oldu.'
  }
  return 'Katılma başarısız oldu.'
}

// --- what the browser remembers -------------------------------------------

const TOKEN_KEY = 'trio.token'
const USER_KEY = 'trio.user'

export interface Auth {
  token: string
  user: User
}

export function loadAuth(): Auth | null {
  try {
    const token = localStorage.getItem(TOKEN_KEY)
    const user = JSON.parse(localStorage.getItem(USER_KEY) ?? 'null') as User | null
    if (token && user && typeof user.id === 'number' && typeof user.name === 'string') {
      return { token, user: { id: user.id, name: user.name } }
    }
  } catch {
    // Unreadable storage is the same as no session.
  }
  return null
}

export function saveAuth(auth: Auth): void {
  try {
    localStorage.setItem(TOKEN_KEY, auth.token)
    localStorage.setItem(USER_KEY, JSON.stringify(auth.user))
  } catch {
    // Private mode: the session lasts until the tab closes.
  }
}

export function clearAuth(): void {
  try {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(USER_KEY)
  } catch {
    // Nothing to clear.
  }
}
