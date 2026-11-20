import type { ReactNode } from 'react'
import type { VoiceSnapshot } from '../../voice'
import { HangupIcon, HeadphonesIcon, MicIcon, ScreenIcon } from '../icons'
import { CameraIcon } from '../icons2'
import { heldCameraTitle } from '../VoiceExtras'
import { screenShareSupported, talkingLine } from '../../lib/phone'

/**
 * CONTRACT-V7-PHONE §1: the call bar. On a phone, while this tab is in a
 * voice room, a strip above the composer holds mute, deafen, camera, (screen
 * share where the browser can) and leave, with the room's name and who is
 * talking. The same engine calls as the drawer's buttons, so nothing about
 * the call changes by using one or the other.
 */
export function CallBar({
  voice,
  me,
  roomName,
  participantCount,
  nameOf,
  onToggleMute,
  onToggleDeafen,
  onToggleCamera,
  onToggleScreen,
  onHangup,
  onOpenRoom,
  musicButton,
}: {
  voice: VoiceSnapshot
  me: number
  roomName: string
  participantCount: number
  nameOf: (userId: number) => string
  onToggleMute: () => void
  onToggleDeafen: () => void
  onToggleCamera: () => void
  onToggleScreen: () => void
  onHangup: () => void
  /** V8: the music button (CONTRACT-V8-MUSIC §6), placed before leave. */
  musicButton?: ReactNode
  /** The room line opens the drawer, where the room's people are listed. */
  onOpenRoom: () => void
}) {
  if (voice.status === 'idle') return null
  const micOff = voice.muted || voice.micLost
  const connected = voice.status === 'connected'
  return (
    <div className="v7-call-bar" data-testid="call-bar" role="region" aria-label="Görüşme">
      <button type="button" className="v7-call-room" data-testid="call-bar-room" onClick={onOpenRoom} title="Odadakileri göster">
        <strong className={connected ? 'ok' : 'wait'}>{connected ? roomName : 'Bağlanıyor…'}</strong>
        <span
          data-testid="call-bar-talking"
          data-speaking={voice.speaking.length > 0}
          title={connected ? talkingLine(voice.speaking, me, participantCount, nameOf) : undefined}
        >
          {connected ? talkingLine(voice.speaking, me, participantCount, nameOf) : roomName}
        </span>
      </button>
      <div className="v7-call-buttons">
        <button
          type="button"
          className={micOff ? 'v7-call-button off' : 'v7-call-button'}
          data-testid="call-bar-mute"
          data-transmitting={voice.transmitting}
          aria-pressed={voice.muted}
          aria-label={voice.muted ? 'Sesi aç' : 'Sessize al'}
          title={voice.muted ? 'Sesi aç' : 'Sessize al'}
          onClick={onToggleMute}
        >
          <MicIcon size={22} off={micOff} />
        </button>
        <button
          type="button"
          className={voice.deafened ? 'v7-call-button off' : 'v7-call-button'}
          data-testid="call-bar-deafen"
          aria-pressed={voice.deafened}
          aria-label={voice.deafened ? 'Kulaklığı aç' : 'Kulaklığı kapat'}
          title={voice.deafened ? 'Kulaklığı aç' : 'Kulaklığı kapat'}
          onClick={onToggleDeafen}
        >
          <HeadphonesIcon size={22} off={voice.deafened} />
        </button>
        <button
          type="button"
          className={`${voice.camera ? 'v7-call-button on' : 'v7-call-button'}${voice.heldCamera !== null ? ' held' : ''}`}
          data-testid="call-bar-camera"
          aria-pressed={voice.camera}
          aria-label={voice.camera ? 'Kamerayı kapat' : 'Kamerayı aç'}
          title={heldCameraTitle(voice.heldCamera) ?? (voice.camera ? 'Kamerayı kapat' : 'Kamerayı aç')}
          onClick={onToggleCamera}
        >
          <CameraIcon size={22} off={!voice.camera} />
        </button>
        {screenShareSupported() && (
          <button
            type="button"
            className={voice.screensharing ? 'v7-call-button on' : 'v7-call-button'}
            data-testid="call-bar-screen"
            aria-pressed={voice.screensharing}
            aria-label={voice.screensharing ? 'Paylaşımı durdur' : 'Ekran paylaş'}
            title={voice.screensharing ? 'Paylaşımı durdur' : 'Ekran paylaş'}
            onClick={onToggleScreen}
          >
            <ScreenIcon size={22} />
          </button>
        )}
        {musicButton}
        <button
          type="button"
          className="v7-call-button danger"
          data-testid="call-bar-hangup"
          aria-label="Görüşmeden ayrıl"
          title="Görüşmeden ayrıl"
          onClick={onHangup}
        >
          <HangupIcon size={22} />
        </button>
      </div>
    </div>
  )
}
