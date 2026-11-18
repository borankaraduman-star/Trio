import type { Member } from '../types'
import { Avatar } from './Avatar'

function byName(a: Member, b: Member): number {
  return a.name.localeCompare(b.name, 'tr')
}

export function MemberList({ users }: { users: Record<number, Member> }) {
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
                <Avatar id={member.id} name={member.name} size={30} />
                <span
                  className={member.online ? 'dot online' : 'dot'}
                  title={member.online ? 'Çevrimiçi' : 'Çevrimdışı'}
                />
              </span>
              <span className="member-name">{member.name}</span>
            </li>
          ))}
        </ul>
      </>
    )

  return (
    <aside className="members" aria-label="Üyeler">
      {section('Çevrimiçi', online)}
      {section('Çevrimdışı', offline)}
    </aside>
  )
}
