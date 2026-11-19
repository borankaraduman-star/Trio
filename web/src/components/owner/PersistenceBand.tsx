import { useEffect, useSyncExternalStore } from 'react'
import { NOT_PERSISTENT_TEXT } from '../../lib/persistence'
import { healthStore } from '../../owner/healthStore'

/**
 * CONTRACT-V6-OPS §7: a red band nobody can close while the server's data is
 * on a disk the next deploy throws away. Shown on every screen, join included.
 */
export function PersistenceBand() {
  const { persistent } = useSyncExternalStore(healthStore.subscribe, healthStore.getSnapshot)
  const show = persistent === false
  useEffect(() => {
    document.documentElement.classList.toggle('trio-volatile', show)
  }, [show])
  if (!show) return null
  return (
    <div className="persistence-band" role="alert" data-testid="persistence-band">
      {NOT_PERSISTENT_TEXT}
    </div>
  )
}
