/** REST of CONTRACT-V6-OPS: the owner's routes and everybody's storage. */
import { request } from '../api'
import type { LastBackup, TurnProvider } from '../lib/opsFormat'
import type { User } from '../types'

export interface OwnerUser {
  id: number
  name: string
  created_at: string
  removed: boolean
  is_owner: boolean
  online: boolean
  connections: number
  sessions: number
  last_seen_at: string | null
  stored_bytes: number
  file_count: number
}

export interface Overview {
  users: OwnerUser[]
  counts: { messages: number; channels: number; attachments: number }
  storage: {
    uploads_bytes: number
    upload_files: number
    db_bytes: number
    disk_free_bytes: number
    disk_total_bytes: number
    user_quota_bytes: number
    disk_reserve_bytes: number
    max_upload_bytes: number
  }
  server: { version: string; started_at: string; uptime_seconds: number; python: string; owner_rule: string }
  turn: {
    provider: TurnProvider
    stun: string[]
    last_call: { ok: boolean; at: string; age_seconds: number; detail: string | null } | null
  }
  limits: Record<string, number>
  backup: { last: LastBackup | null; in_progress: { sent: number; total: number } | null }
}

export interface ClientErrorRow {
  id: number
  message: string
  stack: string
  context: string
  browser: string
  versions: string[]
  count: number
  first_at: string
  last_at: string
  user: { id: number; name: string } | null
}

export interface StoredFile {
  id: string
  filename: string
  content_type: string
  size: number
  created_at: string
  url: string
  message: { id: number; channel_id: number; excerpt: string } | null
}

export interface StoragePage {
  used_bytes: number
  quota_bytes: number
  file_count: number
  attachments: StoredFile[]
  has_more: boolean
}

export const opsApi = {
  me(token: string): Promise<{ user: User & { is_owner?: boolean } }> {
    return request('/api/me', { token })
  },
  overview(token: string): Promise<Overview> {
    return request('/api/owner/overview', { token })
  },
  errors(token: string): Promise<{ errors: ClientErrorRow[]; distinct: number; total: number }> {
    return request('/api/owner/errors', { token })
  },
  clearErrors(token: string): Promise<void> {
    return request('/api/owner/errors', { method: 'DELETE', token, empty: true })
  },
  revokeTokens(token: string, userId: number, confirmCode: string): Promise<{ sessions_ended: number }> {
    return request(`/api/owner/users/${userId}/revoke-tokens`, { method: 'POST', token, body: { confirm_code: confirmCode } })
  },
  removeUser(token: string, userId: number, confirmCode: string): Promise<{ sessions_ended: number }> {
    return request(`/api/owner/users/${userId}/remove`, { method: 'POST', token, body: { confirm_code: confirmCode } })
  },
  linkCode(token: string, userId: number, confirmCode: string): Promise<{ code: string; expires_at: string }> {
    return request(`/api/owner/users/${userId}/link-code`, { method: 'POST', token, body: { confirm_code: confirmCode } })
  },
  backupTicket(token: string): Promise<{ ticket: string; expires_at: string; url: string }> {
    return request('/api/owner/backup-tickets', { method: 'POST', token })
  },
  myStorage(token: string, offset = 0, limit = 50): Promise<StoragePage> {
    return request(`/api/me/storage?limit=${limit}&offset=${offset}`, { token })
  },
  deleteAttachment(token: string, id: string): Promise<{ storage: { used_bytes: number; quota_bytes: number; file_count: number } }> {
    return request(`/api/attachments/${encodeURIComponent(id)}`, { method: 'DELETE', token })
  },
}
