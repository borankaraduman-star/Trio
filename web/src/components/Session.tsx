import { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore } from 'react'
import { api, ApiError, loadInviteCode, type Auth, type LinkCode } from '../api'
import { newerBuildIsLive } from '../lib/buildCheck'
import { messageFamilyBusy, reloadBlocker } from '../lib/reloadGuard'
import { inviteLinkUrl } from '../lib/inviteLink'
import { sendErrorMessage } from '../lib/attachments'
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
  voiceChannelOf,
  type UiMessage,
} from '../store'
import type { ChannelKind, ClientEvent, ServerEvent } from '../types'
import { VoiceEngine } from '../voice'
import { Composer } from './Composer'
import { HashIcon, MenuIcon } from './icons'
import { RemoteAudio } from './Media'
import { CallStage } from './CallStage'
import { SettingsDialog } from './SettingsDialog'
import { BackupDot } from './owner/BackupDot'
import { UploadIcon } from './icons2'
import { settingsStore } from '../settings'
import { desktopBridge } from '../ptt'
import { usePtt } from '../usePtt'
import { useDeviceFallback } from '../useDevices'
import { useAttachments } from '../useAttachments'
import { useFileDrop } from '../useFileDrop'
import type { Attachment } from '../types'
import { MemberList } from './MemberList'
import { MessageList } from './MessageList'
import { SendTimers } from '../lib/sendTimers'
import { isViewing, onViewingChange } from '../lib/viewing'
import { fetchCovering, newestConfirmedId } from '../lib/catchUp'
import { Sidebar } from './Sidebar'
import { LogoutDialog } from './LogoutDialog'
import { CallAlerts } from '../callAlerts'
import { RingBand } from './RingBand'
import { WhatsNewCard } from './WhatsNewCard'
import { useIdentity } from '../useIdentity'
import { pageTitle } from '../lib/title'
import { replyFields, useMessageFamily } from '../useMessageFamily'
import { PinsButton } from './message/PinsButton'
import { ReplyBar } from './message/ReplyBar'
import { FamilyNotice } from './message/FamilyNotice'
import { activityStore, GameForwarder, gameShare, gameStatusBridge } from '../gameActivity'
import { notifyHub } from '../lib/notify/notifyHub'
import { NotifyBridge } from './notify/NotifyBridge'

const PAGE_SIZE = 50
const TYPING_SEND_INTERVAL_MS = 3000
const SEND_TIMEOUT_MS = 10000
const LOAD_RETRY_COOLDOWN_MS = 3000


