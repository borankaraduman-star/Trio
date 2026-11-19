/** v4: REST for the message family (CONTRACT-V4 B). */
import { request } from './api'
import { reactionPath } from './lib/emojiKey'
import type { Message } from './types'

export const messageApi = {
  edit(token: string, messageId: number, content: string): Promise<{ message: Message }> {
    return request(`/api/messages/${messageId}`, { method: 'PATCH', token, body: { content } })
  },
  remove(token: string, messageId: number): Promise<void> {
    return request(`/api/messages/${messageId}`, { method: 'DELETE', token, empty: true })
  },
  react(token: string, messageId: number, key: string, on: boolean): Promise<{ message: Message }> {
    return request(`/api/messages/${messageId}/reactions/${reactionPath(key)}`, { method: on ? 'PUT' : 'DELETE', token })
  },
  pin(token: string, messageId: number, on: boolean): Promise<{ message: Message }> {
    return request(`/api/messages/${messageId}/pin`, { method: on ? 'PUT' : 'DELETE', token })
  },
  pins(token: string, channelId: number): Promise<{ messages: Message[] }> {
    return request(`/api/channels/${channelId}/pins`, { token })
  },
}

/** The sentence a refused change of the message family shows (a quiet notice). */
export function familyErrorMessage(code: string, status: number): string {
  switch (code) {
    case 'REACTION_LIMIT':
      return 'Bu mesajda en fazla 20 farklı tepki olabilir.'
    case 'PIN_LIMIT':
      return 'Bu kanalda en fazla 50 sabitlenmiş mesaj olabilir. Önce birini kaldır.'
    case 'RATE_LIMITED':
      return 'Biraz yavaş: çok hızlı değişiklik yapıldı. Bir dakika sonra tekrar dene.'
    case 'INVALID_MESSAGE':
      return 'Mesaj boş olamaz (dosyası yoksa) ve en fazla 4000 karakter olabilir.'
    case 'INVALID_REACTION':
      return 'Bu tepki kullanılamıyor.'
    case 'FORBIDDEN':
      return 'Bunu yalnızca mesajın sahibi yapabilir.'
    case 'NOT_FOUND':
      return 'Bu mesaj artık yok.'
    case 'STORAGE_FULL':
      return 'Sunucunun diski dolu, değişiklik kaydedilemedi.'
    case 'NETWORK':
      return 'Sunucuya ulaşılamadı, değişiklik kaydedilmedi.'
    default:
      return status >= 500 ? 'Sunucu şu an yanıt vermiyor, değişiklik kaydedilmedi.' : 'Değişiklik kaydedilemedi.'
  }
}
