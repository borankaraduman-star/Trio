import type { Channel, Member, Message, ServerEvent, ServerProfile, User, VoiceParticipant } from './types'
import { claimEchoes } from './lib/reconcile'
import { DEFAULT_SERVER, normalizeUser, serverProfile } from './lib/identity'
import { supersedes, updatePins, sortPins } from './lib/messageFamily'
import { refreshQuotes } from './lib/replyQuote'
import { isReadStateEntry, mergeEntry } from './lib/readState'

export type MessageStatus = 'sent' | 'pending' | 'failed'

export interface UiMessage extends Message {
  /** Stable React key: the nonce for a message this tab sent, else `m<id>`. */
  key: string
  status: MessageStatus
  nonce?: string
  /** Client time (ms) of the latest retry of an unconfirmed row; see lib/reconcile.ts. */
  sentAt?: number
  /** v4: the content of an edit this tab sent and the server has not answered yet (shown instead). */
  pendingEdit?: string
}

/** v4: a channel's pinned messages (CONTRACT-V4 B), loaded when the panel opens. */
export interface ChannelPins {
  items: Message[]
  loaded: boolean
  error: boolean
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
  /** v4: ids of messages known deleted (ids are never reused): a late page cannot bring one back. */
  deleted: Record<number, true>
  /** v4: channel id → its pinned messages, once asked for. */
  pins: Record<number, ChannelPins>
  /** V7-READING: the server keeps read state (its `ready` carried `read_state`). */
  readSync: boolean
  /** V7-READING: channel id → the mark the server is known to hold. */
  serverRead: Record<number, number>
  /**
   * V7-READING: "Yeni mesajlar" in the open channel: the mark it had when it
   * was opened with something unread. Lasts for the visit (leaving the
   * channel or sending in it ends it).
   */
  divider: { channelId: number; after: number } | null
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
  // --- v4: the message family ---
  /** An edit sent and not answered yet: shown at once, dropped (rolled back) by `message.edit-settled`. */
  | { type: 'message.edit-local'; channelId: number; messageId: number; content: string }
  | { type: 'message.edit-settled'; channelId: number; messageId: number }
  /**
   * After a reconnect: a page re-read from what is held. Within its range the
   * page is the truth for messages already held (edits, reactions, deletions);
   * nothing that is not held is added, so it can never open a gap.
   */
  | { type: 'messages.refresh'; channelId: number; messages: Message[]; before: number; hasMore: boolean }
  | { type: 'pins.loaded'; channelId: number; messages: Message[] }
  | { type: 'pins.failed'; channelId: number }
  // --- V7-READING ---
  /** `channel.read` was handed to the socket: the server holds this mark now. */
  | { type: 'read.sent'; channelId: number; messageId: number }
  | { type: 'divider.clear'; channelId: number }

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
    deleted: {},
    pins: {},
    readSync: false,
    serverRead: {},
    divider: null,
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
    // v4: the copy with the highest `rev` wins, whichever way it arrived.
    if (old && !supersedes(message, old)) continue
    confirmed.set(message.id, old ? adopt(old, message) : message)
  }
  return [...[...confirmed.values()].sort((a, b) => a.id - b.id), ...tail]
}

/** `incoming` taking `old`'s place: the old key, and an edit of ours still in flight. */
function adopt(old: UiMessage, incoming: UiMessage): UiMessage {
  const next: UiMessage = { ...incoming, key: old.key }
  if (old.pendingEdit !== undefined) next.pendingEdit = old.pendingEdit
  return next
}

/** A page's copies, except where a held copy is newer (a broadcast that overtook the page). */
function preferHeld(page: UiMessage[], items: readonly UiMessage[]): UiMessage[] {
  const held = new Map<number, UiMessage>()
  for (const item of items) if (item.status === 'sent') held.set(item.id, item)
  return page.map((message) => {
    const old = held.get(message.id)
    return old && !supersedes(message, old) ? old : message
  })
}

