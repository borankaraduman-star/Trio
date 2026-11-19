import type { Channel, Member, Message, ServerEvent, ServerProfile, User, VoiceParticipant } from './types'
import { claimEchoes } from './lib/reconcile'
import { DEFAULT_SERVER, normalizeUser, serverProfile } from './lib/identity'

export type MessageStatus = 'sent' | 'pending' | 'failed'

export interface UiMessage extends Message {
  /** Stable React key: the nonce for a message this tab sent, else `m<id>`. */
  key: string
  status: MessageStatus
  nonce?: string
  /** Client time (ms) of the latest retry of an unconfirmed row; see lib/reconcile.ts. */
  sentAt?: number
}

export interface ChannelMessages {
  /** Confirmed messages by ascending id, then this tab's unconfirmed ones. */
  items: UiMessage[]
  hasMore: boolean
  loaded: boolean
  loadingOlder: boolean
  error: boolean
  /**
   * More was missed during a drop than a catch-up fetches, and the reader is
   * up in history: their messages stay as they are, live ones are not added
   * below them (there is a gap), and the list offers a jump to the newest.
   */
  behind?: boolean
}

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting'

export interface AppState {
  connection: ConnectionStatus
  /** A `ready` frame has been seen at least once. */
  ready: boolean
  me: User
  users: Record<number, Member>
  channels: Channel[]
  voice: Record<number, VoiceParticipant[]>
  activeChannelId: number | null
  messages: Record<number, ChannelMessages>
  /** channel id → user id → time (ms) the "typing" line expires. */
  typing: Record<number, Record<number, number>>
  /** channel id → id of the newest message the user has seen. */
  lastRead: Record<number, number>
  /** channel id → id of the newest message known to exist. */
  latest: Record<number, number>
  /** channel id → unread count (at least 1 when unread, exact for live messages). */
  unread: Record<number, number>
  /** v4: the server's name and icon ("Trio" until a server says otherwise). */
  server: ServerProfile
  /** v4: `ready.server_version`, or null from a server that predates it. */
  serverVersion: string | null
}

export type Action =
  | { type: 'server'; event: ServerEvent; now: number; viewing: boolean }
  | { type: 'connection.down' }
  | { type: 'channel.select'; channelId: number }
  | { type: 'viewing' }
  | { type: 'messages.loading-older'; channelId: number }
  | {
      type: 'messages.loaded'
      channelId: number
      messages: Message[]
      hasMore: boolean
      /** `behind`: the page does not meet what is held and is not shown yet (see `behind`). */
      mode: 'replace' | 'prepend' | 'behind'
      viewing: boolean
    }
  | { type: 'messages.load-failed'; channelId: number }
  | { type: 'message.optimistic'; message: UiMessage }
  | { type: 'message.failed'; channelId: number; nonce: string }
  | { type: 'message.retry'; channelId: number; nonce: string; at?: number }
  | { type: 'latest.loaded'; channelId: number; latestId: number }
  | { type: 'typing.prune'; now: number }

export const TYPING_TTL_MS = 5000

const EMPTY_CHANNEL: ChannelMessages = {
  items: [],
  hasMore: false,
  loaded: false,
  loadingOlder: false,
  error: false,
}

export function createInitialState(init: {
  me: User
  activeChannelId?: number | null
  lastRead?: Record<number, number>
}): AppState {
  return {
    connection: 'connecting',
    ready: false,
    me: init.me,
    users: {},
    channels: [],
    voice: {},
    activeChannelId: init.activeChannelId ?? null,
    messages: {},
    typing: {},
    lastRead: init.lastRead ?? {},
    latest: {},
    unread: {},
    server: DEFAULT_SERVER,
    serverVersion: null,
  }
}

export function channelMessages(state: AppState, channelId: number | null): ChannelMessages {
  if (channelId === null) return EMPTY_CHANNEL
  return state.messages[channelId] ?? EMPTY_CHANNEL
}

export function totalUnread(state: AppState): number {
  let total = 0
  for (const channel of state.channels) {
    if (channel.kind === 'text') total += state.unread[channel.id] ?? 0
  }
  return total
}

function toUi(message: Message, key = `m${message.id}`): UiMessage {
  return { ...message, key, status: 'sent' }
}

