import type { Member } from '../types'
import { Avatar } from './Avatar'
import { GameActivityLine } from './GameActivity'
import { membersTitle } from '../lib/membersPanel'
import { CloseIcon } from './icons2'

function byName(a: Member, b: Member): number {
  return a.name.localeCompare(b.name, 'tr')
}

export function MemberList({
  users,
  me,
  overlay = false,
  hidden = false,
  onClose,
}: {
  users: Record<number, Member>
  /** V10: my own row says so ("sen"). */
  me?: number
  /** V10: below the column breakpoint the panel opens over the chat. */
  overlay?: boolean
  /** V10: the column hidden from "Üyeler" (wide screens). */
  hidden?: boolean
  onClose?: () => void
}) {
  const all = Object.values(users)
  const online = all.filter((user) => user.online).sort(byName)
  const offline = all.filter((user) => !user.online).sort(byName)

  const section = (title: string, members: Member[]) =>
    members.length > 0 && (
      <>
        <h2 className="section-title">
          {title} — {members.length}
        </h2>
        <ul>
          {members.map((member) => (
            <li
              key={member.id}
              className={member.online ? 'member' : 'member offline'}
              data-testid={`member-${member.id}`}
              data-online={member.online}
            >
              <span className="member-avatar">
                <Avatar id={member.id} name={member.name} size={30} url={member.avatar_url} />
                <span
                  className={member.online ? 'dot online' : 'dot'}
                  title={member.online ? 'Çevrimiçi' : 'Çevrimdışı'}
                />
              </span>
              <span className="member-name">
                {member.name}
                {member.id === me && <small className="member-me"> (sen)</small>}
              </span>
              <GameActivityLine userId={member.id} testid={`member-activity-${member.id}`} />
            </li>
          ))}
        </ul>
      </>
    )

  return (
    <aside
      className={`members${overlay ? ' overlay' : ''}${hidden ? ' hidden' : ''}`}
      aria-label="Üyeler"
      id="members-panel"
      data-testid="members-panel"
    >
      <div className="members-head">
        <h2 className="members-title" data-testid="members-title">
          {membersTitle(online.length)}
        </h2>
        {onClose && (
          <button type="button" className="icon-button small" data-testid="members-close" aria-label="Üyeleri kapat" title="Kapat" onClick={onClose}>
            <CloseIcon size={16} />
          </button>
        )}
      </div>
      <p className="members-note">Metin kanallarını herkes görür; burada sunucudaki herkes ve kimin çevrimiçi olduğu var.</p>
      {section('Çevrimiçi', online)}
      {section('Çevrimdışı', offline)}
    </aside>
  )
}