function newNonce(): string {
  // randomUUID exists only in secure contexts; plain http on a LAN is not one.
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function notificationsAskable(): boolean {
  return typeof Notification !== 'undefined' && Notification.permission === 'default'
}

/** Codes of a refused `message.send` (a bare `error` frame naming no nonce). */
const SEND_REFUSALS = new Set(['INVALID_ATTACHMENT', 'INVALID_MESSAGE', 'BAD_REQUEST', 'STORAGE_FULL', 'INVALID_REPLY'])

export function Session({
  auth,
  onSignedOut,
  onSessionEnded,
}: {
  auth: Auth
  /** After this device signed itself out (the server was told). */
  onSignedOut: () => void
  /** The server no longer accepts the token (401 / close 4401). */
  onSessionEnded: () => void
}) {
  const onLogout = onSessionEnded
  const { token } = auth
  const [state, dispatch] = useReducer(
    reducer,
    { me: auth.user, activeChannelId: loadActiveChannel(), lastRead: loadLastRead() },
    createInitialState,
  )
  const stateRef = useRef(state)
  stateRef.current = state
  const identity = useIdentity({ token, me: state.me, server: state.server, ready: state.ready, dispatch, onLogout })

  const [socket] = useState(() => new TrioSocket(token))
  // CONTRACT-V5: the desktop app's game status, forwarded over this socket.
  const [gameForwarder] = useState(
    () =>
      new GameForwarder(
        (frame) => socket.send(frame as unknown as ClientEvent),
        gameStatusBridge(),
        gameShare,
        () => stateRef.current.me.id,
      ),
  )
  const [engine] = useState(
    () =>
      new VoiceEngine({
        myId: auth.user.id,
        send: (event) => socket.send(event),
        fetchIce: () => api.ice(token),
        prefs: () => settingsStore.getSnapshot(),
      }),
  )
  const voice = useSyncExternalStore(engine.subscribe, engine.getSnapshot)
  useDeviceFallback(voice.status)
  // V4 A4: rings, cue sounds, "X ses odasına girdi" (callAlerts.ts).
  const namesRef = useRef({ user: (id: number) => `#${id}`, channel: (id: number) => `#${id}` })
  const [alerts] = useState(
    () =>
      new CallAlerts({
        myId: auth.user.id,
        send: (event) => socket.send(event),
        settings: () => settingsStore.getSnapshot(),
        viewing: () => isViewing(),
        myVoiceChannel: () => engine.getSnapshot().channelId,
        inCall: () => engine.getSnapshot().status === 'connected',
        deafened: () => engine.getSnapshot().deafened,
        nameOf: (id) => namesRef.current.user(id),
        channelName: (id) => namesRef.current.channel(id),
        // V6: through the service worker, with the push's tags (lib/notify/notifyHub.ts).
        notify: (title, body, tag, silent) => {
          const voice = /^trio-voice-(\d+)$/.exec(tag)
          void notifyHub.local(voice ? 'voice' : 'ring', voice ? Number(voice[1]) : null, title, body, { silent })
        },
      }),
  )
  const calls = useSyncExternalStore(alerts.subscribe, alerts.getSnapshot)
  // A1: a call waits for the socket (kept, or to be rejoined): reconnect fast.
  const callWaiting = voice.status !== 'idle'
  useEffect(() => socket.setUrgent(callWaiting), [socket, callWaiting])

  // --- v2: settings, push-to-talk, devices, attachments ------------------------
  const settings = useSyncExternalStore(settingsStore.subscribe, settingsStore.getSnapshot)
  const [settingsOpen, setSettingsOpen] = useState(false)
  /** Settings opened from the sign-out dialog: make a device code straight away. */
  const [settingsCode, setSettingsCode] = useState(false)
  const closeSettings = useCallback(() => {
    setSettingsOpen(false)
    setSettingsCode(false)
  }, [])
  const [logoutOpen, setLogoutOpen] = useState(false)
  // The invite code this device joined with, kept to share as a link.
  const [invite] = useState(loadInviteCode)
  const [signingOut, setSigningOut] = useState(false)
  /** The server kept refusing the socket with 4429. */
  const [tooMany, setTooMany] = useState(false)
  /** Why the last message could not be stored (STORAGE_FULL…), or null. */
  const [sendNotice, setSendNotice] = useState<string | null>(null)
  const setPttOpen = useCallback((open: boolean) => engine.setPttOpen(open), [engine])
  usePtt(settings.inputMode, settings.pttKey, setPttOpen)
  const applied = useRef({
    mic: settings.micDeviceId,
    camera: settings.cameraDeviceId,
    noise: settings.noiseSuppression,
  })
  useEffect(() => {
    // Live changes, including while in voice; the first values are read at join.
    const last = applied.current
    if (settings.micDeviceId !== last.mic) void engine.setMicDevice(settings.micDeviceId)
    if (settings.cameraDeviceId !== last.camera) void engine.setCameraDevice(settings.cameraDeviceId)
    if (settings.noiseSuppression !== last.noise) void engine.setNoiseSuppression(settings.noiseSuppression)
    applied.current = {
      mic: settings.micDeviceId,
      camera: settings.cameraDeviceId,
      noise: settings.noiseSuppression,
    }
  }, [engine, settings.micDeviceId, settings.cameraDeviceId, settings.noiseSuppression])
  const attachments = useAttachments(token, onLogout)
  /** The nonce last handed to the socket, for an `error` frame that names none. */
  const lastSent = useRef<{ channelId: number; nonce: string; at: number } | null>(null)
  const [sendTimers] = useState(() => new SendTimers())
  // v4: edit, delete, reactions, replies, pins (useMessageFamily.ts).
  const family = useMessageFamily({ token, dispatch, stateRef, onLogout, onSendTimerDone: (nonce) => sendTimers.clear(nonce) })
  const familyActions = family.actions
  /** v4: the family as last rendered, and whether a message's overlay is open (reload guard). */
  const familyRef = useRef(family)
  familyRef.current = family
  const familyOverlayOpen = useRef(false)
  const onFamilyOverlay = useCallback((open: boolean) => {
    familyOverlayOpen.current = open
  }, [])
  const replyRef = useRef(family.reply)
  replyRef.current = family.reply

  const [drawerOpen, setDrawerOpen] = useState(false)
  const [canAskNotifications, setCanAskNotifications] = useState(notificationsAskable)
  const [, setClock] = useState(0)

  const loading = useRef(new Set<number>())
  const lastLoadFailure = useRef(0)
  const lastTypingSent = useRef<Record<number, number>>({})
  /** The open channel's list is scrolled to its newest message (reported by MessageList). */
  const atBottom = useRef(true)

  // --- what a reload onto a new build would lose (lib/reloadGuard.ts) ----------
  /** The composer holds unsent text (reported by Composer). */
  const draft = useRef(false)
  const dialogs = useRef(false)
  /** V4 A3: the connection test is mounted (it measures while it is). */
  const connectionTestActive = useRef(false)
  dialogs.current = settingsOpen || logoutOpen || signingOut
  const anyPendingFiles = attachments.anyPending
  // A ref, so the connection effect reads it without depending on it (a new
  // dependency there would reconnect the socket).
  const reloadState = useRef(() => ({
    inCall: engine.getSnapshot().status !== 'idle',
    dialogOpen: dialogs.current,
    pendingFiles: anyPendingFiles(),
    draft: draft.current,
    unsentMessages: Object.values(stateRef.current.messages).some((channel) =>
      channel.items.some((item) => item.status !== 'sent'),
    ),
    profileEdit: identity.editing(),
    messageAction: messageFamilyBusy({
      editing: familyRef.current.editing,
      reply: familyRef.current.reply,
      pinsOpen: familyRef.current.pinsOpen,
      overlayOpen: familyOverlayOpen.current,
    }),
    ringing: alerts.getSnapshot().incoming !== null,
    connectionTest: connectionTestActive.current,
  }))
  const busyForNews = useCallback(() => reloadBlocker(reloadState.current()) !== null, [])

  // --- loading messages ------------------------------------------------------

  const loadLatest = useCallback(
    async (channelId: number, options: { jump?: boolean } = {}) => {
      if (loading.current.has(channelId)) return
      loading.current.add(channelId)
      try {
        // Far enough back to meet what is held, so it merges (lib/catchUp.ts).
        const held = channelMessages(stateRef.current, channelId)
        const newestHeld = held.loaded && !options.jump ? newestConfirmedId(held.items) : null
        const page = await fetchCovering(
          (before) => api.messages(token, channelId, before === undefined ? { limit: PAGE_SIZE } : { before, limit: PAGE_SIZE }),
          newestHeld,
        )
        const reading = stateRef.current.activeChannelId === channelId && !atBottom.current
        dispatch({
          type: 'messages.loaded',
          channelId,
          messages: page.messages,
          hasMore: page.hasMore,
          // A gap under a reader up in history: leave them where they are.
          mode: !page.covers && reading ? 'behind' : 'replace',
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
      activityStore.handleEvent(event as unknown as { type: string } & Record<string, unknown>)
      if (event.type === 'ready') gameForwarder.onReady()
      if (event.type === 'ready') notifyHub.connected()
      engine.handleEvent(event)
      alerts.handleEvent(event, (channelId) => (before.voice[channelId] ?? []).map((p) => p.user_id))
      familyActions.onEvent(event, before)
      if (event.type === 'message.new' && event.nonce !== undefined) sendTimers.clear(event.nonce)

      if (event.type === 'user.removed') {
        // The voice room forgets them too; their messages stay as they are.
        const channelId = voiceChannelOf(before, event.user_id)
        if (channelId !== null) engine.handleEvent({ type: 'voice.left', channel_id: channelId, user_id: event.user_id })
      }

      if (event.type === 'error' && SEND_REFUSALS.has(event.code)) {
        // v2: a refused send answers with a bare error frame; fail the message just sent.
        const last = lastSent.current
        if (last && Date.now() - last.at < SEND_TIMEOUT_MS) {
          lastSent.current = null
          dispatch({ type: 'message.failed', channelId: last.channelId, nonce: last.nonce })
          setSendNotice(
            sendErrorMessage(event.code) ??
              (event.code === 'INVALID_REPLY' ? 'Yanıtladığın mesaj artık yok; mesaj gönderilmedi.' : null),
          )
        }
      }

      if (event.type === 'ready') {
        const textIds = event.channels.filter((c) => c.kind === 'text').map((c) => c.id)
        const active =
          before.activeChannelId !== null && textIds.includes(before.activeChannelId)
            ? before.activeChannelId
            : (textIds[0] ?? null)
        // After a reconnect the open channel may have missed messages.
        if (before.ready && active !== null) void loadLatest(active)
        // A reconnect is usually a deploy: if a newer client is live, load it,
        // unless that would cost something (a call, a device code on screen,
        // files, a draft, an unsent message); the next reconnect asks again.
        if (before.ready) {
          void newerBuildIsLive().then((newer) => {
            if (newer && reloadBlocker(reloadState.current()) === null) window.location.reload()
          })
        }
        setTooMany(false)
        probeUnread(textIds.filter((id) => id !== active))
        engine.handleReady()
      } else if (event.type === 'message.new') {
        const { message } = event
        // V6: one path with the pushes (skipped when this device gets them pushed).
        const channel = before.channels.find((c) => c.id === message.channel_id)
        notifyHub.localMessage(message, channel?.name ?? '')
      }
    }

    socket.handlers = {
      onEvent,
      onDown: () => {
        dispatch({ type: 'connection.down' })
        sendTimers.clearAll()
        engine.handleDisconnected()
        // Before the socket schedules its retry: a kept call wants it soon.
        socket.setUrgent(engine.getSnapshot().status !== 'idle')
      },
      onUnauthorized: onLogout,
      onTooMany: (streak) => setTooMany(streak > 0),
    }
    socket.connect()
    gameForwarder.start()

    api.me(token).catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 401) onLogout()
    })

    return () => {
      gameForwarder.stop()
      activityStore.reset()
      socket.handlers = {}
      socket.close()
      engine.destroy()
      sendTimers.clearAll()
    }
  }, [socket, engine, alerts, sendTimers, token, onLogout, loadLatest, probeUnread, gameForwarder])

  useEffect(() => () => alerts.destroy(), [alerts])
  useEffect(() => {
    alerts.refreshPrefs()
  }, [alerts, settings.cuesEnabled, settings.cueVolume, settings.doNotDisturb, settings.outputDeviceId, voice.deafened])

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
    atBottom.current = true
  }, [activeChannelId])

  useEffect(() => {
    saveLastRead(state.lastRead)
  }, [state.lastRead])

  const unreadTotal = totalUnread(state)
  useEffect(() => {
    document.title = pageTitle(unreadTotal, state.server.name)
    return () => {
      document.title = 'Trio'
    }
  }, [unreadTotal, state.server.name])

  useEffect(() => {
    const onVisibility = () => {
      if (isViewing()) dispatch({ type: 'viewing' })
    }
    return onViewingChange(onVisibility)
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
    (channelId: number, content: string, nonce: string, sentAttachments: readonly Attachment[] = [], replyTo?: number) => {
      const ids = sentAttachments.map((attachment) => attachment.id)
      if (
        !socket.send({
          type: 'message.send',
          channel_id: channelId,
          content,
          nonce,
          ...(ids.length > 0 ? { attachment_ids: ids } : {}),
          ...(replyTo !== undefined ? { reply_to: replyTo } : {}),
        })
      ) {
        sendTimers.clear(nonce)
        dispatch({ type: 'message.failed', channelId, nonce })
        return
      }
      lastSent.current = { channelId, nonce, at: Date.now() }
      // The server answers a refused message with a bare `error` frame that
      // names no nonce, so an unconfirmed row is given up on after a while.
      // One timer per nonce: a retry restarts it (lib/sendTimers.ts).
      sendTimers.start(nonce, SEND_TIMEOUT_MS, () => dispatch({ type: 'message.failed', channelId, nonce }))
    },
    [socket, sendTimers],
  )

  const sendMessage = useCallback(
    (content: string) => {
      const current = stateRef.current
      const channelId = current.activeChannelId
      if (channelId === null) return
      if (attachments.failed(channelId)) return
      if (channelMessages(current, channelId).behind) void loadLatest(channelId, { jump: true })
      const sentAttachments = attachments.take(channelId)
      if (content === '' && sentAttachments.length === 0) return
      const nonce = newNonce()
      const reply = replyRef.current?.channel_id === channelId ? replyRef.current : null
      dispatch({
        type: 'message.optimistic',
        message: {
          id: -1,
          channel_id: channelId,
          author: current.me,
          content,
          created_at: new Date().toISOString(),
          attachments: sentAttachments,
          ...replyFields(reply),
          key: nonce,
          nonce,
          status: 'pending',
        },
      })
      delete lastTypingSent.current[channelId]
      setSendNotice(null)
      if (reply) familyActions.cancelReply()
      transmit(channelId, content, nonce, sentAttachments, reply?.id)
    },
    [transmit, attachments, loadLatest, familyActions],
  )

  const retryMessage = useCallback(
    (message: UiMessage) => {
      if (!message.nonce) return
      // The same nonce: a server that de-duplicates answers with the original message.
      dispatch({ type: 'message.retry', channelId: message.channel_id, nonce: message.nonce, at: Date.now() })
      transmit(message.channel_id, message.content, message.nonce, message.attachments ?? [], message.reply_to?.id)
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
    // V6: asks (in the click) and subscribes this device to pushes when it can.
    void notifyHub.enableHere().finally(() => setCanAskNotifications(notificationsAskable()))
  }, [])

  const selectChannel = useCallback((channelId: number) => {
    dispatch({ type: 'channel.select', channelId })
    setDrawerOpen(false)
  }, [])

  const joinVoice = useCallback(
    (channelId: number) => {
      alerts.selfJoined()
      void engine.join(channelId)
    },
    [engine, alerts],
  )

  /** The user's own mute/deafen click, with its cue (V4 A4). */
  const selfToggle = useCallback(
    (which: 'mute' | 'deafen') => {
      const before = engine.getSnapshot()
      if (which === 'mute') engine.toggleMute()
      else engine.toggleDeafen()
      const after = engine.getSnapshot()
      alerts.selfChanged(before, after)
    },
    [engine, alerts],
  )

  /** "Add a device" (CONTRACT-V3 §2); a 401 here means this session is over. */
  const createLinkCode = useCallback(async (): Promise<LinkCode> => {
    try {
      return await api.createLinkCode(token)
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onLogout()
      throw error
    }
  }, [token, onLogout])

  /**
   * Sign THIS device out: our own socket is closed first (so its 4401 is not
   * mistaken for a session ended elsewhere), then the server forgets the
   * token, then local state goes. A 401 or no answer at all still clears it.
   */
  const signOut = useCallback(async () => {
    setSigningOut(true)
    socket.handlers = {}
    socket.close()
    engine.leave()
    try {
      await api.logout(token)
    } catch {
      // Already signed out (401), or unreachable: the device forgets the token either way.
    }
    onSignedOut()
  }, [socket, engine, token, onSignedOut])

  // --- render --------------------------------------------------------------------

  const activeChannel = state.channels.find((channel) => channel.id === activeChannelId)
  const nameOf = (userId: number) => state.users[userId]?.name ?? `#${userId}`
  namesRef.current = {
    user: nameOf,
    channel: (channelId) => state.channels.find((c) => c.id === channelId)?.name ?? `#${channelId}`,
  }
  const ringChannelId = voice.status === 'connected' ? voice.channelId : null
  const familyNameOf = (userId: number) => state.users[userId]?.name ?? 'eski üye'
  const familyUserOf = (userId: number) => state.users[userId]
  const pendingHere = attachments.pending(activeChannelId)
  const addFiles = (files: File[]) => {
    if (activeChannelId !== null) attachments.add(activeChannelId, files)
  }
  const drop = useFileDrop(activeChannel ? addFiles : null)

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
        onToggleMute={() => selfToggle('mute')}
        onToggleDeafen={() => selfToggle('deafen')}
        ring={
          ringChannelId === null
            ? undefined
            : {
                lastRingAt: calls.lastRingAt,
                disabled: voice.signalling === 'down',
                error: calls.ringError,
                onRing: () => alerts.ring(ringChannelId),
              }
        }
        onToggleScreen={() => void engine.toggleScreen()}
        onToggleCamera={() => void engine.toggleCamera()}
        onOpenSettings={() => setSettingsOpen(true)}
        onHangup={() => engine.leave()}
        onDismissVoiceError={() => engine.clearError()}
        onRetryMic={() => void engine.retryMic()}
        onAskNotifications={askNotifications}
        onLogout={() => setLogoutOpen(true)}
        server={state.server}
      />
      {drawerOpen && (
        <button
          type="button"
          className="backdrop"
          aria-label="Menüyü kapat"
          onClick={() => setDrawerOpen(false)}
        />
      )}

      <main className="main" {...drop.handlers}>
        {drop.dragging && (
          <div className="drop-overlay" data-testid="drop-overlay" aria-hidden="true">
            <div>
              <UploadIcon size={40} />
              <strong>Dosyaları buraya bırak</strong>
              <span>#{activeChannel?.name ?? ''} kanalına eklenecek</span>
            </div>
          </div>
        )}
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
            <BackupDot />
          </button>
          <HashIcon size={20} />
          <h1>{activeChannel?.name ?? 'Trio'}</h1>
          {activeChannel && (
            <PinsButton
              family={family}
              pins={state.pins[activeChannel.id]}
              channelName={activeChannel.name}
              nameOf={familyNameOf}
              users={state.users}
            />
          )}
        </header>

        {(state.connection !== 'open' || voice.signalling === 'down') && (
          <div
            className={tooMany ? 'banner warn' : voice.signalling === 'down' ? 'banner voice-kept' : 'banner'}
            role="status"
            data-testid="connection-banner"
            data-voice-kept={voice.signalling === 'down'}
          >
            {tooMany
              ? 'Çok fazla sekme ya da cihaz açık (bir hesapta en fazla 10 bağlantı). Kullanmadığın sekmeleri kapat; bağlantı kendiliğinden yeniden denenecek.'
              : voice.signalling === 'down'
                ? 'Sunucuya yeniden bağlanılıyor… ses sürüyor'
                : state.ready
                  ? 'Bağlantı koptu, yeniden bağlanılıyor…'
                  : 'Sunucuya bağlanılıyor…'}
          </div>
        )}

        {calls.incoming && (
          <RingBand
            ring={calls.incoming}
            fromName={nameOf(calls.incoming.from)}
            channelName={namesRef.current.channel(calls.incoming.channelId)}
            silent={settings.doNotDisturb || voice.deafened}
            onJoin={() => joinVoice(calls.incoming?.channelId ?? 0)}
            onDismiss={() => alerts.dismiss()}
          />
        )}

        <CallStage
          remoteScreens={voice.remoteVideo}
          remoteCameras={voice.remoteCamera}
          localScreen={voice.localScreen}
          localCamera={voice.localCamera}
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
              onJumpToLatest={() => void loadLatest(activeChannel.id, { jump: true })}
              onAtBottomChange={(value) => (atBottom.current = value)}
              onRetry={retryMessage}
              isMember={state.ready ? (userId) => userId in state.users : undefined}
              users={state.users}
              family={{
                nameOf: familyNameOf,
                userOf: familyUserOf,
                editingId: family.editing?.messageId ?? null,
                jump: family.jump,
                onJumpDone: familyActions.jumpDone,
                onOverlayChange: onFamilyOverlay,
                actions: familyActions,
              }}
            />
            <FamilyNotice text={family.notice} onDismiss={familyActions.dismissNotice} />
            <div className="typing-line" data-testid="typing" aria-live="polite">
              {typingLabel(typing)}
            </div>
            <Composer
              key={`composer-${activeChannel.id}`}
              channelName={activeChannel.name}
              onSend={sendMessage}
              onTyping={sendTyping}
              onDraftChange={(value) => {
                draft.current = value
              }}
              replyBar={family.reply && <ReplyBar
                    message={family.reply}
                    authorName={state.users[family.reply.author.id]?.name}
                    onCancel={familyActions.cancelReply}
                  />}
              onEscape={() => {
                if (!family.reply) return false
                familyActions.cancelReply()
                return true
              }}
              onEditLast={familyActions.editLast}
              focusSignal={family.composerFocus}
              attachments={{
                items: pendingHere,
                files: attachments.files,
                ready: pendingHere.some((item) => item.status === 'done'),
                uploading: attachments.uploading(activeChannelId),
                failed: attachments.failed(activeChannelId),
                notice: sendNotice ?? attachments.notice,
                onAdd: addFiles,
                onRemove: attachments.remove,
                onDismissNotice: () => {
                  setSendNotice(null)
                  attachments.dismissNotice()
                },
              }}
            />
          </>
        ) : (
          <div className="empty">
            {state.ready ? 'Henüz metin kanalı yok. Soldan bir kanal ekle.' : 'Yükleniyor…'}
          </div>
        )}
      </main>

      <MemberList users={state.users} />

      {settingsOpen && (
        <SettingsDialog
          settings={settings}
          onChange={(patch) => settingsStore.update(patch)}
          onClose={closeSettings}
          inVoice={voice.status !== 'idle'}
          connectionTest={{
            fetchIce: () => api.ice(token),
            peerStats: () => engine.peerStats(),
            inVoice: voice.status === 'connected',
            nameOf,
            onActiveChange: (active) => {
              connectionTestActive.current = active
            },
          }}
          noiseState={voice.noiseState}
          transmitting={voice.transmitting}
          isDesktop={desktopBridge() !== null}
          account={{
            name: state.me.name,
            createLinkCode,
            createAtOnce: settingsCode,
            inviteLink: invite === null ? null : inviteLinkUrl(window.location.origin, invite),
            profile: identity.profile,
          }}
          serverSettings={identity.serverSettings}
          serverVersion={state.serverVersion}
          onSignOut={() => {
            closeSettings()
            setLogoutOpen(true)
          }}
        />
      )}

      {logoutOpen && (
        <LogoutDialog
          name={state.me.name}
          busy={signingOut}
          onCancel={() => setLogoutOpen(false)}
          onConfirm={() => void signOut()}
          onCreateCodeFirst={() => {
            setLogoutOpen(false)
            setSettingsCode(true)
            setSettingsOpen(true)
          }}
        />
      )}

      <NotifyBridge
        token={token}
        myId={state.me.id}
        ready={state.ready}
        channels={state.channels}
        users={state.users}
        activeChannelId={activeChannelId}
        send={(event) => socket.send(event)}
        onSelectChannel={selectChannel}
        onOpenDrawer={() => setDrawerOpen(true)}
        onUnauthorized={onLogout}
      />
      <WhatsNewCard ready={state.ready} busy={busyForNews} paused={calls.incoming !== null} />

      <div hidden>
        {voice.remoteAudio.map((media) => (
          <RemoteAudio key={media.userId} media={media} muted={voice.deafened} />
        ))}
      </div>
    </div>
  )
}
