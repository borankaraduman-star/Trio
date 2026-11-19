/** CONTRACT-V7-READING §6: renaming and deleting a channel. */
import { ApiError, request } from '../api'
import type { Channel } from '../types'

export const channelApi = {
  rename(token: string, channelId: number, name: string): Promise<{ channel: Channel }> {
    return request(`/api/channels/${channelId}`, { method: 'PATCH', token, body: { name } })
  },
  remove(token: string, channelId: number, confirmName: string): Promise<void> {
    return request(`/api/channels/${channelId}`, {
      method: 'DELETE',
      token,
      body: { confirm_name: confirmName },
      empty: true,
    })
  },
}

/** A Turkish sentence for a refused rename or delete. */
export function channelErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'INVALID_CHANNEL':
        return 'Kanal adı 1–32 karakter olmalı.'
      case 'CHANNEL_IN_USE':
        return 'Ses kanalında biri varken silinemez.'
      case 'LAST_TEXT_CHANNEL':
        return 'Son metin kanalı silinemez.'
      case 'FORBIDDEN':
        return 'Kanalları yalnızca sunucunun sahibi silebilir.'
      case 'CONFIRM_MISMATCH':
        return 'Yazdığın ad kanalın adıyla aynı değil.'
      case 'NOT_FOUND':
        return 'Bu kanal artık yok.'
      case 'RATE_LIMITED':
        return 'Çok sık değişiklik yapıldı; bir dakika sonra yeniden dene.'
      case 'NETWORK':
        return 'Sunucuya ulaşılamadı.'
    }
  }
  return 'Olmadı, yeniden dene.'
}
