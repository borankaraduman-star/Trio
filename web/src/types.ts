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

export interface Attachment {
  id: string
  filename: string
  content_type: string
  size: number
  /** Relative: `/api/files/<id>/<name>`. */
  url: string
}

export interface Message {
  id: number
  channel_id: number
  author: User
  content: string
  created_at: string
  /** Always sent by a v2 server (possibly empty); optional for v1 data. */
  attachments?: Attachment[]
}

export interface VoiceParticipant {
  user_id: number
  muted: boolean
  deafened: boolean
  screensharing: boolean
  /** v2: always sent by the server; missing = false. */
  camera?: boolean
  /**
   * V4 A1: their connection dropped and the server holds their place for a
   * 10 s grace before `voice.left`. Missing (older servers) = false.
   */
  reconnecting?: boolean
}

/** v2: which of a peer's outgoing streams is the camera and which the screen. */
export interface StreamMeta {
  camera: string | null
  screen: string | null
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
  /** v3: the admin removed this account; drop it from the member list, keep its messages. */
  | { type: 'user.removed'; user_id: number }
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
  | {
      type: 'message.send'
      channel_id: number
      content: string
      nonce: string
      attachment_ids?: string[]
    }
  | { type: 'typing'; channel_id: number }
  | {
      type: 'voice.join'
      channel_id: number
      muted?: boolean
      deafened?: boolean
      camera?: boolean
    }
  | { type: 'voice.leave' }
  | {
      type: 'voice.state'
      muted: boolean
      deafened: boolean
      screensharing: boolean
      camera?: boolean
    }
  | { type: 'signal'; to: number; data: SignalData | { meta: StreamMeta } }
  | { type: 'ping' }
