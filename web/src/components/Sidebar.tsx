import { useState, type FormEvent } from 'react'
import type { Channel, ChannelKind, Member, User, VoiceParticipant } from '../types'
import type { ConnectionStatus } from '../store'
import type { VoiceSnapshot } from '../voice'
import { Avatar } from './Avatar'
import {
  BellIcon,
  HangupIcon,
  HashIcon,
  HeadphonesIcon,
  LogoutIcon,
  MicIcon,
  PlusIcon,
  ScreenIcon,
  SpeakerIcon,
} from './icons'

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
  onHangup: () => void
  onDismissVoiceError: () => void
  onAskNotifications: () => void
  onLogout: () => void
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

  const textChannels = channels.filter((channel) => channel.kind === 'text')
  const voiceChannels = channels.filter((channel) => channel.kind === 'voice')
  const speaking = new Set(voice.speaking)
  const inVoice = voice.status !== 'idle'
  const voiceChannel = channels.find((channel) => channel.id === voice.channelId)

  const sectionHeader = (title: string, kind: ChannelKind) => (
    <div className="section-header">
      <h2 className="section-title">{title}</h2>
      <button
        type="button"
        className="icon-button small"
        data-testid={`add-channel-${kind}`}
        title="Kanal ekle"
        aria-label={kind === 'text' ? 'Metin kanalı ekle' : 'Ses kanalı ekle'}
        onClick={() => setAdding(adding === kind ? null : kind)}
      >
        <PlusIcon size={16} />
      </button>
    </div>
  )

  return (
    <nav className={props.open ? 'sidebar open' : 'sidebar'} aria-label="Kanallar">
      <header className="sidebar-header">Trio</header>

      <div className="sidebar-scroll">
        {sectionHeader('Metin kanalları', 'text')}
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
                  onClick={() => props.onSelectChannel(channel.id)}
                >
                  <HashIcon size={16} />
                  <span className="channel-name">{channel.name}</span>
                  {unread && <span className="unread-dot" title="Okunmamış mesaj" />}
                </button>
              </li>
            )
          })}
        </ul>

        {sectionHeader('Ses kanalları', 'voice')}
        {adding === 'voice' && (
          <AddChannelForm kind="voice" onSubmit={props.onCreateChannel} onCancel={() => setAdding(null)} />
        )}
        <ul>
          {voiceChannels.map((channel) => {
            const participants = props.voiceMembers[channel.id] ?? []
            const mine = voice.channelId === channel.id && inVoice
            return (
              <li key={channel.id}>
                <button
                  type="button"
                  className={mine ? 'channel active' : 'channel'}
                  data-testid={`channel-${channel.id}`}
                  title={mine ? 'Bu kanaldasın' : 'Katılmak için tıkla'}
                  onClick={() => props.onJoinVoice(channel.id)}
                >
                  <SpeakerIcon size={16} />
                  <span className="channel-name">{channel.name}</span>
                </button>
                {participants.length > 0 && (
                  <ul className="voice-users">
                    {participants.map((participant) => {
                      const name = users[participant.user_id]?.name ?? `#${participant.user_id}`
                      return (
                        <li
                          key={participant.user_id}
                          className="voice-user"
                          data-testid={`voice-user-${participant.user_id}`}
                          data-muted={participant.muted}
                          data-deafened={participant.deafened}
                          data-screensharing={participant.screensharing}
                          data-speaking={speaking.has(participant.user_id)}
                        >
                          <Avatar
                            id={participant.user_id}
                            name={name}
                            size={22}
                            speaking={speaking.has(participant.user_id)}
                          />
                          <span className="voice-user-name">{name}</span>
                          <span className="voice-user-icons">
                            {participant.screensharing && (
                              <span className="badge-live" title="Ekran paylaşıyor">
                                <ScreenIcon size={13} />
                              </span>
                            )}
                            {participant.muted && (
                              <span title="Sessizde">
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
              </li>
            )
          })}
        </ul>
      </div>

      {voice.error && (
        <div className="voice-error" role="alert">
          <span>{voice.error}</span>
          <button type="button" className="ghost" onClick={props.onDismissVoiceError}>
            Tamam
          </button>
        </div>
      )}

      {inVoice && (
        <div className="voice-panel">
          <div className="voice-status">
            <strong className={voice.status === 'connected' ? 'ok' : 'wait'}>
              {voice.status === 'connected' ? 'Ses bağlı' : 'Bağlanıyor…'}
            </strong>
            <span>{voiceChannel?.name ?? ''}</span>
          </div>
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
          <button
            type="button"
            className="icon-button danger"
            data-testid="btn-hangup"
            title="Ayrıl"
            aria-label="Ayrıl"
            onClick={props.onHangup}
          >
            <HangupIcon />
          </button>
        </div>
      )}

      <footer className="user-panel">
        <Avatar id={me.id} name={me.name} size={32} speaking={speaking.has(me.id)} />
        <div className="user-panel-name">
          <strong>{me.name}</strong>
          <span>{props.connection === 'open' ? 'Çevrimiçi' : 'Bağlanıyor…'}</span>
        </div>
        <button
          type="button"
          className={voice.muted ? 'icon-button off' : 'icon-button'}
          data-testid="btn-mute"
          aria-pressed={voice.muted}
          title={voice.muted ? 'Sesi aç' : 'Sessize al'}
          aria-label={voice.muted ? 'Sesi aç' : 'Sessize al'}
          onClick={props.onToggleMute}
        >
          <MicIcon off={voice.muted} />
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
        <button
          type="button"
          className="icon-button"
          data-testid="btn-logout"
          title="Çıkış yap"
          aria-label="Çıkış yap"
          onClick={props.onLogout}
        >
          <LogoutIcon />
        </button>
      </footer>
    </nav>
  )
}