/** v4: a page minus what is known deleted, and the deletions its quotes reveal. */
function screenPage(state: AppState, page: readonly Message[]): { page: Message[]; deleted: Record<number, true> } {
  let deleted = state.deleted
  for (const message of page) {
    const reply = message.reply_to
    if (reply?.deleted && !deleted[reply.id]) deleted = { ...deleted, [reply.id]: true }
  }
  return { page: page.filter((message) => !deleted[message.id]), deleted }
}

/** v4: deletions a page's quotes revealed: recorded, and the held copies removed. */
function forgetRevealed(state: AppState, deleted: Record<number, true>, channelId: number): AppState {
  if (deleted === state.deleted) return state
  let next = state
  for (const id of Object.keys(deleted)) {
    if (!state.deleted[Number(id)]) next = removeMessage(next, channelId, Number(id))
  }
  return next
}

/** v4: quotes in a channel brought up to date with what it holds (lib/replyQuote.ts). */
function withQuotes(state: AppState, channelId: number): AppState {
  const channel = state.messages[channelId]
  if (!channel) return state
  const items = refreshQuotes(channel.items, state.deleted)
  return items === channel.items
    ? state
    : { ...state, messages: { ...state.messages, [channelId]: { ...channel, items: [...items] } } }
}

/** v4: a deleted message leaves the channel's cache, its pins and every quote of it. */
function removeMessage(state: AppState, channelId: number, messageId: number, nonce?: string): AppState {
  let next: AppState = state.deleted[messageId] ? state : { ...state, deleted: { ...state.deleted, [messageId]: true } }
  const channel = next.messages[channelId]
  if (
    channel?.items.some(
      (item) => (item.status === 'sent' && item.id === messageId) || (nonce !== undefined && item.nonce === nonce && item.status !== 'sent'),
    )
  ) {
    next = withChannel(next, channelId, (current) => ({
      ...current,
      items: current.items.filter(
        (item) =>
          !(item.status === 'sent' && item.id === messageId) &&
          !(nonce !== undefined && item.status !== 'sent' && item.nonce === nonce),
      ),
    }))
  }
  const pins = next.pins[channelId]
  if (pins?.items.some((pin) => pin.id === messageId)) {
    next = { ...next, pins: { ...next.pins, [channelId]: { ...pins, items: pins.items.filter((pin) => pin.id !== messageId) } } }
  }
  return withQuotes(next, channelId)
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
  // V7-READING: opening a channel with something unread remembers where it was.
  const divider =
    state.activeChannelId === channelId &&
    state.divider?.channelId !== channelId &&
    lastRead !== undefined &&
    lastRead > 0 &&
    nextRead !== undefined &&
    nextRead > lastRead
      ? { channelId, after: lastRead }
      : state.divider
  return {
    ...state,
    unread: { ...state.unread, [channelId]: 0 },
    lastRead: nextRead === undefined ? state.lastRead : { ...state.lastRead, [channelId]: nextRead },
    divider,
  }
}

/** V7-READING: `ready.read_state` merged with this device's own marks (lib/readState.ts). */
function withReadState(state: AppState, readState: unknown, channels: Channel[]): AppState {
  if (typeof readState !== 'object' || readState === null) return { ...state, readSync: false }
  const entries = readState as Record<string, unknown>
  const lastRead = { ...state.lastRead }
  const latest = { ...state.latest }
  const unread = { ...state.unread }
  const serverRead: Record<number, number> = {}
  for (const channel of channels) {
    if (channel.kind !== 'text') continue
    const entry = entries[String(channel.id)]
    if (!isReadStateEntry(entry)) continue
    const merged = mergeEntry(state.lastRead[channel.id], entry, state.latest[channel.id])
    if (merged.lastRead > 0) lastRead[channel.id] = merged.lastRead
    if (merged.latest > 0) latest[channel.id] = merged.latest
    serverRead[channel.id] = merged.serverRead
    unread[channel.id] = merged.unread
  }
  return { ...state, readSync: true, lastRead, latest, unread, serverRead }
}

