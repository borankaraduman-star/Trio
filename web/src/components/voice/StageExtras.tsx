import type { Member, VoiceParticipant } from '../../types'
import type { VoiceEngine, VoiceSnapshot } from '../../voice'
import type { StageTile } from '../CallStage'
import { Avatar } from '../Avatar'
import { HeadphonesIcon, MicIcon, ScreenIcon } from '../icons'
import { EyeIcon } from './icons'
import { ShareMenu, ShareWatchers } from './ShareMenu'

/**
 * What V6 adds to the stage (CONTRACT-V6-VOICE §2, §6): on a remote screen
 * tile "İzlemeyi bırak"; on my own screen tile who watches and the profile
 * chip; under the stage the people of the room as small avatar tiles, and a
 * screen I stopped watching as a chip with "İzle".
 */
export function StageTileOverlay({
  tile,
  engine,
  voice,
  nameOf,
}: {
  tile: StageTile
  engine: VoiceEngine
  voice: VoiceSnapshot
  nameOf: (userId: number) => string
}) {
  if (tile.kind !== 'screen') return null
  if (tile.userId === null) {
    return (
      <div className="tile-bar" onClick={(event) => event.stopPropagation()}>
        <ShareWatchers voice={voice} nameOf={nameOf} />
        <ShareMenu engine={engine} voice={voice} nameOf={nameOf} variant="chip" />
      </div>
    )
  }
  const userId = tile.userId
  return (
    <button
      type="button"
      className="tile-unwatch"
      data-testid={`btn-unwatch-${userId}`}
      title="İzlemeyi bırak (görüntü sana gönderilmez)"
      aria-label={`İzlemeyi bırak: ${nameOf(userId)}`}
      onClick={(event) => {
        event.stopPropagation()
        engine.setWatching(userId, false)
      }}
    >
      <EyeIcon off size={14} />
      <span>İzlemeyi bırak</span>
    </button>
  )
}

/** A screen I do not watch: hidden from the stage. */
export function isHiddenTile(tile: StageTile, voice: VoiceSnapshot): boolean {
  return tile.kind === 'screen' && tile.userId !== null && voice.hiddenScreens[tile.userId] !== undefined
}

export function StagePeople({
  participants,
  users,
  me,
  voice,
  engine,
  nameOf,
}: {
  participants: readonly VoiceParticipant[]
  users: Record<number, Member>
  me: number
  voice: VoiceSnapshot
  engine: VoiceEngine
  nameOf: (userId: number) => string
}) {
  const speaking = new Set(voice.speaking)
  const cameras = new Set(voice.remoteCamera.map((media) => media.userId))
  if (voice.camera) cameras.add(me)
  const hidden = voice.remoteVideo.filter((media) => voice.hiddenScreens[media.userId] !== undefined)
  // People whose face is not already on the stage as a camera.
  const people = participants.filter((p) => !cameras.has(p.user_id))
  if (people.length === 0 && hidden.length === 0) return null
  return (
    <div className="stage-people" data-testid="stage-people" aria-label="Odadakiler">
      {people.map((participant) => {
        const id = participant.user_id
        const name = id === me ? 'Sen' : nameOf(id)
        const muted = id === me ? voice.muted : participant.muted
        const deafened = id === me ? voice.deafened : participant.deafened
        const afk = id === me ? voice.afk : participant.afk === true
        return (
          <figure
            key={id}
            className={`stage-person${afk ? ' afk' : ''}`}
            data-testid={`stage-person-${id}`}
            data-speaking={speaking.has(id)}
            data-muted={muted}
            data-deafened={deafened}
            data-afk={afk}
          >
            <Avatar id={id} name={users[id]?.name ?? name} size={40} speaking={speaking.has(id)} url={users[id]?.avatar_url} />
            <figcaption>{name}</figcaption>
            <span className="stage-person-marks">
              {afk && <span className="afk-mark" title="Klavye başında değil">AFK</span>}
              {muted && (
                <span title="Sessizde">
                  <MicIcon size={12} off />
                </span>
              )}
              {deafened && (
                <span title="Kulaklık kapalı">
                  <HeadphonesIcon size={12} off />
                </span>
              )}
            </span>
          </figure>
        )
      })}
      {hidden.map((media) => (
        <div key={`hidden-${media.userId}`} className="stage-hidden" data-testid={`hidden-screen-${media.userId}`}>
          <ScreenIcon size={14} />
          <span>{nameOf(media.userId)} ekran paylaşıyor</span>
          <button
            type="button"
            className="primary small"
            data-testid={`btn-watch-${media.userId}`}
            onClick={() => engine.setWatching(media.userId, true)}
          >
            İzle
          </button>
        </div>
      ))}
    </div>
  )
}

/**
 * The V6 props for CallStage. The people strip shows only while the stage
 * itself does (a screen or a camera is on); an audio-only room has no stage.
 */
export function stageExtras(input: {
  engine: VoiceEngine
  voice: VoiceSnapshot
  participants: readonly VoiceParticipant[]
  users: Record<number, Member>
  me: number
  nameOf: (userId: number) => string
}) {
  const { engine, voice, nameOf } = input
  const visual =
    voice.remoteVideo.length > 0 || voice.remoteCamera.length > 0 || voice.localScreen !== null || voice.localCamera !== null
  return {
    overlay: (tile: StageTile) => <StageTileOverlay tile={tile} engine={engine} voice={voice} nameOf={nameOf} />,
    hide: (tile: StageTile) => isHiddenTile(tile, voice),
    footer:
      visual && voice.status !== 'idle' ? (
        <StagePeople
          participants={input.participants}
          users={input.users}
          me={input.me}
          voice={voice}
          engine={engine}
          nameOf={nameOf}
        />
      ) : undefined,
  }
}
