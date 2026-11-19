/**
 * V6 (CONTRACT-V6-MEDIA §5): an `error` frame that names the `nonce` of a
 * `message.send` fails exactly that row — with two sends in flight, "the last
 * one sent" can be the wrong one. A server from before V6 sends no nonce;
 * Session then falls back to the old rule (the send just made).
 */
import type { ChannelMessages } from '../store'

export function failedSend(
  event: { nonce?: string },
  messages: Readonly<Record<number, ChannelMessages>>,
): { channelId: number; nonce: string } | null {
  const nonce = event.nonce
  if (typeof nonce !== 'string' || nonce === '') return null
  for (const [key, channel] of Object.entries(messages)) {
    if (channel.items.some((item) => item.nonce === nonce && item.status === 'pending')) {
      return { channelId: Number(key), nonce }
    }
  }
  return null
}
