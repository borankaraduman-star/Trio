import type { Channel, Member, VoiceParticipant } from '../../types'
import { Avatar } from '../Avatar'
import { SpeakerIcon } from '../icons'
import { GameActivityLine } from '../GameActivity'

/**
 * CONTRACT-V7-PHONE §2: where the member column is hidden (≤ 960 px), who is
 * online and who is in which voice room, inside the sidebar (the drawer on a
 * phone), and on a phone a compact pill in the header that opens it.
 */

function byName(a: Member, b: Member): number {
  return a.name.localeCompare(b.name, 'tr')
}

/** The voice channel each user is in (from the room lists everybody sees). */
function roomOf(voiceMembers: Record<number, VoiceParticipant[]>): Map<number, number> {
  const rooms = new Map<number, number>()
  for (const [channelId, participants] of Object.entries(voiceMembers)) {
    for (const participant of participants) rooms.set(participant.user_id, Number(channelId))
  }
  return rooms
}

export const PRESENCE_ID = 'drawer-presence'

export function DrawerPresence({
  users,
  channels,
  voiceMembers,
}: {
  users: Record<number, Member>
  channels: Channel[]
  voiceMembers: Record<number, VoiceParticipant[]>
}) {
  const all = Object.values(users)
  const online = all.filter((user) => user.online).sort(byName)
  const offline = all.filter((user) => !user.online).sort(byName)
  const rooms = roomOf(voiceMembers)
  const channelName = (id: number) => channels.find((channel) => channel.id === id)?.name ?? `#${id}`

  const row = (member: Member) => {
    const room = rooms.get(member.id)
    return (
      <li
        key={member.id}
        className={member.online ? 'v7-presence-row' : 'v7-presence-row offline'}
        data-testid={`drawer-member-${member.id}`}
        data-online={member.online}
        data-voice-channel={room ?? ''}
      >
        <span className="member-avatar">
          <Avatar id={member.id} name={member.name} size={26} url={member.avatar_url} />
          <span className={member.online ? 'dot online' : 'dot'} title={member.online ? 'Çevrimiçi' : 'Çevrimdışı'} />
        </span>
        <span className="v7-presence-name">
          <span>{member.name}</span>
          {room !== undefined ? (
            <small className="v7-presence-room">
              <SpeakerIcon size={12} /> {channelName(room)}
            </small>
          ) : (
            <GameActivityLine userId={member.id} testid={`drawer-activity-${member.id}`} />
          )}
        </span>
      </li>
    )
  }

  return (
    <section className="v7-presence" id={PRESENCE_ID} data-testid="drawer-presence" aria-label="Üyeler">
      <div className="section-header">
        <h2 className="section-title">Çevrimiçi — {online.length}</h2>
      </div>
      <ul>{online.map(row)}</ul>
      {offline.length > 0 && (
        <>
          <div className="section-header">
            <h2 className="section-title">Çevrimdışı — {offline.length}</h2>
          </div>
          <ul>{offline.map(row)}</ul>
        </>
      )}
    </section>
  )
}

/** The header's "who is here": up to three online faces and the count. */
export function PresencePill({ users, onOpen }: { users: Record<number, Member>; onOpen: () => void }) {
  const online = Object.values(users)
    .filter((user) => user.online)
    .sort(byName)
  return (
    <button
      type="button"
      className="v7-presence-pill"
      data-testid="presence-pill"
      data-online={online.length}
      aria-label={`Çevrimiçi: ${online.length} kişi. Üyeleri göster`}
      title={online.map((user) => user.name).join(', ') || 'Kimse çevrimiçi değil'}
      onClick={onOpen}
    >
      <span className="v7-presence-faces" aria-hidden="true">
        {online.slice(0, 3).map((user) => (
          <Avatar key={user.id} id={user.id} name={user.name} size={22} url={user.avatar_url} />
        ))}
      </span>
      <span className="dot online" aria-hidden="true" />
      <span>{online.length}</span>
    </button>
  )
}
