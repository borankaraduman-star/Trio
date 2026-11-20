import { useState, type FormEvent, type HTMLAttributes, type ReactNode } from 'react'
import type { Channel, ChannelKind, Member, ServerProfile, User, VoiceParticipant } from '../types'
import type { ConnectionStatus } from '../store'
import type { VoiceSnapshot } from '../voice'
import { Avatar } from './Avatar'
import {
  BellIcon,
  HangupIcon,
  HashIcon,
  HeadphonesIcon,
  MicIcon,
  ScreenIcon,
  SpeakerIcon,
} from './icons'
import { CameraIcon, SettingsIcon } from './icons2'
import { DesktopUpdateDot } from './voice/DesktopVersion'
import { ServerMark } from './ServerMark'
import { EmptyState } from './EmptyState'
import { MicLostNotice, PeerHealthBadge } from './VoiceHealth'
import { heldCameraTitle, RingButton, TurnHint, type RingButtonProps } from './VoiceExtras'
import { PersonActivity } from './GameActivity'
import { BackupDot } from './owner/BackupDot'
import { ChannelAddButton } from './phone/ChannelAddButton'
import { screenShareSupported } from '../lib/phone'
import { MusicMark, NowPlayingLine } from '../music/MusicUi'
import { roomCount, roomFullMessage, roomIsFull } from '../lib/groups'
import { viewersOf } from '../lib/viewers'
import { ChannelViewerList } from './ChannelViewers'
import { reportBreadcrumb } from '../owner/errorReporter'

/**
 * V10: a click on a text channel row that has not changed the open channel a
 * second later is logged to the client error log with the layout it happened
 * in (the owner reported "I can't switch between channels" and it could not
 * be reproduced; this is what tells us next time).
 */
function watchChannelSwitch(channelId: number, name: string): void {
  window.setTimeout(() => {
    const shown = document.querySelector('.main-header h1')?.textContent ?? ''
    if (shown === name) return
    reportBreadcrumb(
      `channel click did not switch: channel ${channelId}, header "${shown.slice(0, 32)}", ` +
        `viewport ${window.innerWidth}x${window.innerHeight} dpr ${window.devicePixelRatio}, ` +
        `desktop ${typeof (window as unknown as { trioDesktop?: unknown }).trioDesktop === 'object'}`,
    )
  }, 1000)
}

export interface SidebarProps {
  open: boolean
  me: User
  users: Record<number, Member>
  channels: Channel[]
  voiceMembers: Record<number, VoiceParticipant[]>
  activeChannelId: number | null
  unread: Record<number, number>
  connection: ConnectionStatus
  voice: VoiceSnapshot
  canAskNotifications: boolean
  onSelectChannel: (channelId: number) => void
  onJoinVoice: (channelId: number) => void
  onCreateChannel: (name: string, kind: ChannelKind) => Promise<string | null>
  onToggleMute: () => void
  onToggleDeafen: () => void
  onToggleScreen: () => void
  /** v2 */
  onToggleCamera?: () => void
  /** v2 */
  onOpenSettings?: () => void
  onHangup: () => void
  onDismissVoiceError: () => void
  onRetryMic?: () => void
  /** V4 A4: the "Çağır" button on my voice room. */
  ring?: RingButtonProps
  onAskNotifications: () => void
  /** V7: who is online, shown where the member column is hidden (CONTRACT-V7-PHONE §2). */
  presence?: ReactNode
  /** v4: the server's name and icon for the header (default "Trio"). */
  server?: ServerProfile
  /** V6: beside the share button (the share profile menu). */
  voiceControls?: ReactNode
  /** V6: a participant row's right-click / long-press (the volume sheet). */
  participantMenu?: (userId: number) => HTMLAttributes<HTMLElement>
  /** V8: the music button (in the user panel while in voice) and the panel while I share. */
  musicButton?: ReactNode
  musicPanel?: ReactNode
  /** V10: people per voice room (`ready.voice_room_max`), null when the server does not say. */
  voiceRoomMax?: number | null
  /** V10 (§4b): user id → the text channel they are in now. */
  viewers?: Record<number, number>
}