/** Confirmed messages by id (incoming wins, keeping the old key), then the unconfirmed tail. */
export function mergeMessages(existing: readonly UiMessage[], incoming: readonly UiMessage[]): UiMessage[] {
  const confirmed = new Map<number, UiMessage>()
  const tail: UiMessage[] = []
  for (const message of existing) {
    if (message.status === 'sent') confirmed.set(message.id, message)
    else tail.push(message)
  }
  for (const message of incoming) {
    const old = confirmed.get(message.id)
    confirmed.set(message.id, old ? { ...message, key: old.key } : message)
  }
  return [...[...confirmed.values()].sort((a, b) => a.id - b.id), ...tail]
}

function withChannel(
  state: AppState,
  channelId: number,
  update: (channel: ChannelMessages) => ChannelMessages,
): AppState {
  const current = state.messages[channelId] ?? EMPTY_CHANNEL
  return { ...state, messages: { ...state.messages, [channelId]: update(current) } }
}

function markRead(state: AppState, channelId: number): AppState {
  const latest = state.latest[channelId]
  const lastRead = state.lastRead[channelId]
  const unread = state.unread[channelId] ?? 0
  const nextRead = latest !== undefined && latest > (lastRead ?? 0) ? latest : lastRead
  if (unread === 0 && nextRead === lastRead) return state
  return {
    ...state,
    unread: { ...state.unread, [channelId]: 0 },
    lastRead: nextRead === undefined ? state.lastRead : { ...state.lastRead, [channelId]: nextRead },
  }
}

function pickActiveChannel(channels: Channel[], preferred: number | null): number | null {
  const text = channels.filter((channel) => channel.kind === 'text')
  if (preferred !== null && text.some((channel) => channel.id === preferred)) return preferred
  return text[0]?.id ?? null
}

function removeTyping(state: AppState, channelId: number, userId: number): AppState {
  const channel = state.typing[channelId]
  if (!channel || !(userId in channel)) return state
  const rest = { ...channel }
  delete rest[userId]
  return { ...state, typing: { ...state.typing, [channelId]: rest } }
}

function removeFromVoice(
  voice: Record<number, VoiceParticipant[]>,
  userId: number,
): Record<number, VoiceParticipant[]> {
  let changed = false
  const next: Record<number, VoiceParticipant[]> = {}
  for (const [key, list] of Object.entries(voice)) {
    const filtered = list.filter((participant) => participant.user_id !== userId)
    if (filtered.length !== list.length) changed = true
    next[Number(key)] = filtered
  }
  return changed ? next : voice
}

/** v2 camera flag: carried when the server sends it (a v1 frame has none). */
function cameraFlag(event: { camera?: unknown }): { camera?: boolean } {
  return typeof event.camera === 'boolean' ? { camera: event.camera } : {}
}

/** V4 A1: only a real `true` marks a participant as reconnecting. */
function reconnectingFlag(event: { reconnecting?: unknown }): { reconnecting?: boolean } {
  return event.reconnecting === true ? { reconnecting: true } : {}
}