/** V7-READING: a channel and everything this tab held about it. */
function forgetChannel(state: AppState, channelId: number): AppState {
  const drop = <T,>(record: Record<number, T>): Record<number, T> => {
    if (!(channelId in record)) return record
    const next = { ...record }
    delete next[channelId]
    return next
  }
  const channels = state.channels.filter((channel) => channel.id !== channelId)
  const activeChannelId =
    state.activeChannelId === channelId ? pickActiveChannel(channels, null) : state.activeChannelId
  return {
    ...state,
    channels,
    activeChannelId,
    messages: drop(state.messages),
    typing: drop(state.typing),
    lastRead: drop(state.lastRead),
    latest: drop(state.latest),
    unread: drop(state.unread),
    serverRead: drop(state.serverRead),
    pins: drop(state.pins),
    voice: drop(state.voice),
    divider: state.divider?.channelId === channelId ? null : state.divider,
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
      return withReadState({
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
        // v4: re-read when the panel is open; what was missed is unknown.
        pins: {},
      }, event.read_state, event.channels)
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

    case 'channel.updated': {
      const index = state.channels.findIndex((channel) => channel.id === event.channel.id)
      if (index < 0) return state
      const channels = [...state.channels]
      channels[index] = { ...channels[index], name: event.channel.name }
      return { ...state, channels }
    }

    case 'channel.deleted':
      return state.channels.some((channel) => channel.id === event.channel_id)
        ? forgetChannel(state, event.channel_id)
        : state

    case 'channel.read': {
      // Another device of mine read this far: so have I, everywhere.
      const channelId = event.channel_id
      if (!Number.isInteger(event.message_id) || !state.channels.some((c) => c.id === channelId)) return state
      const mark = event.message_id
      const serverRead = mark > (state.serverRead[channelId] ?? 0) ? { ...state.serverRead, [channelId]: mark } : state.serverRead
      if (mark <= (state.lastRead[channelId] ?? 0)) return serverRead === state.serverRead ? state : { ...state, serverRead }
      const latest = state.latest[channelId] ?? 0
      const count = typeof event.unread === 'number' && Number.isInteger(event.unread) ? event.unread : 1
      return {
        ...state,
        serverRead,
        lastRead: { ...state.lastRead, [channelId]: mark },
        unread: { ...state.unread, [channelId]: mark >= latest ? 0 : Math.max(0, count) },
      }
    }

    case 'message.new': {
      const message = event.message
      const channelId = message.channel_id
      const nonce = event.nonce
      // v4: deleted meanwhile (a late frame): never shown again.
      if (state.deleted[message.id]) return removeMessage(state, channelId, message.id, nonce)
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
        const held = channel.items.find((item) => item.status === 'sent' && item.id === message.id)
        if (held) {
          // v4: a retried nonce answers with the message as it is now (its edits, reactions).
          return held.rev !== undefined && message.rev !== undefined && message.rev > held.rev
            ? { ...channel, items: mergeMessages(channel.items, [toUi(message)]) }
            : channel
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
      next = removeTyping(withQuotes(next, channelId), channelId, message.author.id)

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

    case 'message.updated': {
      const message = event.message
      const channelId = message.channel_id
      if (state.deleted[message.id]) return state
      let next = state
      const channel = state.messages[channelId]
      const index = channel ? channel.items.findIndex((item) => item.status === 'sent' && item.id === message.id) : -1
      if (channel && index >= 0 && supersedes(message, channel.items[index])) {
        const items = [...channel.items]
        items[index] = adopt(channel.items[index], toUi(message))
        next = withQuotes({ ...next, messages: { ...next.messages, [channelId]: { ...channel, items } } }, channelId)
      }
      const pins = next.pins[channelId]
      if (pins?.loaded && (message.pinned_at || pins.items.some((pin) => pin.id === message.id))) {
        next = { ...next, pins: { ...next.pins, [channelId]: { ...pins, items: updatePins(pins.items, message) } } }
      }
      return next
    }

    case 'message.deleted':
      return removeMessage(state, event.channel_id, event.message_id, event.nonce)

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
          ...(event.afk === true ? { afk: true } : {}),
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
                  ...(event.afk === true ? { afk: true } : {}),
                }
              : participant,
          ),
        },
      }
    }

    // Handled outside the store (voice engine) or not at all.
    case 'voice.peers':
    case 'signal':
    case 'voice.ring':
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
      const divider = state.divider?.channelId === channel.id ? state.divider : null
      return markRead({ ...state, activeChannelId: channel.id, divider }, channel.id)
    }

    case 'viewing':
      return state.activeChannelId === null ? state : markRead(state, state.activeChannelId)

    case 'messages.loading-older':
      return withChannel(state, action.channelId, (channel) => ({ ...channel, loadingOlder: true }))

    case 'messages.loaded': {
      const screened = screenPage(state, action.messages)
      const page = screened.page
      let next = withChannel(forgetRevealed(state, screened.deleted, action.channelId), action.channelId, (channel) => {
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
          preferHeld(page.map((message) => toUi(message, keys.get(message.id))), channel.items),
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
      next = withQuotes(next, action.channelId)
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

    case 'message.edit-local':
    case 'message.edit-settled': {
      const channel = state.messages[action.channelId]
      const index = channel ? channel.items.findIndex((item) => item.status === 'sent' && item.id === action.messageId) : -1
      if (!channel || index < 0) return state
      const items = [...channel.items]
      const item = { ...items[index] }
      if (action.type === 'message.edit-local') item.pendingEdit = action.content
      else if (item.pendingEdit === undefined) return state
      else delete item.pendingEdit
      items[index] = item
      return { ...state, messages: { ...state.messages, [action.channelId]: { ...channel, items } } }
    }

    case 'messages.refresh': {
      if (!state.messages[action.channelId]) return state
      const screened = screenPage(state, action.messages)
      const revealed = forgetRevealed(state, screened.deleted, action.channelId)
      const channel = revealed.messages[action.channelId]
      const page = screened.page
      // The page's range: from its oldest (or the channel's start) up to just before `before`.
      const from = action.hasMore && page.length > 0 ? page[0].id : -Infinity
      const inPage = new Map(page.map((message) => [message.id, message]))
      let changed = false
      const items: UiMessage[] = []
      for (const item of channel.items) {
        if (item.status !== 'sent' || item.id < from || item.id >= action.before) {
          items.push(item)
          continue
        }
        const fresh = inPage.get(item.id)
        if (!fresh) {
          changed = true
          continue
        }
        if (supersedes(fresh, item) && fresh.rev !== item.rev) {
          changed = true
          items.push(adopt(item, toUi(fresh)))
        } else items.push(item)
      }
      let next = revealed
      if (changed) next = { ...next, messages: { ...next.messages, [action.channelId]: { ...channel, items } } }
      return withQuotes(next, action.channelId)
    }

    case 'pins.loaded': {
      const known = action.messages.filter((message) => !state.deleted[message.id])
      // A pin change that arrived while the list was on its way is newer than it.
      const held = state.pins[action.channelId]
      let items = sortPins(known)
      if (held) for (const pin of held.items) items = updatePins(items, pin)
      return { ...state, pins: { ...state.pins, [action.channelId]: { items, loaded: true, error: false } } }
    }

    case 'pins.failed': {
      const held = state.pins[action.channelId]
      return { ...state, pins: { ...state.pins, [action.channelId]: { items: held?.items ?? [], loaded: held?.loaded ?? false, error: true } } }
    }

    case 'read.sent':
      return action.messageId > (state.serverRead[action.channelId] ?? 0)
        ? { ...state, serverRead: { ...state.serverRead, [action.channelId]: action.messageId } }
        : state

    case 'divider.clear':
      return state.divider?.channelId === action.channelId ? { ...state, divider: null } : state

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
