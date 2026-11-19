/**
 * v4: the message family's actions and the little UI state around them
 * (CONTRACT-V4 B): editing, replying, reactions, pins, deleting, jumping to a
 * message. Kept out of Session.tsx so that file only wires it in.
 *
 * Every REST answer goes through the reducer as a `message.updated`, so the
 * answer and the broadcast may arrive in either order (the higher `rev` wins).
 */
import { useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject } from 'react'
import { api, ApiError } from './api'
import { familyErrorMessage, messageApi } from './messageApi'
import { normalizeReactionKey } from './lib/emojiKey'
import { lastEditable } from './lib/messageFamily'
import { pushRecent } from './lib/recentEmoji'
import { quoteFrom } from './lib/replyQuote'
import { isViewing } from './lib/viewing'
import { channelMessages, type Action, type AppState, type UiMessage } from './store'
import type { Message, ServerEvent } from './types'
import type { AnchorRect } from './components/message/Popover'

const PAGE_SIZE = 50
/** Pages loaded at most while looking for a quoted or pinned message (50 each). */
export const MAX_JUMP_PAGES = 20
/** Pages re-read at most after a reconnect to bring held messages up to date. */
export const MAX_REFRESH_PAGES = 20
const NOTICE_MS = 5000

export interface JumpRequest {
  channelId: number
  messageId: number
  /** A new request for the same message flashes it again. */
  seq: number
}

export interface MessageFamily {
  editing: { channelId: number; messageId: number } | null
  reply: Message | null
  notice: string | null
  pinsOpen: boolean
  /** Where the pins panel opens from (the header button), null = a sheet. */
  pinsAnchor: AnchorRect | null
  jump: JumpRequest | null
  /** Bumped when the composer should take the focus (after reply/edit). */
  composerFocus: number
  actions: FamilyActions
}

export interface FamilyActions {
  toggleReaction(message: Message, key: string): void
  startEdit(message: Message): void
  cancelEdit(): void
  saveEdit(message: Message, content: string): void
  /** Up-arrow in an empty composer: edit my last message in the open channel. */
  editLast(): boolean
  remove(message: Message): void
  togglePin(message: Message): void
  startReply(message: Message): void
  cancelReply(): void
  jumpTo(messageId: number): void
  jumpDone(): void
  setPinsOpen(open: boolean, anchor?: AnchorRect | null): void
  /** Re-read the open channel's pins (the panel's "Tekrar dene"). */
  reloadPins(): void
  dismissNotice(): void
  showNotice(text: string): void
  /** Wired into the socket's event handler (before = the state the event arrived on). */
  onEvent(event: ServerEvent, before: AppState): void
}

