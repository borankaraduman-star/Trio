import { useEffect, useState } from 'react'
import { CHANGELOG, type ChangelogEntry } from '../changelog'
import { CLIENT_VERSION } from '../lib/version'
import { DEVICE_KNOWN_AT_LOAD, entriesSince, loadSeenVersion, saveSeenVersion } from '../lib/whatsNew'

const CHECK_MS = 1000

/**
 * "Yenilikler" (CONTRACT-V4 A2): once per device after an update, what is new
 * since the version it last acknowledged. Never on a first visit, never a
 * dialog (it takes no focus and blocks nothing), and it only appears while
 * `busy()` — the reload guard's view of the page — says nothing is going on.
 */
export function WhatsNewCard({ ready, busy }: { ready: boolean; busy: () => boolean }) {
  const [entries] = useState<ChangelogEntry[]>(() =>
    entriesSince(CHANGELOG, loadSeenVersion(), CLIENT_VERSION, DEVICE_KNOWN_AT_LOAD),
  )
  const [shown, setShown] = useState(false)
  const [done, setDone] = useState(false)

  useEffect(() => {
    // Nothing to tell (a first visit, or seen already): remember this version now.
    if (entries.length === 0) saveSeenVersion(CLIENT_VERSION)
  }, [entries])

  useEffect(() => {
    if (entries.length === 0 || shown || done || !ready) return
    const check = () => {
      if (!busy()) setShown(true)
    }
    check()
    const timer = setInterval(check, CHECK_MS)
    return () => clearInterval(timer)
  }, [entries, shown, done, ready, busy])

  if (!shown || done) return null

  const dismiss = () => {
    saveSeenVersion(CLIENT_VERSION)
    setDone(true)
  }

  return (
    <aside className="whats-new" role="status" aria-labelledby="whats-new-title" data-testid="whats-new">
      <header>
        <h2 id="whats-new-title">Yenilikler</h2>
        <button type="button" className="ghost" data-testid="whats-new-dismiss" onClick={dismiss}>
          Tamam
        </button>
      </header>
      {entries.map((entry) => (
        <section key={entry.version} data-testid="whats-new-entry" data-version={entry.version}>
          <h3>Trio {entry.version}</h3>
          <ul>
            {entry.lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      ))}
    </aside>
  )
}
