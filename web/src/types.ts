export interface User {
  id: number
  name: string
  /** v4: `/api/avatars/<id>/<hash>.<ext>` or null; missing from a server that predates it. */
  avatar_url?: string | null
}

/** v4: the server's own name and icon (`ready.server`, `server.updated`). */
export interface ServerProfile {
  name: string
  /** `/api/server/icon/<hash>.<ext>` or null. */
  icon_url: string | null
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
  /**
   * V6-OPS §4: the uploader deleted the file. Then only `id` and `filename`
   * are real; check `isDeletedAttachment` before using the other fields.
   */
  deleted?: boolean
  // --- V6 (CONTRACT-V6-MEDIA): optional, an older server sends none ---
  /** A small picture of an image for lists (`/api/previews/<id>`), or null. */
  preview_url?: string | null
  /** The original's shown size, or null when the server could not tell. */
  width?: number | null
  height?: number | null
  /** Set when the attachment is a voice message. */
  voice?: VoiceMeta | null
}

/** V6: a voice message's length and 64-bar waveform (0..255 each). */
export interface VoiceMeta {
  duration_ms: number
  waveform: number[]
}

export interface Message {
  id: number
  channel_id: number
  author: User
  content: string
  created_at: string
  /** Always sent by a v2 server (possibly empty); optional for v1 data. */
  attachments?: Attachment[]
  // --- v4 (CONTRACT-V4 B): all optional, a v3 server sends none of them ---
  /** ISO time of the last edit that changed the content, else null. */
  edited_at?: string | null
  reply_to?: ReplyRef | null
  /** Ordered by each key's earliest remaining reaction. */
  reactions?: Reaction[]
  pinned_at?: string | null
  /** The pinner's user id. */
  pinned_by?: number | null
  /** +1 on every change; keep the copy with the highest. */
  rev?: number
}

/** v4: what a reply quotes, resolved by the server when the reply is serialised. */
export type ReplyRef =
  | { id: number; author: { id: number; name: string }; excerpt: string; deleted?: undefined }
  | { id: number; deleted: true }

export interface Reaction {
  key: string
  count: number
  user_ids: number[]
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
  /** V6: away (auto-AFK). Missing (older servers) = false. */
  afk?: boolean
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
      /** v4 (A2): a plain string; compare for equality only. */
      server_version?: string
      /** v4 (C) */
      server?: ServerProfile
    }
  | { type: 'presence'; user_id: number; online: boolean }
  | { type: 'user.joined'; user: User }
  /** v3: the admin removed this account; drop it from the member list, keep its messages. */
  | { type: 'user.removed'; user_id: number }
  /** v4: a rename or an avatar change (the actor's own sockets get it too). */
  | { type: 'user.updated'; user: User }
  /** v4: the server's name or icon changed. */
  | { type: 'server.updated'; server: ServerProfile }
  | { type: 'channel.new'; channel: Channel }
  | { type: 'message.new'; message: Message; nonce?: string }
  /** v4: any later change to a message (edit, reactions, pin). */
  | { type: 'message.updated'; message: Message }
  /** v4: `nonce` only when a retried send names a message deleted meanwhile. */
  | { type: 'message.deleted'; channel_id: number; message_id: number; nonce?: string }
  | { type: 'typing'; channel_id: number; user_id: number }
  | {
      type: 'voice.peers'
      channel_id: number
      peers: number[]
      /** V4 A1: members in their reconnect grace; not to be connected to. */
      reconnecting?: number[]
      /** V4 A1: echoes the join's `resume`. */
      resumed?: boolean
    }
  | ({ type: 'voice.joined'; channel_id: number; resumed?: boolean } & VoiceParticipant)
  | { type: 'voice.left'; channel_id: number; user_id: number }
  | ({ type: 'voice.state'; channel_id: number } & VoiceParticipant)
  | { type: 'signal'; from: number; data: unknown }
  /** V4 A4: somebody in `channel_id` calls me in. */
  | { type: 'voice.ring'; channel_id: number; from: number }
  | { type: 'pong' }
  /** V6: `nonce` when it answers a `message.send` that carried one. */
  | { type: 'error'; code: string; message: string; nonce?: string }

export type ClientEvent =
  | {
      type: 'message.send'
      channel_id: number
      content: string
      nonce: string
      attachment_ids?: string[]
      /** v4: the message this one answers (same channel). */
      reply_to?: number | null
    }
  | { type: 'typing'; channel_id: number }
  | {
      type: 'voice.join'
      channel_id: number
      muted?: boolean
      deafened?: boolean
      camera?: boolean
      /** V4 A1. */
      screensharing?: boolean
      resume?: boolean
      /** V4 A1: this call's random id, repeated on every resume. */
      session?: string
      /** V6 */
      afk?: boolean
    }
  | { type: 'voice.leave' }
  | { type: 'voice.ring'; channel_id: number }
  | {
      type: 'voice.state'
      muted: boolean
      deafened: boolean
      screensharing: boolean
      camera?: boolean
      /** V6 */
      afk?: boolean
    }
  | { type: 'signal'; to: number; data: SignalData | { meta: StreamMeta } | { watch: { stream: string; on: boolean } } }
  | { type: 'ping' }