function AddChannelForm({
  kind,
  onSubmit,
  onCancel,
}: {
  kind: ChannelKind
  onSubmit: (name: string, kind: ChannelKind) => Promise<string | null>
  onCancel: () => void
}) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const trimmed = name.trim()
    if (!trimmed || busy) return
    setBusy(true)
    const failure = await onSubmit(trimmed, kind)
    if (failure) {
      setError(failure)
      setBusy(false)
    } else {
      onCancel()
    }
  }

  return (
    <form className="add-channel" onSubmit={submit}>
      <input
        data-testid="add-channel-name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        maxLength={32}
        autoFocus
        placeholder={kind === 'text' ? 'yeni metin kanalı' : 'yeni ses kanalı'}
        aria-label="Kanal adı"
        onKeyDown={(event) => {
          if (event.key === 'Escape') onCancel()
        }}
      />
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="add-channel-actions">
        <button type="button" className="ghost" onClick={onCancel}>
          Vazgeç
        </button>
        <button
          type="submit"
          className="primary"
          data-testid="add-channel-submit"
          disabled={!name.trim() || busy}
        >
          Ekle
        </button>
      </div>
    </form>
  )
}

export function Sidebar(props: SidebarProps) {
  const { me, users, channels, voice } = props
  const [adding, setAdding] = useState<ChannelKind | null>(null)
  // V10: the full room whose explanation is shown (a tap on it; phones have no tooltip).
  const [fullNote, setFullNote] = useState<number | null>(null)

  const textChannels = channels.filter((channel) => channel.kind === 'text')
  const voiceChannels = channels.filter((channel) => channel.kind === 'voice')
  const speaking = new Set(voice.speaking)
  const inVoice = voice.status !== 'idle'
  const voiceChannel = channels.find((channel) => channel.id === voice.channelId)

  // V7: one "+" (in the header) asks which kind; the sections only carry titles.
  // A channel row's own actions (rename, delete) go on the row, not here.
  const sectionHeader = (title: string) => (
    <div className="section-header">
      <h2 className="section-title">{title}</h2>
    </div>
  )

  return (
    <nav className={props.open ? 'sidebar open' : 'sidebar'} aria-label="Kanallar">
      <header className="sidebar-header">
        <ServerMark server={props.server} />
        <ChannelAddButton adding={adding} onChoose={setAdding} />
      </header>

      <div className="sidebar-scroll">
        {sectionHeader('Metin kanalları')}
        {adding === 'text' && (
          <AddChannelForm kind="text" onSubmit={props.onCreateChannel} onCancel={() => setAdding(null)} />
        )}
        <ul>
          {textChannels.map((channel) => {
            const unread = (props.unread[channel.id] ?? 0) > 0
            const active = channel.id === props.activeChannelId
            return (
              <li key={channel.id}>
                <button
                  type="button"
                  className={`channel${active ? ' active' : ''}${unread ? ' unread' : ''}`}
                  data-testid={`channel-${channel.id}`}
                  data-unread={unread}
                  aria-current={active ? 'page' : undefined}
                  onClick={() => {
                    props.onSelectChannel(channel.id)
                    watchChannelSwitch(channel.id, channel.name)
                  }}
                >
                  <HashIcon size={16} />
                  <span className="channel-name">{channel.name}</span>
                  {unread && <span className="unread-dot" title="Okunmamış mesaj" />}
                </button>
                <ChannelViewerList channelId={channel.id} people={viewersOf(props.viewers ?? {}, channel.id, users, me.id)} me={me.id} />
              </li>
            )
          })}
        </ul>

        {sectionHeader('Ses kanalları')}
        {adding === 'voice' && (
          <AddChannelForm kind="voice" onSubmit={props.onCreateChannel} onCancel={() => setAdding(null)} />
        )}
        <ul>
          {voiceChannels.map((channel) => {
            const participants = props.voiceMembers[channel.id] ?? []
            const mine = voice.channelId === channel.id && inVoice
            const max = props.voiceRoomMax ?? null
            // V10: my own place (here, or listed while my join is on its way) never makes it full.
            const listed = participants.some((participant) => participant.user_id === me.id)
            const full = roomIsFull(participants.length, max, mine || listed)
            const count = roomCount(participants.length, max)
            return (
              <li key={channel.id}>
                <button
                  type="button"
                  className={`channel${mine ? ' active' : ''}${full ? ' full' : ''}`}
                  data-testid={`channel-${channel.id}`}
                  data-room-count={participants.length}
                  data-room-full={full}
                  aria-disabled={full || undefined}
                  title={mine ? 'Bu kanaldasın' : full && max !== null ? roomFullMessage(max) : 'Odaya katıl'}
                  onClick={() => {
                    if (full) {
                      setFullNote(fullNote === channel.id ? null : channel.id)
                      return
                    }
                    setFullNote(null)
                    props.onJoinVoice(channel.id)
                  }}
                >
                  <SpeakerIcon size={16} />
                  <span className="channel-name">{channel.name}</span>
                  {count !== null && (
                    <span
                      className={full ? 'room-count full' : 'room-count'}
                      data-testid={`room-count-${channel.id}`}
                      aria-label={full ? `Oda dolu: ${count}` : `${participants.length} kişi, en çok ${max}`}
                    >
                      {full ? `Oda dolu (${count})` : count}
                    </span>
                  )}
                </button>
                {full && fullNote === channel.id && max !== null && (
                  <p className="room-full-note" role="status" data-testid={`room-full-note-${channel.id}`}>
                    {roomFullMessage(max)}
                  </p>
                )}
                {participants.length > 0 && (
                  <ul className="voice-users">
                    {participants.map((participant) => {
                      const name = users[participant.user_id]?.name ?? `#${participant.user_id}`
                      return (
                        <li
                          key={participant.user_id}
                          className={`voice-user${participant.reconnecting ? ' reconnecting' : ''}`}
                          data-testid={`voice-user-${participant.user_id}`}
                          data-reconnecting={participant.reconnecting === true}
                          title={participant.reconnecting ? 'Yeniden bağlanıyor…' : undefined}
                          data-muted={participant.muted}
                          data-deafened={participant.deafened}
                          data-screensharing={participant.screensharing}
                          data-camera={participant.camera ?? false}
                          data-speaking={speaking.has(participant.user_id)}
                          data-peer-health={mine ? voice.peerHealth[participant.user_id] : undefined}
                          data-afk={participant.afk === true}
                          data-music={participant.music === true}
                          {...(mine && participant.user_id !== me.id ? props.participantMenu?.(participant.user_id) : undefined)}
                        >
                          <Avatar
                            id={participant.user_id}
                            name={name}
                            size={22}
                            url={users[participant.user_id]?.avatar_url}
                            speaking={speaking.has(participant.user_id)}
                          />
                          <span className="voice-user-name">{name}</span>
                          <PersonActivity
                            userId={participant.user_id}
                            prefix="voice"
                            skipTitle={participant.music ? participant.music_title : null}
                          />
                          {participant.music && (
                            <NowPlayingLine userId={participant.user_id} name={name} title={participant.music_title} />
                          )}
                          <span className="voice-user-icons">
                            {/* The server's grace says more than ICE does (and ICE waits for it). */}
                            {mine && !participant.reconnecting && (
                              <PeerHealthBadge health={voice.peerHealth[participant.user_id]} />
                            )}
                            {participant.camera && (
                              <span className="badge-live" title="Kamerası açık">
                                <CameraIcon size={13} />
                              </span>
                            )}
                            {participant.screensharing && (
                              <span className="badge-live" title="Ekran paylaşıyor">
                                <ScreenIcon size={13} />
                              </span>
                            )}
                            {participant.music && <MusicMark />}
                            {participant.afk && (
                              <span className="afk-mark" title="Klavye başında değil (AFK)" data-testid={`afk-${participant.user_id}`}>
                                AFK
                              </span>
                            )}
                            {participant.muted && (
                              <span title="Sessize alınmış">
                                <MicIcon size={13} off />
                              </span>
                            )}
                            {participant.deafened && (
                              <span title="Kulaklık kapalı">
                                <HeadphonesIcon size={13} off />
                              </span>
                            )}
                          </span>
                        </li>
                      )
                    })}
                  </ul>
                )}
                {mine && participants.length === 1 && participants[0]?.user_id === me.id && (
                  <EmptyState art="voice" text="Odada şimdilik yalnızsın." />
                )}
              </li>
            )
          })}
        </ul>
        {props.presence}
      </div>

      {voice.error && (
        <div className="voice-error" role="alert">
          <span>{voice.error}</span>
          <button type="button" className="ghost" onClick={props.onDismissVoiceError}>
            Tamam
          </button>
        </div>
      )}

      <MicLostNotice lost={voice.micLost} onRetry={props.onRetryMic} />
      {inVoice && <TurnHint configured={voice.turnConfigured} />}

      {inVoice && (
        <div className="voice-panel">
          <div className="voice-status">
            <strong className={voice.status === 'connected' ? 'ok' : 'wait'}>
              {voice.status === 'connected' ? 'Ses bağlı' : 'Bağlanıyor…'}
            </strong>
            <span>{voiceChannel?.name ?? ''}</span>
            {props.ring && <RingButton {...props.ring} />}
          </div>
          {props.onToggleCamera && (
            <button
              type="button"
              className={`${voice.camera ? 'icon-button on' : 'icon-button'}${voice.heldCamera !== null ? ' held' : ''}`}
              data-testid="btn-camera"
              data-held={voice.heldCamera !== null}
              aria-pressed={voice.camera}
              title={heldCameraTitle(voice.heldCamera) ?? (voice.camera ? 'Kamerayı kapat' : 'Kamerayı aç')}
              aria-label={voice.camera ? 'Kamerayı kapat' : 'Kamerayı aç'}
              onClick={props.onToggleCamera}
            >
              <CameraIcon off={!voice.camera} />
            </button>
          )}
          {/* V7: no share controls where the browser cannot share a screen (most phones). */}
          {screenShareSupported() && (
            <>
              <button
                type="button"
                className={voice.screensharing ? 'icon-button on' : 'icon-button'}
                data-testid="btn-screen"
                aria-pressed={voice.screensharing}
                title={voice.screensharing ? 'Paylaşımı durdur' : 'Ekran paylaş'}
                aria-label={voice.screensharing ? 'Paylaşımı durdur' : 'Ekran paylaş'}
                onClick={props.onToggleScreen}
              >
                <ScreenIcon />
              </button>
              {props.voiceControls}
            </>
          )}
          <button
            type="button"
            className="icon-button danger"
            data-testid="btn-hangup"
            title="Görüşmeden ayrıl"
            aria-label="Görüşmeden ayrıl"
            onClick={props.onHangup}
          >
            <HangupIcon />
          </button>
        </div>
      )}
      {inVoice && props.musicPanel}

      <footer className="user-panel">
        <Avatar id={me.id} name={me.name} size={32} speaking={speaking.has(me.id)} url={me.avatar_url} />
        <div className="user-panel-name">
          <strong>{me.name}</strong>
          <span>{props.connection === 'open' ? 'Çevrimiçi' : 'Bağlanıyor…'}</span>
        </div>
        {inVoice && props.musicButton}
        <button
          type="button"
          className={voice.muted || voice.micLost ? 'icon-button off' : 'icon-button'}
          data-testid="btn-mute"
          data-transmitting={voice.transmitting}
          aria-pressed={voice.muted}
          title={voice.muted ? 'Sesi aç' : 'Sessize al'}
          aria-label={voice.muted ? 'Sesi aç' : 'Sessize al'}
          onClick={props.onToggleMute}
        >
          <MicIcon off={voice.muted || voice.micLost} />
        </button>
        <button
          type="button"
          className={voice.deafened ? 'icon-button off' : 'icon-button'}
          data-testid="btn-deafen"
          aria-pressed={voice.deafened}
          title={voice.deafened ? 'Kulaklığı aç' : 'Kulaklığı kapat'}
          aria-label={voice.deafened ? 'Kulaklığı aç' : 'Kulaklığı kapat'}
          onClick={props.onToggleDeafen}
        >
          <HeadphonesIcon off={voice.deafened} />
        </button>
        {props.canAskNotifications && (
          <button
            type="button"
            className="icon-button"
            data-testid="btn-notifications"
            title="Bildirimleri aç"
            aria-label="Bildirimleri aç"
            onClick={props.onAskNotifications}
          >
            <BellIcon />
          </button>
        )}
        {props.onOpenSettings && (
          <button
            type="button"
            className="icon-button"
            data-testid="btn-settings"
            data-noise={voice.noiseState}
            title="Ayarlar"
            aria-label="Ayarlar"
            onClick={props.onOpenSettings}
          >
            <SettingsIcon />
            <BackupDot />
            <DesktopUpdateDot />
          </button>
        )}
        {/* V7: signing out is in Ayarlar › Hesap (with its safe-logout dialog), not one tap from here. */}
      </footer>
    </nav>
  )
}