function reduceServer(state: AppState, event: ServerEvent, now: number, viewing: boolean): AppState {
  switch (event.type) {
    case 'ready': {
      const users: Record<number, Member> = {}
      for (const user of event.users) users[user.id] = normalizeUser(user)
      const voice: Record<number, VoiceParticipant[]> = {}
      for (const [key, list] of Object.entries(event.voice ?? {})) voice[Number(key)] = list
      const activeChannelId = pickActiveChannel(event.channels, state.activeChannelId)

      // After a reconnect anything may have been missed. The open channel is
      // refetched by the caller; every other cache is dropped so that opening
      // the channel loads it again, except what only this tab has: messages not
      // sent yet (pending or failed) stay, and a load merges them back.
      const messages: Record<number, ChannelMessages> = {}
      if (activeChannelId !== null && state.messages[activeChannelId]) {
        messages[activeChannelId] = state.messages[activeChannelId]
      }
      for (const [key, channel] of Object.entries(state.messages)) {
        const unsent = channel.items.filter((item) => item.status !== 'sent')
        if (Number(key) !== activeChannelId && unsent.length > 0) {
          messages[Number(key)] = { ...EMPTY_CHANNEL, items: unsent }
        }
      }
      return {
        ...state,
        connection: 'open',
        ready: true,
        me: normalizeUser(event.user),
        server: serverProfile(event.server) ?? state.server,
        serverVersion: typeof event.server_version === 'string' ? event.server_version : null,
        users,
        channels: event.channels,
        voice,
        activeChannelId,
        messages,
        typing: {},
      }
    }

    case 'presence': {
      const user = state.users[event.user_id]
      if (!user || user.online === event.online) return state
      return { ...state, users: { ...state.users, [user.id]: { ...user, online: event.online } } }
    }

    case 'user.joined': {
      const existing = state.users[event.user.id]
      return {
        ...state,
        users: {
          ...state.users,
          [event.user.id]: { ...normalizeUser(event.user), online: existing?.online ?? false },
        },
      }
    }

    case 'user.removed': {
      // Their messages stay: a message carries its author's name itself.
      const id = event.user_id
      if (id === state.me.id) return state
      let next = state
      if (id in state.users) {
        const users = { ...state.users }
        delete users[id]
        next = { ...next, users }
      }
      const voice = removeFromVoice(next.voice, id)
      if (voice !== next.voice) next = { ...next, voice }
      for (const channelId of Object.keys(next.typing)) next = removeTyping(next, Number(channelId), id)
      return next
    }

    case 'user.updated': {
      // A rename or a new avatar. Old messages follow: rows read the author by id.
      const user = normalizeUser(event.user)
      let next = state
      const existing = state.users[user.id]
      if (existing) next = { ...next, users: { ...next.users, [user.id]: { ...user, online: existing.online } } }
      if (user.id === state.me.id) next = { ...next, me: user }
      return next
    }

    case 'server.updated': {
      const server = serverProfile(event.server)
      return server ? { ...state, server } : state
    }

    case 'channel.new': {
      if (state.channels.some((channel) => channel.id === event.channel.id)) return state
      const channels = [...state.channels, event.channel]
      return {
        ...state,
        channels,
        activeChannelId: state.activeChannelId ?? pickActiveChannel(channels, null),
      }
    }

    case 'message.new': {
      const message = event.message
      const channelId = message.channel_id
      const nonce = event.nonce
      let next = withChannel(state, channelId, (channel) => {
        const pendingIndex =
          nonce === undefined
            ? -1
            : channel.items.findIndex((item) => item.status !== 'sent' && item.nonce === nonce)
        if (pendingIndex >= 0) {
          // Our own optimistic row: swap it for the stored message, keeping its key.
          const rest = channel.items.filter((_, index) => index !== pendingIndex)
          return { ...channel, items: mergeMessages(rest, [{ ...toUi(message, nonce), nonce }]) }
        }
        if (channel.items.some((item) => item.status === 'sent' && item.id === message.id)) {
          return channel
        }
        // Not below a gap; the jump to the newest loads it.
        if (channel.behind) return channel
        if (nonce === undefined) {
          // My message without a nonce (its echo was lost): pair it with the local row.
          const paired = claimEchoes(channel.items, [toUi(message)], state.me.id)
          return { ...channel, items: mergeMessages(paired.items, paired.incoming) }
        }
        return { ...channel, items: mergeMessages(channel.items, [toUi(message)]) }
      })

      if (message.id > (next.latest[channelId] ?? 0)) {
        next = { ...next, latest: { ...next.latest, [channelId]: message.id } }
      }
      next = removeTyping(next, channelId, message.author.id)

      const own = message.author.id === state.me.id
      const seen = own || (viewing && state.activeChannelId === channelId)
      if (seen) {
        if (message.id > (next.lastRead[channelId] ?? 0)) {
          next = { ...next, lastRead: { ...next.lastRead, [channelId]: message.id } }
        }
      } else if (message.id > (state.latest[channelId] ?? 0)) {
        next = {
          ...next,
          unread: { ...next.unread, [channelId]: (next.unread[channelId] ?? 0) + 1 },
        }
      }
      return next
    }

    case 'typing': {
      if (event.user_id === state.me.id) return state
      return {
        ...state,
        typing: {
          ...state.typing,
          [event.channel_id]: {
            ...state.typing[event.channel_id],
            [event.user_id]: now + TYPING_TTL_MS,
          },
        },
      }
    }

    case 'voice.joined': {
      const voice = { ...removeFromVoice(state.voice, event.user_id) }
      voice[event.channel_id] = [
        ...(voice[event.channel_id] ?? []),
        {
          user_id: event.user_id,
          muted: event.muted,
          deafened: event.deafened,
          screensharing: event.screensharing,
          ...cameraFlag(event),
          ...reconnectingFlag(event),
        },
      ]
      return { ...state, voice }
    }

    case 'voice.left': {
      const list = state.voice[event.channel_id]
      if (!list || !list.some((participant) => participant.user_id === event.user_id)) return state
      return {
        ...state,
        voice: {
          ...state.voice,
          [event.channel_id]: list.filter((participant) => participant.user_id !== event.user_id),
        },
      }
    }

    case 'voice.state': {
      const list = state.voice[event.channel_id]
      if (!list) return state
      return {
        ...state,
        voice: {
          ...state.voice,
          [event.channel_id]: list.map((participant) =>
            participant.user_id === event.user_id
              ? {
                  user_id: event.user_id,
                  muted: event.muted,
                  deafened: event.deafened,
                  screensharing: event.screensharing,
                  ...cameraFlag(event),
                  ...reconnectingFlag(event),
                }
              : participant,
          ),
        },
      }
    }

    // Handled outside the store (voice engine) or not at all.
    case 'voice.peers':
    case 'signal':
    case 'pong':
    case 'error':
      return state

    default:
      return state
  }
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'server':
      return reduceServer(state, action.event, action.now, action.viewing)

    case 'connection.down': {
      // Whatever was still unconfirmed cannot be confirmed on this connection.
      const messages: Record<number, ChannelMessages> = {}
      for (const [key, channel] of Object.entries(state.messages)) {
        messages[Number(key)] = channel.items.some((item) => item.status === 'pending')
          ? {
              ...channel,
              items: channel.items.map((item) =>
                item.status === 'pending' ? { ...item, status: 'failed' as const } : item,
              ),
            }
          : channel
      }
      return {
        ...state,
        connection: state.ready ? 'reconnecting' : 'connecting',
        messages,
        typing: {},
      }
    }

    case 'channel.select': {
      const channel = state.channels.find((item) => item.id === action.channelId)
      if (!channel || channel.kind !== 'text') return state
      return markRead({ ...state, activeChannelId: channel.id }, channel.id)
    }

    case 'viewing':
      return state.activeChannelId === null ? state : markRead(state, state.activeChannelId)

    case 'messages.loading-older':
      return withChannel(state, action.channelId, (channel) => ({ ...channel, loadingOlder: true }))

    case 'messages.loaded': {
      const page = action.messages
      let next = withChannel(state, action.channelId, (channel) => {
        if (action.mode === 'prepend') {
          const paired = claimEchoes(channel.items, page.map((message) => toUi(message)), state.me.id)
          return {
            ...channel,
            items: mergeMessages(paired.items, paired.incoming),
            hasMore: action.hasMore,
            loadingOlder: false,
            error: false,
          }
        }
        if (action.mode === 'behind') return { ...channel, behind: true, error: false }
        // A page that meets what is held (its oldest id is at or before the
        // newest held) is merged: nothing loaded is thrown away, and a reader
        // up in history keeps their place. Only after a gap is it replaced.
        const newestInPage = page.length > 0 ? page[page.length - 1].id : -Infinity
        const held = channel.items.filter((item) => item.status === 'sent')
        // Behind a gap, the newest page is the jump and always replaces.
        if (channel.loaded && !channel.behind && held.length > 0 && page.length > 0 && page[0].id <= held[held.length - 1].id) {
          // Within the page's range the page is the truth; outside it, what is held stays.
          const inPage = new Set(page.map((message) => message.id))
          const outside = channel.items.filter(
            (item) =>
              item.status !== 'sent' || item.id < page[0].id || item.id > newestInPage || inPage.has(item.id),
          )
          const paired = claimEchoes(outside, page.map((message) => toUi(message)), state.me.id)
          return {
            ...channel,
            items: mergeMessages(paired.items, paired.incoming),
            hasMore: page[0].id < held[0].id ? action.hasMore : channel.hasMore,
            error: false,
            behind: false,
          }
        }
        // Replace with the latest page, but keep what the page cannot know:
        // unconfirmed rows, and live messages newer than the page.
        const kept = channel.items.filter(
          (item) => item.status !== 'sent' || item.id > newestInPage,
        )
        const keys = new Map(channel.items.map((item) => [item.id, item.key]))
        const paired = claimEchoes(
          kept,
          page.map((message) => toUi(message, keys.get(message.id))),
          state.me.id,
        )
        return {
          items: mergeMessages(paired.items, paired.incoming),
          hasMore: action.hasMore,
          loaded: true,
          loadingOlder: false,
          error: false,
        }
      })
      const newest = page.length > 0 ? page[page.length - 1].id : 0
      if (newest > (next.latest[action.channelId] ?? 0)) {
        next = { ...next, latest: { ...next.latest, [action.channelId]: newest } }
      }
      if (action.viewing && next.activeChannelId === action.channelId) {
        next = markRead(next, action.channelId)
      }
      return next
    }

    case 'messages.load-failed':
      return withChannel(state, action.channelId, (channel) => ({
        ...channel,
        loadingOlder: false,
        error: !channel.loaded,
      }))

    case 'message.optimistic':
      return withChannel(state, action.message.channel_id, (channel) => ({
        ...channel,
        items: [...channel.items, action.message],
      }))

    case 'message.failed':
    case 'message.retry': {
      const from = action.type === 'message.failed' ? 'pending' : 'failed'
      const to = action.type === 'message.failed' ? 'failed' : 'pending'
      const channel = state.messages[action.channelId]
      if (!channel?.items.some((item) => item.nonce === action.nonce && item.status === from)) {
        return state
      }
      return withChannel(state, action.channelId, (current) => ({
        ...current,
        items: current.items.map((item) =>
          item.nonce === action.nonce && item.status === from
            ? { ...item, status: to, ...(action.type === 'message.retry' && action.at !== undefined ? { sentAt: action.at } : {}) }
            : item,
        ),
      }))
    }

    case 'latest.loaded': {
      const { channelId, latestId } = action
      let next = state
      if (latestId > (state.latest[channelId] ?? 0)) {
        next = { ...next, latest: { ...next.latest, [channelId]: latestId } }
      }
      const unseen = latestId > (state.lastRead[channelId] ?? 0)
      if (unseen && state.activeChannelId !== channelId && (state.unread[channelId] ?? 0) === 0) {
        next = { ...next, unread: { ...next.unread, [channelId]: 1 } }
      }
      return next
    }

    case 'typing.prune': {
      let changed = false
      const typing: Record<number, Record<number, number>> = {}
      for (const [channelKey, users] of Object.entries(state.typing)) {
        const alive: Record<number, number> = {}
        for (const [userKey, expires] of Object.entries(users)) {
          if (expires > action.now) alive[Number(userKey)] = expires
          else changed = true
        }
        typing[Number(channelKey)] = alive
      }
      return changed ? { ...state, typing } : state
    }

    default:
      return state
  }
}

