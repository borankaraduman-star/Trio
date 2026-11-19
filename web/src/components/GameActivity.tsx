/**
 * CONTRACT-V5: the quiet line under a name ("WoW Forever · 37 · Orgrimmar")
 * and the "Oyun durumumu paylaş" setting. Nothing is shown for somebody not
 * in a game.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { activityLine, activityStore, activityTooltip, CLASSES, gameShare, gameStatusBridge } from '../gameActivity'
import { desktopBridge } from '../ptt'

/** Re-render once a minute so "x dk" in the tooltip stays true. */
function useMinuteTick(): void {
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 60_000)
    return () => clearInterval(id)
  }, [])
}

export function GameActivityLine({ userId, testid }: { userId: number; testid: string }) {
  const entries = useSyncExternalStore(activityStore.subscribe, activityStore.getSnapshot)
  useMinuteTick()
  // Read the clock at render: a time kept from mount would be up to a minute
  // behind a status that arrived since.
  const now = Date.now()
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
  // A desktop app from before CONTRACT-V5 has the bridge but not `onGameStatus`.
  const oldDesktop = !desktop && desktopBridge() !== null
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
              : oldDesktop
                ? 'Bu Trio masaüstü sürümü oyun durumu göndermiyor; masaüstü uygulamasını güncelle.'
                : 'Yalnızca Trio masaüstü uygulamasında çalışır; bu tarayıcı oyun durumu göndermez.'}
          </small>
        </span>
      </label>
    </section>
  )
}
