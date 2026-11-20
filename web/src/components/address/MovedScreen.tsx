import { useEffect, useState } from 'react'
import { forgetMovedPrefs, forwardUrl, hostOf, loadMovedTo } from '../../lib/address'
import { BrandMark } from '../BrandMark'
import { moveKind } from './desktopMove'

/**
 * CONTRACT-V11-ADDRESS §3, signed out on an address that is not the canonical
 * one: instead of the join form, where the server is now. An invite or device
 * code this page was opened with goes along in the fragment.
 */
export function MovedScreen({
  publicUrl,
  linkInvite,
  linkDeviceCode,
  onStay,
}: {
  publicUrl: string
  linkInvite: string | null
  linkDeviceCode: string | null
  onStay: () => void
}) {
  // Read once: the person tapped "Bu cihazı taşı" here before (and the session has ended since).
  const [moved] = useState(() => loadMovedTo() === publicUrl)
  useEffect(() => {
    // What moved lives on the new address now; it is not kept twice.
    if (moved) forgetMovedPrefs(localStorage)
  }, [moved])
  const host = hostOf(publicUrl)
  const shell = moveKind() !== 'browser'
  return (
    <main className="join">
      <div className="join-card address-moved" data-testid="address-moved" data-moved={moved ? 'device' : 'server'}>
        <BrandMark size={56} className="join-brand living" />
        <h1>{moved ? 'Bu cihaz taşındı' : 'Trio yeni adrese taşındı'}</h1>
        <p className="join-lead">
          {moved
            ? 'Bu cihazdaki Trio artık yeni adreste açılıyor.'
            : 'Grubun Trio’su artık yeni bir adreste. Hesabın ve mesajların orada seni bekliyor.'}
        </p>
        <p className="address-moved-host" data-testid="address-moved-host">
          {host}
        </p>
        {shell ? (
          <p className="join-hint" data-testid="address-moved-shell">
            Trio menüsü › Sunucuyu değiştir… › <b>{host}</b>
          </p>
        ) : (
          <a
            className="primary address-moved-go"
            data-testid="address-moved-go"
            href={forwardUrl(publicUrl, linkInvite, linkDeviceCode)}
          >
            Yeni adrese git
          </a>
        )}
        {(linkInvite || linkDeviceCode) && !shell && (
          <p className="join-hint">Açtığın bağlantı yeni adreste de çalışır; seni oraya götürüyoruz.</p>
        )}
        <button type="button" className="link address-moved-stay" data-testid="address-moved-stay" onClick={onStay}>
          Bu adreste devam et
        </button>
      </div>
    </main>
  )
}
