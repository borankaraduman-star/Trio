/**
 * CONTRACT-V5: the quiet line under a name ("WoW Forever · 37 · Orgrimmar")
 * and the "Oyun durumumu paylaş" setting. Nothing is shown for somebody not
 * in a game.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { activityLine, activityStore, activityTooltip, CLASSES, gameShare, gameStatusBridge } from '../gameActivity'

/** Re-render once a minute so "x dk" in the tooltip stays true. */
function useMinute(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])
  return now
}

export function GameActivityLine({ userId, testid }: { userId: number; testid: string }) {
  const entries = useSyncExternalStore(activityStore.subscribe, activityStore.getSnapshot)
  const now = useMinute()
  const entry = entries[userId]
  if (!entry) return null
  const { activity } = entry
  const klass = activity.detail ? CLASSES[activity.detail.class] : undefined
  return (
    <span
      className="game-activity"
      data-testid={testid}
      data-game={activity.game}
      data-level={activity.detail?.level ?? ''}
      title={activityTooltip(entry, now)}
    >
      {activity.detail && (
        <span
          className="game-activity-class"
          style={klass ? { background: klass.color } : undefined}
          aria-label={klass?.name ?? activity.detail.class}
        />
      )}
      <span className="game-activity-text">{activityLine(activity)}</span>
    </span>
  )
}

export function GameShareSetting() {
  const on = useSyncExternalStore(gameShare.subscribe, gameShare.getSnapshot)
  const desktop = gameStatusBridge() !== null
  return (
    <section className="settings-section" aria-labelledby="settings-game">
      <h3 id="settings-game">Oyun durumu</h3>
      <label className="settings-toggle">
        <input
          type="checkbox"
          data-testid="settings-game-share"
          checked={on}
          onChange={(event) => gameShare.set(event.target.checked)}
        />
        <span>
          Oyun durumumu paylaş
          <small className="settings-hint">
            {desktop
              ? 'Hangi oyunda olduğun (WoW’da seviye ve bölge) adının altında görünür. Trio masaüstü › Oyun durumu penceresinden ayarlanır.'
              : 'Yalnızca Trio masaüstü uygulamasında çalışır; bu tarayıcı oyun durumu göndermez.'}
          </small>
        </span>
      </label>
    </section>
  )
}
