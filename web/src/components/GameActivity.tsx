/**
 * CONTRACT-V5 and CONTRACT-V11-ACTIVITY: the quiet lines under a name — what
 * somebody plays ("WoW Forever · 37 · Orgrimmar") and what they listen to
 * ("Spotify · Sanatçı — Şarkı") — and the "Durum" settings. Nothing is shown
 * for somebody doing neither.
 *
 * Each line reads ONE person's entry (`useActivityOf`): a change of somebody
 * else's activity does not re-render it.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import {
  activityLine,
  activityStore,
  activityTooltip,
  CLASSES,
  gameShare,
  gameStatusBridge,
  listeningLine,
  listeningTooltip,
  shortActivity,
  songText,
  type ActivityEntry,
} from '../gameActivity'
import { desktopBridge } from '../ptt'
import { healthText, listeningSource, listeningSupport, listenPrefs } from '../activity/listening'
import { NoteIcon } from '../music/MusicUi'

/** Re-render once a minute so "x dk" in the tooltip stays true. */
function useMinuteTick(): void {
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 60_000)
    return () => clearInterval(id)
  }, [])
}

/** One person's activity entry; re-renders only when THAT entry changes. */
export function useActivityOf(userId: number): ActivityEntry | undefined {
  const get = useCallback(() => activityStore.get(userId), [userId])
  return useSyncExternalStore(activityStore.subscribe, get)
}

export function PadIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="activity-glyph"
    >
      <path d="M6 11h4M8 9v4M15 12h.01M18 10h.01" />
      <path d="M17.3 5H6.7a4 4 0 0 0-3.96 3.43l-.73 5.1A2.7 2.7 0 0 0 4.7 16.6c.9 0 1.73-.48 2.18-1.26L8 13.6h8l1.12 1.74c.45.78 1.28 1.26 2.18 1.26a2.7 2.7 0 0 0 2.68-3.07l-.73-5.1A4 4 0 0 0 17.3 5Z" />
    </svg>
  )
}

export function GameActivityLine({ userId, testid }: { userId: number; testid: string }) {
  const entry = useActivityOf(userId)
  useMinuteTick()
  // Read the clock at render: a time kept from mount would be up to a minute
  // behind a status that arrived since.
  const now = Date.now()
  if (!entry || entry.activity.game === null) return null
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
      {activity.detail ? (
        <span
          className="game-activity-class"
          style={klass ? { background: klass.color } : undefined}
          aria-label={klass?.name ?? activity.detail.class}
        />
      ) : (
        <PadIcon size={12} />
      )}
      <span className="game-activity-text">{activityLine(activity)}</span>
    </span>
  )
}

/** V11: "Sanatçı — Şarkı" under a name (the app is in the tooltip). `skipTitle`: a V8 sharer's room line already says it. */
export function ListeningLine({ userId, testid, skipTitle }: { userId: number; testid: string; skipTitle?: string | null }) {
  const entry = useActivityOf(userId)
  const listening = entry?.activity.listening
  if (!listening) return null
  if (skipTitle && skipTitle === songText(listening)) return null
  return (
    <span className="game-activity listening-activity" data-testid={testid} title={listeningTooltip(listening)}>
      <NoteIcon size={11} />
      <span className="game-activity-text">{songText(listening)}</span>
    </span>
  )
}

/** Both lines, game first. `prefix`: "member" → `member-activity-<id>` and `member-listening-<id>`. */
export function PersonActivity({ userId, prefix, skipTitle }: { userId: number; prefix: string; skipTitle?: string | null }) {
  return (
    <>
      <GameActivityLine userId={userId} testid={`${prefix}-activity-${userId}`} />
      <ListeningLine userId={userId} testid={`${prefix}-listening-${userId}`} skipTitle={skipTitle} />
    </>
  )
}

