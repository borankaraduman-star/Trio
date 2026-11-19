import { MIC_LOST_MESSAGE, type PeerHealth } from '../voice'
import '../voice-health.css'

/**
 * Findings 4 and 10a: what the voice engine knows about the microphone and
 * about each connection, shown where the user looks (the voice panel and the
 * participant rows).
 */

const HEALTH_TEXT: Record<Exclude<PeerHealth, 'connected'>, string> = {
  connecting: 'Bağlanıyor…',
  reconnecting: 'Bağlantı koptu, yeniden bağlanılıyor…',
  failed: 'Bağlanılamadı. Aranızdaki ağ bir TURN sunucusu gerektiriyor olabilir.',
}

/** A small dot on another member's row while the connection to them is not up. */
export function PeerHealthBadge({ health }: { health: PeerHealth | undefined }) {
  if (health === undefined || health === 'connected') return null
  const text = HEALTH_TEXT[health]
  return (
    <span className={`peer-health ${health}`} data-testid="peer-health" data-health={health} title={text} role="img" aria-label={text}>
      {health === 'failed' ? '!' : ''}
    </span>
  )
}

/** "The microphone was cut off" with a retry button; nothing while it works. */
export function MicLostNotice({ lost, onRetry }: { lost: boolean; onRetry?: () => void }) {
  if (!lost) return null
  return (
    <div className="voice-error mic-lost" role="alert" data-testid="mic-lost">
      <span>
        {MIC_LOST_MESSAGE}. Sesin kimseye gitmiyor; mikrofon takılınca kendiliğinden yeniden denenir.
      </span>
      {onRetry && (
        <button type="button" className="ghost" data-testid="mic-retry" onClick={onRetry}>
          Tekrar dene
        </button>
      )}
    </div>
  )
}
