/**
 * The identity endpoints (CONTRACT-V4 C) and `/api/health` (A2). Kept out of
 * api.ts, whose `request` only speaks JSON; the errors are the same ApiError.
 */
import { ApiError } from '../api'
import type { ServerProfile, User } from '../types'
import { parseRetryAfter } from './retryAfter'

async function call<T>(path: string, init: { method: string; token?: string; json?: unknown; file?: { blob: Blob; name: string } }): Promise<T> {
  const headers: Record<string, string> = {}
  if (init.token) headers['Authorization'] = `Bearer ${init.token}`
  let body: BodyInit | undefined
  if (init.json !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(init.json)
  } else if (init.file) {
    const form = new FormData()
    form.append('file', init.file.blob, init.file.name)
    body = form
  }
  let response: Response
  try {
    response = await fetch(path, { method: init.method, headers, body, cache: 'no-store' })
  } catch {
    throw new ApiError(0, 'NETWORK', 'network error')
  }
  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    // Handled by status below.
  }
  if (!response.ok) {
    const error = (payload as { error?: { code?: unknown; message?: unknown } } | null)?.error
    throw new ApiError(
      response.status,
      typeof error?.code === 'string' ? error.code : response.status === 413 ? 'FILE_TOO_LARGE' : 'UNKNOWN',
      typeof error?.message === 'string' ? error.message : `HTTP ${response.status}`,
      parseRetryAfter(response.headers.get('Retry-After'), Date.now()),
    )
  }
  if (payload === null) throw new ApiError(response.status, 'BAD_RESPONSE', 'bad response')
  return payload as T
}

export const profileApi = {
  rename(token: string, name: string): Promise<{ user: User }> {
    return call('/api/me', { method: 'PATCH', token, json: { name } })
  },
  setAvatar(token: string, blob: Blob, ext: string): Promise<{ user: User }> {
    return call('/api/me/avatar', { method: 'PUT', token, file: { blob, name: `avatar.${ext}` } })
  },
  removeAvatar(token: string): Promise<{ user: User }> {
    return call('/api/me/avatar', { method: 'DELETE', token })
  },
  renameServer(token: string, name: string): Promise<{ server: ServerProfile }> {
    return call('/api/server', { method: 'PATCH', token, json: { name } })
  },
  setServerIcon(token: string, blob: Blob, ext: string): Promise<{ server: ServerProfile }> {
    return call('/api/server/icon', { method: 'PUT', token, file: { blob, name: `icon.${ext}` } })
  },
  removeServerIcon(token: string): Promise<{ server: ServerProfile }> {
    return call('/api/server/icon', { method: 'DELETE', token })
  },
}

/** Turkish for a refused profile change (names worded exactly as on the join screen). */
export function profileErrorMessage(error: unknown, kind: 'name' | 'image'): string {
  if (!(error instanceof ApiError)) {
    return kind === 'image' ? 'Görüntü hazırlanamadı.' : 'Değişiklik kaydedilemedi.'
  }
  switch (error.code) {
    case 'NAME_TAKEN':
      return 'Bu isim alınmış, başka bir isim dene.'
    case 'INVALID_NAME':
      return 'İsim 1–32 karakter olmalı.'
    case 'INVALID_IMAGE':
      return 'Bu dosya kullanılabilir bir görüntü değil (PNG, JPEG ya da WebP, en fazla 512 piksel).'
    case 'FILE_TOO_LARGE':
      return 'Görüntü çok büyük (en fazla 2 MB).'
    case 'INVALID_UPLOAD':
      return 'Görüntü gönderilemedi, tekrar dene.'
    case 'STORAGE_FULL':
      return 'Sunucunun diski dolu; değişiklik kaydedilemedi.'
    case 'RATE_LIMITED': {
      const wait = error.retryAfter !== null && error.retryAfter > 0 ? ` ${error.retryAfter} saniye sonra` : ' biraz sonra'
      return `Profilde dakikada en fazla 10 değişiklik yapılabilir;${wait} tekrar dene.`
    }
  }
  if (error.status === 0 || error.status >= 500) return 'Sunucuya ulaşılamadı.'
  return kind === 'image' ? 'Görüntü kaydedilemedi.' : 'Değişiklik kaydedilemedi.'
}