/** The voice channel a user is in, by the server's last word, else null. */
export function voiceChannelOf(state: AppState, userId: number): number | null {
  for (const [key, list] of Object.entries(state.voice)) {
    if (list.some((participant) => participant.user_id === userId)) return Number(key)
  }
  return null
}

export function typingNames(state: AppState, channelId: number | null, now: number): string[] {
  if (channelId === null) return []
  const users = state.typing[channelId]
  if (!users) return []
  return Object.entries(users)
    .filter(([userId, expires]) => expires > now && Number(userId) !== state.me.id)
    .map(([userId]) => state.users[Number(userId)]?.name)
    .filter((name): name is string => typeof name === 'string')
}

// --- what the browser remembers -------------------------------------------

const LAST_READ_KEY = 'trio.lastRead'
const ACTIVE_CHANNEL_KEY = 'trio.channel'

export function loadLastRead(): Record<number, number> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(LAST_READ_KEY) ?? '{}')
    const result: Record<number, number> = {}
    if (typeof raw === 'object' && raw !== null) {
      for (const [key, value] of Object.entries(raw)) {
        if (Number.isInteger(Number(key)) && typeof value === 'number') result[Number(key)] = value
      }
    }
    return result
  } catch {
    return {}
  }
}

export function saveLastRead(lastRead: Record<number, number>): void {
  try {
    localStorage.setItem(LAST_READ_KEY, JSON.stringify(lastRead))
  } catch {
    // Kept in memory only.
  }
}

export function loadActiveChannel(): number | null {
  try {
    const value = Number(localStorage.getItem(ACTIVE_CHANNEL_KEY))
    return Number.isInteger(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

export function saveActiveChannel(channelId: number): void {
  try {
    localStorage.setItem(ACTIVE_CHANNEL_KEY, String(channelId))
  } catch {
    // Kept in memory only.
  }
}

export function clearStoredState(): void {
  try {
    localStorage.removeItem(LAST_READ_KEY)
    localStorage.removeItem(ACTIVE_CHANNEL_KEY)
  } catch {
    // Nothing to clear.
  }
}