/** One short piece after a name in a tight row (under a text channel): the game, else the song. */
export function CompactActivity({ userId, testid }: { userId: number; testid: string }) {
  const entry = useActivityOf(userId)
  if (!entry) return null
  const { activity } = entry
  const text = shortActivity(activity)
  if (!text) return null
  const full = [activityLine(activity), activity.listening ? `Dinliyor: ${listeningLine(activity.listening)}` : ''].filter(Boolean).join('\n')
  return (
    <span className="compact-activity" data-testid={testid} title={full} data-kind={activity.game !== null ? 'game' : 'music'}>
      {activity.game !== null ? <PadIcon size={11} /> : <NoteIcon size={10} />}
      <span className="compact-activity-text">{text}</span>
    </span>
  )
}

// --------------------------------------------------------------------- settings

export function GameShareSetting() {
  const on = useSyncExternalStore(gameShare.subscribe, gameShare.getSnapshot)
  const desktop = gameStatusBridge() !== null
  // A desktop app from before CONTRACT-V5 has the bridge but not `onGameStatus`.
  const oldDesktop = !desktop && desktopBridge() !== null
  return (
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
  )
}

export function ListenShareSetting() {
  const prefs = useSyncExternalStore(listenPrefs.subscribe, listenPrefs.getSnapshot)
  const source = useSyncExternalStore(listeningSource.subscribe, listeningSource.getSnapshot)
  const support = listeningSupport()
  const health = healthText(support, source.state, prefs.on)
  const lastApp = support === 'ok' && prefs.on ? source.state?.lastApp : undefined
  return (
    <>
      <label className="settings-toggle">
        <input
          type="checkbox"
          data-testid="settings-listen-share"
          checked={prefs.on}
          disabled={support !== 'ok'}
          onChange={(event) => listenPrefs.setOn(event.target.checked)}
        />
        <span>
          Ne dinlediğimi göster
          <small className="settings-hint">
            Spotify, Apple Music, TIDAL, Deezer gibi müzik uygulamalarında çalan şarkı adının altında görünür (sesli
            odada olmasan da). Sunucudaki herkes görür; saklanmaz, geçmişi yoktur.
          </small>
        </span>
      </label>
      <label className="settings-toggle settings-sub">
        <input
          type="checkbox"
          data-testid="settings-listen-browsers"
          checked={prefs.browsers}
          disabled={support !== 'ok' || !prefs.on}
          onChange={(event) => listenPrefs.setBrowsers(event.target.checked)}
        />
        <span>
          Tarayıcılarda ve diğer uygulamalarda çalanları da göster
          <small className="settings-hint">
            Kapalıyken bir YouTube sekmesi, video oynatıcı ya da başka bir uygulama asla gösterilmez.
          </small>
        </span>
      </label>
      {health && (
        <p className="settings-hint listen-health" data-testid="settings-listen-health" data-health={source.state?.health ?? support}>
          {health}
        </p>
      )}
      {lastApp && (
        <p className="settings-hint" data-testid="settings-listen-last-app">
          Windows’un bildirdiği son oynatıcı: {lastApp.name} — {lastApp.shown ? 'gösteriliyor' : 'gösterilmiyor'}
        </p>
      )}
    </>
  )
}

/** Ayarlar › Hesap: "Durum" — Oyun and Müzik. */
export function StatusSettings() {
  return (
    <section className="settings-section" aria-labelledby="settings-game">
      <h3 id="settings-game">Durum</h3>
      <h4 className="settings-subtitle">Oyun</h4>
      <GameShareSetting />
      <h4 className="settings-subtitle">Müzik</h4>
      <ListenShareSetting />
    </section>
  )
}

/** V11 first run: nothing is sent until this is answered. */
export function ListeningNotice() {
  const source = useSyncExternalStore(listeningSource.subscribe, listeningSource.getSnapshot)
  if (!source.needsNotice) return null
  return (
    <div className="listen-notice" role="status" data-testid="listen-notice">
      <NoteIcon size={14} />
      <span className="listen-notice-text">Ne dinlediğin sunucudaki herkese görünüyor.</span>
      <button type="button" className="ghost" data-testid="listen-notice-off" onClick={() => listenPrefs.answerNotice(false)}>
        Kapat
      </button>
      <button type="button" className="primary" data-testid="listen-notice-ok" onClick={() => listenPrefs.answerNotice(true)}>
        Tamam
      </button>
    </div>
  )
}
