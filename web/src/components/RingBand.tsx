import type { IncomingRing } from '../lib/ring'

/** CONTRACT-V4 A4: "X seni <kanal> odasına çağırıyor — Katıl / Kapat". */
export function RingBand({
  ring,
  fromName,
  channelName,
  silent,
  onJoin,
  onDismiss,
}: {
  ring: IncomingRing
  fromName: string
  channelName: string
  /** Rahatsız etme or deafened: the band without the ringtone (said, so it is not a mystery). */
  silent: boolean
  onJoin: () => void
  onDismiss: () => void
}) {
  return (
    <div
      className="ring-band"
      role="alert"
      data-testid="ring-band"
      data-channel={ring.channelId}
      data-from={ring.from}
      data-silent={silent}
    >
      <span className="ring-band-pulse" aria-hidden="true" />
      <span className="ring-band-text">
        {/* No case suffix on a name: "<isim> seni <oda> odasına çağırıyor". */}
        <strong>{fromName}</strong> seni <strong>{channelName}</strong> odasına çağırıyor
        {silent && <small> (sessiz)</small>}
      </span>
      <span className="ring-band-actions">
        <button type="button" className="ring-join" data-testid="ring-join" onClick={onJoin}>
          Katıl
        </button>
        <button type="button" className="ghost" data-testid="ring-dismiss" onClick={onDismiss}>
          Kapat
        </button>
      </span>
    </div>
  )
}