export function useMessageFamily({
  token,
  dispatch,
  stateRef,
  onLogout,
  onSendTimerDone,
}: {
  token: string
  dispatch: Dispatch<Action>
  stateRef: MutableRefObject<AppState>
  onLogout: () => void
  /** A retried send was answered with `message.deleted {nonce}`: its timer must stop. */
  onSendTimerDone: (nonce: string) => void
}): MessageFamily {
  const [editing, setEditing] = useState<MessageFamily['editing']>(null)
  const [reply, setReply] = useState<{ channelId: number; message: Message } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pinsOpen, setPinsOpenState] = useState(false)
  const [pinsAnchor, setPinsAnchor] = useState<AnchorRect | null>(null)
  const [jump, setJump] = useState<JumpRequest | null>(null)
  const [composerFocus, setComposerFocus] = useState(0)

  const deps = useRef({ token, dispatch, onLogout, onSendTimerDone, pinsOpen })
  deps.current = { token, dispatch, onLogout, onSendTimerDone, pinsOpen }
  const inFlight = useRef(new Set<string>())
  const jumpSeq = useRef(0)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const actions = useMemo<FamilyActions>(() => {
    const showNotice = (text: string) => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current)
      setNotice(text)
      noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS)
    }
    const failed = (error: unknown) => {
      if (error instanceof ApiError && error.status === 401) {
        deps.current.onLogout()
        return
      }
      const code = error instanceof ApiError ? error.code : 'UNKNOWN'
      const status = error instanceof ApiError ? error.status : 0
      showNotice(familyErrorMessage(code, status))
    }
    const updated = (message: Message) =>
      deps.current.dispatch({ type: 'server', event: { type: 'message.updated', message }, now: Date.now(), viewing: isViewing() })
    /** One request at a time per thing (a double click is one change). */
    const once = async (id: string, work: () => Promise<void>) => {
      if (inFlight.current.has(id)) return
      inFlight.current.add(id)
      try {
        await work()
      } finally {
        inFlight.current.delete(id)
      }
    }

    const loadPins = async (channelId: number) => {
      try {
        const { messages } = await messageApi.pins(deps.current.token, channelId)
        deps.current.dispatch({ type: 'pins.loaded', channelId, messages })
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) deps.current.onLogout()
        else deps.current.dispatch({ type: 'pins.failed', channelId })
      }
    }

    /** Re-read the held messages of a channel (after a reconnect), newest page first. */
    const refreshHeld = async (channelId: number, held: readonly UiMessage[]) => {
      const confirmed = held.filter((item) => item.status === 'sent')
      if (confirmed.length === 0) return
      const oldest = confirmed[0].id
      let before = confirmed[confirmed.length - 1].id + 1
      for (let pages = 0; pages < MAX_REFRESH_PAGES; pages += 1) {
        const page = await api.messages(deps.current.token, channelId, { before, limit: PAGE_SIZE })
        deps.current.dispatch({ type: 'messages.refresh', channelId, messages: page.messages, before, hasMore: page.has_more })
        if (!page.has_more || page.messages.length === 0 || page.messages[0].id <= oldest) return
        before = page.messages[0].id
      }
    }

    const search = async (channelId: number, messageId: number) => {
      const { token } = deps.current
      const state = stateRef.current
      if (state.deleted[messageId]) return false
      const channel = channelMessages(state, channelId)
      const confirmed = channel.items.filter((item) => item.status === 'sent')
      if (confirmed.some((item) => item.id === messageId)) return true
      let oldest: number
      let hasMore: boolean
      const newest = confirmed[confirmed.length - 1]?.id ?? 0
      if (!channel.loaded || confirmed.length === 0 || (channel.behind && messageId > newest)) {
        // Behind a gap (or nothing held): the newest page first, as the jump to the newest does.
        const page = await api.messages(token, channelId, { limit: PAGE_SIZE })
        deps.current.dispatch({ type: 'messages.loaded', channelId, messages: page.messages, hasMore: page.has_more, mode: 'replace', viewing: isViewing() })
        if (page.messages.some((message) => message.id === messageId)) return true
        if (page.messages.length === 0) return false
        oldest = page.messages[0].id
        hasMore = page.has_more
      } else {
        oldest = confirmed[0].id
        hasMore = channel.hasMore
      }
      for (let pages = 0; pages < MAX_JUMP_PAGES && hasMore && oldest > messageId; pages += 1) {
        deps.current.dispatch({ type: 'messages.loading-older', channelId })
        const page = await api.messages(token, channelId, { before: oldest, limit: PAGE_SIZE })
        deps.current.dispatch({ type: 'messages.loaded', channelId, messages: page.messages, hasMore: page.has_more, mode: 'prepend', viewing: isViewing() })
        if (page.messages.some((message) => message.id === messageId)) return true
        if (page.messages.length === 0) return false
        oldest = page.messages[0].id
        hasMore = page.has_more
      }
      return false
    }

    return {
      showNotice,
      dismissNotice: () => {
        if (noticeTimer.current) clearTimeout(noticeTimer.current)
        setNotice(null)
      },

      toggleReaction(message, rawKey) {
        const key = normalizeReactionKey(rawKey)
        const meId = stateRef.current.me.id
        const mine = message.reactions?.find((reaction) => reaction.key === key)?.user_ids.includes(meId) ?? false
        if (!mine) pushRecent(key)
        void once(`r${message.id}:${key}`, async () => {
          try {
            updated((await messageApi.react(deps.current.token, message.id, key, !mine)).message)
          } catch (error) {
            failed(error)
          }
        })
      },

      startEdit(message) {
        setEditing({ channelId: message.channel_id, messageId: message.id })
      },
      cancelEdit() {
        setEditing(null)
        setComposerFocus((value) => value + 1)
      },
      saveEdit(message, content) {
        setEditing(null)
        setComposerFocus((value) => value + 1)
        if (content === message.content) return
        const { dispatch } = deps.current
        const target = { channelId: message.channel_id, messageId: message.id }
        dispatch({ type: 'message.edit-local', ...target, content })
        void (async () => {
          try {
            updated((await messageApi.edit(deps.current.token, message.id, content)).message)
          } catch (error) {
            failed(error)
          } finally {
            // Rolls the optimistic text back unless the server's copy has it.
            deps.current.dispatch({ type: 'message.edit-settled', ...target })
          }
        })()
      },
      editLast() {
        const state = stateRef.current
        if (state.activeChannelId === null) return false
        const last = lastEditable(channelMessages(state, state.activeChannelId).items, state.me.id)
        if (!last) return false
        setEditing({ channelId: last.channel_id, messageId: last.id })
        return true
      },

      remove(message) {
        void once(`d${message.id}`, async () => {
          try {
            await messageApi.remove(deps.current.token, message.id)
            // The broadcast says so too; whichever comes second changes nothing.
            deps.current.dispatch({
              type: 'server',
              event: { type: 'message.deleted', channel_id: message.channel_id, message_id: message.id },
              now: Date.now(),
              viewing: isViewing(),
            })
          } catch (error) {
            failed(error)
          }
        })
      },

      togglePin(message) {
        void once(`p${message.id}`, async () => {
          try {
            updated((await messageApi.pin(deps.current.token, message.id, !message.pinned_at)).message)
          } catch (error) {
            failed(error)
          }
        })
      },

      startReply(message) {
        setReply({ channelId: message.channel_id, message })
        setComposerFocus((value) => value + 1)
      },
      cancelReply() {
        setReply(null)
      },

      jumpTo(messageId) {
        const channelId = stateRef.current.activeChannelId
        if (channelId === null) return
        jumpSeq.current += 1
        const request = { channelId, messageId, seq: jumpSeq.current }
        setJump(request)
        void search(channelId, messageId)
          .catch(() => false)
          .then((found) => {
            if (found || jumpSeq.current !== request.seq) return
            setJump(null)
            showNotice(
              stateRef.current.deleted[messageId]
                ? 'Bu mesaj silinmiş.'
                : 'Mesaj bulunamadı: silinmiş ya da çok eskide olabilir.',
            )
          })
      },
      jumpDone() {
        setJump(null)
      },

      setPinsOpen(open, anchor) {
        setPinsOpenState(open)
        if (anchor !== undefined) setPinsAnchor(anchor)
        const channelId = stateRef.current.activeChannelId
        if (open && channelId !== null) void loadPins(channelId)
      },
      reloadPins() {
        const channelId = stateRef.current.activeChannelId
        if (channelId !== null) void loadPins(channelId)
      },

      onEvent(event, before) {
        if (event.type === 'message.deleted' && event.nonce !== undefined) deps.current.onSendTimerDone(event.nonce)
        if (event.type !== 'ready') return
        const channelId = before.activeChannelId
        if (deps.current.pinsOpen && channelId !== null) void loadPins(channelId)
        // What changed in the held messages while the socket was down.
        if (before.ready && channelId !== null && before.messages[channelId]?.loaded) {
          void refreshHeld(channelId, before.messages[channelId].items).catch(() => undefined)
        }
      },
    }
  }, [stateRef])

  // The open channel changed: its pins, if the panel is open; a reply or edit elsewhere is let go.
  const activeChannelId = stateRef.current.activeChannelId
  useEffect(() => {
    if (pinsOpen) actions.reloadPins()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChannelId])

  useEffect(() => () => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
  }, [])

  // A reply whose target was deleted meanwhile is let go (the server would refuse it).
  const replyGone = reply !== null && stateRef.current.deleted[reply.message.id] === true
  useEffect(() => {
    if (replyGone) {
      setReply(null)
      actions.showNotice('Yanıtladığın mesaj silindi.')
    }
  }, [replyGone, actions])

  const shownReply = reply && reply.channelId === activeChannelId ? reply.message : null
  const shownEditing = editing && editing.channelId === activeChannelId ? editing : null
  return { editing: shownEditing, reply: shownReply, notice, pinsOpen, pinsAnchor, jump, composerFocus, actions }
}

/** For Session: the local quote of a message about to be sent as a reply. */
export function replyFields(reply: Message | null): Pick<Message, 'reply_to'> {
  return reply ? { reply_to: quoteFrom(reply) } : {}
}
