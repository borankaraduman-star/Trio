export interface User {
  id: number
  name: string
}

export interface Member extends User {
  online: boolean
}

export type ChannelKind = 'text' | 'voice'

export interface Channel {
  id: number
  name: string
  kind: ChannelKind
}

export interface Message {
  id: number
  channel_id: number
  author: User
  content: string
  created_at: string
}

export interface VoiceParticipant {
  user_id: number
  muted: boolean
  deafened: boolean
  screensharing: boolean
}

export type SignalData =
  | { description: RTCSessionDescriptionInit }
  | { candidate: RTCIceCandidateInit | null }
  /** Client-to-client turn-taking for offers (see voice.ts); the server relays it unread. */
  | { negotiate: 'request' | 'grant' }

export type ServerEvent =
  | {
      type: 'ready'
      user: User
      users: Member[]
      channels: Channel[]
      voice: Record<string, VoiceParticipant[]>
    }
  | { type: 'presence'; user_id: number; online: boolean }
  | { type: 'user.joined'; user: User }
  | { type: 'channel.new'; channel: Channel }
  | { type: 'message.new'; message: Message; nonce?: string }
  | { type: 'typing'; channel_id: number; user_id: number }
  | { type: 'voice.peers'; channel_id: number; peers: number[] }
  | ({ type: 'voice.joined'; channel_id: number } & VoiceParticipant)
  | { type: 'voice.left'; channel_id: number; user_id: number }
  | ({ type: 'voice.state'; channel_id: number } & VoiceParticipant)
  | { type: 'signal'; from: number; data: unknown }
  | { type: 'pong' }
  | { type: 'error'; code: string; message: string }

export type ClientEvent =
  | { type: 'message.send'; channel_id: number; content: string; nonce: string }
  | { type: 'typing'; channel_id: number }
  | { type: 'voice.join'; channel_id: number; muted?: boolean; deafened?: boolean }
  | { type: 'voice.leave' }
  | { type: 'voice.state'; muted: boolean; deafened: boolean; screensharing: boolean }
  | { type: 'signal'; to: number; data: SignalData }
  | { type: 'ping' }
