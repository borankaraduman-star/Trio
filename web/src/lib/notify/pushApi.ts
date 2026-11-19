/** REST of CONTRACT-V6-PUSH §2-§3. */
import { request } from '../../api'
import type { QuietHours } from './quietHours'

export type Level = 'all' | 'mentions' | 'none'

export interface PushPrefs {
  /** Channel id -> level; absent = 'all'. */
  channels: Record<string, Level>
  quiet: QuietHours
  /** "X ses odasına girdi". */
  voice_rooms: boolean
  /** Rings ("Çağrılar"). */
  calls: boolean
  /** A ring during quiet hours still notifies. */
  calls_break_quiet: boolean
}

export interface PushDevice {
  id: number
  label: string
  ua_family: string
  created_at: string
  last_ok_at: string | null
  last_error: string | null
}

export interface TestResult {
  ok: boolean
  status: number | null
  error: string | null
  removed: boolean
}

export type PrefsPatch = Partial<Omit<PushPrefs, 'channels' | 'quiet'>> & {
  channels?: Record<string, Level | null>
  quiet?: Partial<QuietHours>
}

export const pushApi = {
  key: (token: string) => request<{ public_key: string }>('/api/push/key', { token }),
  devices: (token: string) => request<{ subscriptions: PushDevice[] }>('/api/push/subscriptions', { token }),
  subscribe: (
    token: string,
    body: { endpoint: string; keys: { p256dh: string; auth: string }; ua_family: string; label: string },
  ) => request<{ subscription: PushDevice }>('/api/push/subscriptions', { token, method: 'PUT', body }),
  remove: (token: string, id: number) =>
    request<void>(`/api/push/subscriptions/${id}`, { token, method: 'DELETE', empty: true }),
  test: (token: string, id: number) =>
    request<TestResult>('/api/push/test', { token, method: 'POST', body: { subscription_id: id } }),
  prefs: (token: string) => request<{ prefs: PushPrefs }>('/api/push/prefs', { token }),
  savePrefs: (token: string, patch: PrefsPatch) =>
    request<{ prefs: PushPrefs }>('/api/push/prefs', { token, method: 'PUT', body: patch }),
}
