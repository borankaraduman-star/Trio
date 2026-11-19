import { useEffect, useState, useSyncExternalStore } from 'react'
import { backupStale } from '../../lib/opsFormat'
import { opsStore } from '../../owner/opsStore'

const RECHECK_MS = 30 * 60 * 1000

/** A red dot on the owner's settings button while the last backup is older than 14 days (or none). */
export function BackupDot() {
  const { isOwner, overview } = useSyncExternalStore(opsStore.subscribe, opsStore.getSnapshot)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    void opsStore.refresh()
    const timer = setInterval(() => {
      setNow(Date.now())
      void opsStore.refresh()
    }, RECHECK_MS)
    return () => clearInterval(timer)
  }, [])
  if (!isOwner || !overview || !backupStale(overview.backup.last, now)) return null
  return <span className="ops-dot" data-testid="backup-dot" aria-label="Yedek eski" title="Yedek 14 günden eski" />
}
