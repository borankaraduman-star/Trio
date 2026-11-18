import { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore } from 'react'
import { api, ApiError, type Auth } from '../api'
import { typingLabel } from '../lib/grouping'
import { TrioSocket } from '../socket'
import {
  channelMessages,
  createInitialState,
  loadActiveChannel,
  loadLastRead,
  reducer,
  saveActiveChannel,
  saveLastRead,
  totalUnread,
  typingNames,
  type UiMessage,
} from '../store'
import type { ChannelKind, ServerEvent } from '../types'
import { VoiceEngine } from '../voice'
import { Composer } from './Composer'
import { HashIcon, MenuIcon } from './icons'
import { RemoteAudio, Stage } from './Media'
import { MemberList } from './MemberList'
import { MessageList } from './MessageList'
import { Sidebar } from './Sidebar'

const PAGE_SIZE = 50
const TYPING_SEND_INTERVAL_MS = 3000
const SEND_TIMEOUT_MS = 10000
const LOAD_RETRY_COOLDOWN_MS = 3000

function isViewing(): boolean {
  return document.visibilityState === 'visible'
}

function newNonce(): string {
  // randomUUID exists only in secure contexts; plain http on a LAN is not one.
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function notificationsAskable(): boolean {
  return typeof Notification !== 'undefined' && Notification.permission === 'default'
}

export function Session({ auth, onLogout }: { auth: Auth; onLogout: () => void }) {
  const { token } = auth
  const [state, dispatch] = useReducer(
    reducer,
    { me: auth.user, activeChannelId: loadActiveChannel(), lastRead: loadLastRead() },
    createInitialState,
  )
  const stateRef = useRef(state)
  stateRef.current = state

  const [socket] = useState(() => new TrioSocket(token))
  const [engine] = useState(
    () =>
      new VoiceEngine({
        myId: auth.user.id,
        send: (event) => socket.send(event),
        fetchIce: () => api.ice(token),
      }),
  )
  const voice = useSyncExternalStore(engine.subscribe, engine.getSnapshot)

  const [drawerOpen, setDrawerOpen] = useState(false)
  const [canAskNotifications, setCanAskNotifications] = useState(notificationsAskable)
  const [, setClock] = useState(0)

  const loading = useRef(new Set<number>())
  const lastLoadFailure = useRef(0)
  const lastTypingSent = useRef<Record<number, number>>({})

  // --- loading messages ------------------------------------------------------

  const loadLatest = useCallback(
    async (channelId: number) => {
      if (loading.current.has(channelId)) return
      loading.current.add(channelId)
      try {
        const page = await api.messages(token, channelId, { limit: PAGE_SIZE })
        dispatch({
          type: 'messages.loaded',
          channelId,
          messages: page.messages,
          hasMore: page.has_more,
          mode: 'replace',
          viewing: isViewing(),
        })
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) onLogout()
        else dispatch({ type: 'messages.load-failed', channelId })
      } finally {
        loading.current.delete(channelId)
      }
    },
    [token, onLogout],
  )

  const loadOlder = useCallback(async () => {
    const current = stateRef.current
    const channelId = current.activeChannelId
    if (channelId === null) return
    const channel = channelMessages(current, channelId)
    const oldest = channel.items.find((item) => item.status === 'sent')
    if (!channel.loaded || !channel.hasMore || channel.loadingOlder || !oldest) return
    if (Date.now() - lastLoadFailure.current < LOAD_RETRY_COOLDOWN_MS) return

    dispatch({ type: 'messages.loading-older', channelId })
    try {
      const page = await api.messages(token, channelId, { before: oldest.id, limit: PAGE_SIZE })
      dispatch({
        type: 'messages.loaded',
        channelId,
        messages: page.messages,
        hasMore: page.has_more,
        mode: 'prepend',
        viewing: isViewing(),
      })
    } catch {
      lastLoadFailure.current = Date.now()
      dispatch({ type: 'messages.load-failed', channelId })
    }
  }, [token])

  /** Learn each other channel's newest message id, for the unread dots. */
  const probeUnread = useCallback(
    (channelIds: number[]) => {
      for (const channelId of channelIds) {
        api
          .messages(token, channelId, { limit: 1 })
          .then((page) => {
            const newest = page.messages[page.messages.length - 1]
            if (newest) dispatch({ type: 'latest.loaded', channelId, latestId: newest.id })
          })
          .catch(() => undefined)
      }
    },
    [token],
  )

  // --- the connection ----------------------------------------------------------

  useEffect(() => {
    const onEvent = (event: ServerEvent) => {
      const before = stateRef.current
      dispatch({ type: 'server', event, now: Date.now(), viewing: isViewing() })
      engine.handleEvent(event)

      if (event.type === 'ready') {
        const textIds = event.channels.filter((c) => c.kind === 'text').map((c) => c.id)
        const active =
          before.activeChannelId !== null && textIds.includes(before.activeChannelId)
            ? before.activeChannelId
            : (textIds[0] ?? null)
        // After a reconnect the open channel may have missed messages.
        if (before.ready && active !== null) void loadLatest(active)
        probeUnread(textIds.filter((id) => id !== active))
        engine.handleReady()
      } else if (event.type === 'message.new') {
        const { message } = event
        if (
          message.author.id !== before.me.id &&
          document.hidden &&
          typeof Notification !== 'undefined' &&
          Notification.permission === 'granted'
        ) {
          const channel = before.channels.find((c) => c.id === message.channel_id)
          try {
            new Notification(`${message.author.name} — #${channel?.name ?? ''}`, {
              body: message.content.slice(0, 200),
              tag: `trio-${message.channel_id}`,
            })
          } catch {
            // Some browsers only allow notifications from a service worker.
          }
        }
      }
    }

    socket.handlers = {
      onEvent,
      onDown: () => {
        dispatch({ type: 'connection.down' })
        engine.handleDisconnected()
      },
      onUnauthorized: onLogout,
    }
    socket.connect()

    api.me(token).catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 401) onLogout()
    })

    return () => {
      socket.handlers = {}
      socket.close()
      engine.destroy()
    }
  }, [socket, engine, token, onLogout, loadLatest, probeUnread])

  // --- effects that follow the state ---------------------------------------------

  const activeChannelId = state.activeChannelId
  const active = channelMessages(state, activeChannelId)

  useEffect(() => {
    if (state.ready && activeChannelId !== null && !active.loaded && !active.error) {
      void loadLatest(activeChannelId)
    }
  }, [state.ready, activeChannelId, active.loaded, active.error, loadLatest])

  useEffect(() => {
    if (activeChannelId !== null) saveActiveChannel(activeChannelId)
  }, [activeChannelId])

  useEffect(() => {
    saveLastRead(state.lastRead)
  }, [state.lastRead])

  const unreadTotal = totalUnread(state)
  useEffect(() => {
    document.title = unreadTotal > 0 ? `(${unreadTotal}) Trio` : 'Trio'
    return () => {
      document.title = 'Trio'
    }
  }, [unreadTotal])

  useEffect(() => {
    const onVisibility = () => {
      if (isViewing()) dispatch({ type: 'viewing' })
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', onVisibility)
    }
  }, [])

  // Typing lines expire on their own; tick only while one is showing.
  const typing = typingNames(state, activeChannelId, Date.now())
  const someoneTyping = Object.values(state.typing).some((users) => Object.keys(users).length > 0)
  useEffect(() => {
    if (!someoneTyping) return
    const timer = setInterval(() => {
      dispatch({ type: 'typing.prune', now: Date.now() })
      setClock((value) => value + 1)
    }, 1000)
    return () => clearInterval(timer)
  }, [someoneTyping])

  // --- actions -------------------------------------------------------------------

  const transmit = useCallback(
    (channelId: number, content: string, nonce: string) => {
      if (!socket.send({ type: 'message.send', channel_id: channelId, content, nonce })) {
        dispatch({ type: 'message.failed', channelId, nonce })
        return
      }
      // The server answers a refused message with a bare `error` frame that
      // names no nonce, so an unconfirmed row is given up on after a while.
      setTimeout(() => dispatch({ type: 'message.failed', channelId, nonce }), SEND_TIMEOUT_MS)
    },
    [socket],
  )

  const sendMessage = useCallback(
    (content: string) => {
      const current = stateRef.current
      const channelId = current.activeChannelId
      if (channelId === null) return
      const nonce = newNonce()
      dispatch({
        type: 'message.optimistic',
        message: {
          id: -1,
          channel_id: channelId,
          author: current.me,
          content,
          created_at: new Date().toISOString(),
          key: nonce,
          nonce,
          status: 'pending',
        },
      })
      delete lastTypingSent.current[channelId]
      transmit(channelId, content, nonce)
    },
    [transmit],
  )

  const retryMessage = useCallback(
    (message: UiMessage) => {
      if (!message.nonce) return
      dispatch({ type: 'message.retry', channelId: message.channel_id, nonce: message.nonce })
      transmit(message.channel_id, message.content, message.nonce)
    },
    [transmit],
  )

  const sendTyping = useCallback(() => {
    const channelId = stateRef.current.activeChannelId
    if (channelId === null) return
    const now = Date.now()
    if (now - (lastTypingSent.current[channelId] ?? 0) < TYPING_SEND_INTERVAL_MS) return
    lastTypingSent.current[channelId] = now
    socket.send({ type: 'typing', channel_id: channelId })
  }, [socket])

  const createChannel = useCallback(
    async (name: string, kind: ChannelKind): Promise<string | null> => {
      try {
        const { channel } = await api.createChannel(token, name, kind)
        // The broadcast brings it too; whichever arrives second is ignored.
        dispatch({
          type: 'server',
          event: { type: 'channel.new', channel },
          now: Date.now(),
          viewing: isViewing(),
        })
        if (channel.kind === 'text') dispatch({ type: 'channel.select', channelId: channel.id })
        return null
      } catch (error) {
        if (error instanceof ApiError && error.code === 'INVALID_CHANNEL') {
          return 'Kanal adı 1–32 karakter olmalı.'
        }
        return 'Kanal oluşturulamadı.'
      }
    },
    [token],
  )

  const askNotifications = useCallback(() => {
    if (typeof Notification === 'undefined') return
    try {
      const result = Notification.requestPermission(() => setCanAskNotifications(notificationsAskable()))
      if (result && typeof result.then === 'function') {
        void result.then(() => setCanAskNotifications(notificationsAskable())).catch(() => undefined)
      }
    } catch {
      setCanAskNotifications(false)
    }
  }, [])

  const selectChannel = useCallback((channelId: number) => {
    dispatch({ type: 'channel.select', channelId })
    setDrawerOpen(false)
  }, [])

  const joinVoice = useCallback(
    (channelId: number) => {
      void engine.join(channelId)
    },
    [engine],
  )

  // --- render --------------------------------------------------------------------

  const activeChannel = state.channels.find((channel) => channel.id === activeChannelId)
  const nameOf = (userId: number) => state.users[userId]?.name ?? `#${userId}`

  return (
    <div className="app">
      <Sidebar
        open={drawerOpen}
        me={state.me}
        users={state.users}
        channels={state.channels}
        voiceMembers={state.voice}
        activeChannelId={activeChannelId}
        unread={state.unread}
        connection={state.connection}
        voice={voice}
        canAskNotifications={canAskNotifications}
        onSelectChannel={selectChannel}
        onJoinVoice={joinVoice}
        onCreateChannel={createChannel}
        onToggleMute={() => engine.toggleMute()}
        onToggleDeafen={() => engine.toggleDeafen()}
        onToggleScreen={() => void engine.toggleScreen()}
        onHangup={() => engine.leave()}
        onDismissVoiceError={() => engine.clearError()}
        onAskNotifications={askNotifications}
        onLogout={onLogout}
      />
      {drawerOpen && (
        <button
          type="button"
          className="backdrop"
          aria-label="Menüyü kapat"
          onClick={() => setDrawerOpen(false)}
        />
      )}

      <main className="main">
        <header className="main-header">
          <button
            type="button"
            className="icon-button drawer-toggle"
            data-testid="btn-drawer"
            aria-label="Kanalları aç"
            onClick={() => setDrawerOpen(true)}
          >
            <MenuIcon />
            {unreadTotal > 0 && <span className="unread-dot" />}
          </button>
          <HashIcon size={20} />
          <h1>{activeChannel?.name ?? 'Trio'}</h1>
        </header>

        {state.connection !== 'open' && (
          <div className="banner" role="status">
            {state.ready ? 'Bağlantı koptu, yeniden bağlanılıyor…' : 'Sunucuya bağlanılıyor…'}
          </div>
        )}

        <Stage
          remote={voice.remoteVideo}
          local={voice.localScreen}
          deafened={voice.deafened}
          nameOf={nameOf}
        />

        {activeChannel ? (
          <>
            <MessageList
              key={activeChannel.id}
              channel={active}
              myId={state.me.id}
              onLoadOlder={loadOlder}
              onRetryLoad={() => void loadLatest(activeChannel.id)}
              onRetry={retryMessage}
            />
            <div className="typing-line" data-testid="typing" aria-live="polite">
              {typingLabel(typing)}
            </div>
            <Composer
              key={`composer-${activeChannel.id}`}
              channelName={activeChannel.name}
              onSend={sendMessage}
              onTyping={sendTyping}
            />
          </>
        ) : (
          <div className="empty">
            {state.ready ? 'Henüz metin kanalı yok. Soldan bir kanal ekle.' : 'Yükleniyor…'}
          </div>
        )}
      </main>

      <MemberList users={state.users} />

      <div hidden>
        {voice.remoteAudio.map((media) => (
          <RemoteAudio key={media.userId} media={media} muted={voice.deafened} />
        ))}
      </div>
    </div>
  )
}
