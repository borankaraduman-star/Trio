import { useEffect, useSyncExternalStore } from 'react'
import { opsStore } from '../../owner/opsStore'
import { OwnerSection } from './OwnerSection'
import { StorageSection } from './StorageSection'

/** Ayarlar › Depolama (everybody) and › Yönetim (the owner only): CONTRACT-V6-OPS. */
export function OpsSettings() {
  const { isOwner } = useSyncExternalStore(opsStore.subscribe, opsStore.getSnapshot)
  useEffect(() => {
    void opsStore.refresh()
  }, [])
  return (
    <>
      <StorageSection />
      {isOwner && <OwnerSection />}
    </>
  )
}
