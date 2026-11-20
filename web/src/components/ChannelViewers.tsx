import { useSyncExternalStore } from 'react'
import type { Member } from '../types'
import { Avatar } from './Avatar'
import { hereLine, showChannel, VIEWER_ROWS_MAX } from '../lib/viewers'

/**
 * CONTRACT-V10-GROUPS §4b: who is in a text channel right now, under its row
 * in the sidebar: a light list of names while it fits, stacked faces and
 * "+n" past four. Only CURRENT presence: nothing here says who has read what.
 */
export function ChannelViewerList({ channelId, people, me }: { channelId: number; people: Member[]; me: number }) {
  if (people.length === 0) return null
  const label = (person: Member) => (person.id === me ? `${person.name} (sen)` : person.name)
  if (people.length <= VIEWER_ROWS_MAX) {
    return (
      <ul className="channel-viewers" data-testid={`channel-viewers-${channelId}`} data-count={people.length} aria-label="Bu kanalda şu an">
        {people.map((person) => (
          <li key={person.id} className="channel-viewer" data-testid={`viewer-${channelId}-${person.id}`}>
            <Avatar id={person.id} name={person.name} size={18} url={person.avatar_url} />
            <span className="channel-viewer-name">{label(person)}</span>
          </li>
        ))}
      </ul>
    )
  }
  const shown = people.slice(0, VIEWER_ROWS_MAX)
  const names = people.map(label).join(', ')
  return (
    <div
      className="channel-viewers stacked"
      data-testid={`channel-viewers-${channelId}`}
      data-count={people.length}
      role="group"
      aria-label={`Bu kanalda şu an: ${names}`}
      title={names}
    >
      <span className="channel-viewer-faces">
        {shown.map((person) => (
          <span key={person.id} data-testid={`viewer-${channelId}-${person.id}`}>
            <Avatar id={person.id} name={person.name} size={20} url={person.avatar_url} />
          </span>
        ))}
      </span>
      <span className="channel-viewer-more" data-testid={`channel-viewers-more-${channelId}`}>
        +{people.length - shown.length}
      </span>
    </div>
  )
}

/** The channel header's "Burada: Sen, Ece +2". */
export function HereLine({ people, me }: { people: Member[]; me: number }) {
  const line = hereLine(people, me)
  if (line === null) return null
  return (
    <span className="here-line" data-testid="here-line" title={people.map((p) => p.name).join(', ')}>
      <span className="here-faces" aria-hidden="true">
        {people.slice(0, 3).map((person) => (
          <Avatar key={person.id} id={person.id} name={person.name} size={18} url={person.avatar_url} />
        ))}
      </span>
      <span className="here-text">{line}</span>
    </span>
  )
}

/** Ayarlar › Hesap: "Hangi kanalda olduğumu göster" (this device). */
export function ShowChannelSetting() {
  const on = useSyncExternalStore(showChannel.subscribe, showChannel.getSnapshot)
  return (
    <section className="settings-section" aria-labelledby="settings-show-channel">
      <h3 id="settings-show-channel">Kanal görünürlüğü</h3>
      <label className="settings-toggle">
        <input
          type="checkbox"
          data-testid="settings-show-channel"
          checked={on}
          onChange={(event) => showChannel.set(event.target.checked)}
        />
        <span>Hangi kanalda olduğumu göster</span>
      </label>
      <p className="settings-hint">
        Açıkken uygulamaya bakarken hangi metin kanalını açtığın herkese, o kanalın altında anlık görünür. Saklanmaz ve
        geçmişi yoktur; kimin neyi okuduğunu göstermez. Kapalıyken hiçbir kanalın altında görünmezsin (Üyeler listesinde
        çevrimiçi görünmeye devam edersin). Bu cihaz için geçerli.
      </p>
    </section>
  )
}
