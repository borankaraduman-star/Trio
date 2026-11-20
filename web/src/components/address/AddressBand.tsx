import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ApiError, request, type Auth } from '../../api'
import { formatLinkCode } from '../../lib/linkCode'
import {
  addressStore,
  applyMovePrefs,
  collectMovePrefs,
  confirmMove,
  confirmPending,
  errorText,
  hostOf,
  MOVE_ERRORS,
  moveApi,
  offCanonical,
  saveMovedTo,
} from '../../lib/address'
import { askShellToMove, moveKind } from './desktopMove'

/** The owner's view of the address (GET /api/owner/address), the part a band needs. */
interface OwnerAddress {
  recovery?: { configured?: boolean; used_at?: string | null }
}

export const RECOVERY_BAND_TEXT =
  'Kurtarma koduyla girildi — Railway’deki TRIO_RECOVERY_CODE değişkenini silmeyi unutma.'

function notificationsAllowed(): boolean {
  try {
    return typeof Notification !== 'undefined' && Notification.permission === 'granted'
  } catch {
    return false
  }
}

function installedApp(): boolean {
  try {
    return window.matchMedia('(display-mode: standalone)').matches
  } catch {
    return false
  }
}

function useBanded(on: boolean): void {
  useEffect(() => {
    if (!on) return
    document.documentElement.classList.add('trio-banded')
    return () => document.documentElement.classList.remove('trio-banded')
  }, [on])
}

/**
 * CONTRACT-V11-ADDRESS, above every signed-in screen:
 * - on an address that is not the canonical one: "Trio yeni adrese taşındı — Bu cihazı taşı";
 * - on the canonical one with `#tasi=` while signed in: the same person's code is adopted;
 * - the owner who signed in with the recovery code: a band until the variable is gone.
 */
export function AddressBand({ auth, moveCode, onMoveCodeUsed }: { auth: Auth; moveCode: string | null; onMoveCodeUsed: () => void }) {
  const address = useSyncExternalStore(addressStore.subscribe, addressStore.getSnapshot)
  const off = offCanonical(window.location.origin, address)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [manual, setManual] = useState<{ code: string; host: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [recoveryUsed, setRecoveryUsed] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  // A confirm that failed last time (§3): the old session still has to end.
  useEffect(() => {
    if (confirmPending()) void confirmMove(auth.token)
  }, [auth.token])

  // Only the owner gets an answer; for everybody else this is a 403 and nothing shows.
  useEffect(() => {
    let live = true
    request<OwnerAddress>('/api/owner/address', { token: auth.token })
      .then((view) => {
        if (live) setRecoveryUsed(Boolean(view.recovery?.configured && view.recovery?.used_at))
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [auth.token])

  // Signed in here already and a move link arrives: the same person's is adopted, nobody else's.
  const handled = useRef(false)
  useEffect(() => {
    if (!moveCode || off || address.publicUrl === null || handled.current) return
    handled.current = true
    onMoveCodeUsed()
    void (async () => {
      try {
        const peek = await moveApi.peek(moveCode)
        if (peek.user.id !== auth.user.id) {
          setNotice(
            `Bu taşıma bağlantısı ${peek.user.name} hesabına ait; bu cihazda zaten ${auth.user.name} olarak girişlisin. Hiçbir şey değişmedi.`,
          )
          return
        }
        const adopted = await moveApi.adopt(auth.token, moveCode)
        applyMovePrefs(localStorage, adopted.prefs, true)
        setNotice('Bu cihaz zaten yeni adreste girişliydi: eski adresteki oturumu kapatıldı.')
      } catch (failure) {
        setNotice(errorText(MOVE_ERRORS, failure))
      }
    })()
  }, [moveCode, off, address.publicUrl, auth.token, auth.user.id, auth.user.name, onMoveCodeUsed])

  const showMove = off && address.publicUrl !== null
  useBanded(showMove || recoveryUsed || notice !== null)

  const move = async () => {
    if (!address.publicUrl || busy) return
    setBusy(true)
    setError(null)
    try {
      const made = await moveApi.create(auth.token, collectMovePrefs(localStorage))
      saveMovedTo(made.publicUrl)
      const kind = moveKind()
      if (kind === 'browser') {
        window.location.assign(made.url)
        return
      }
      if (kind === 'desktop') {
        const result = await askShellToMove(made.publicUrl, made.code)
        if (result.ok) return
      }
      setManual({ code: made.code, host: hostOf(made.publicUrl) })
    } catch (failure) {
      setError(failure instanceof ApiError && failure.status === 401 ? 'Oturum kapanmış.' : errorText(MOVE_ERRORS, failure))
    }
    setBusy(false)
  }

  const copy = async () => {
    if (!manual) return
    try {
      await navigator.clipboard.writeText(manual.code)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  if (!showMove && !recoveryUsed && !notice) return null
  const host = address.publicUrl ? hostOf(address.publicUrl) : ''
  const shell = moveKind()
  return (
    <div className="address-bands">
      {recoveryUsed && (
        <div className="address-band recovery" role="alert" data-testid="recovery-band">
          {RECOVERY_BAND_TEXT}
        </div>
      )}
      {notice && (
        <div className="address-band" role="status" data-testid="address-notice">
          <span>{notice}</span>
          <button type="button" className="address-band-close" onClick={() => setNotice(null)} aria-label="Kapat">
            ×
          </button>
        </div>
      )}
      {showMove && (
        <div className="address-band move" role="status" data-testid="address-band" data-host={host}>
          <div className="address-band-main">
            <span className="address-band-text">
              Trio yeni adrese taşındı: <b>{host}</b>
            </span>
            {!manual && (
              <button type="button" className="address-band-action" data-testid="address-move" disabled={busy} onClick={() => void move()}>
                {busy ? 'Taşınıyor…' : 'Bu cihazı taşı'}
              </button>
            )}
          </div>
          {shell === 'old-shell' && !manual && (
            <p className="address-band-line" data-testid="address-old-shell">
              Uygulama menüsü › Sunucu adresini değiştir › <b>{host}</b>. Önce “Bu cihazı taşı”ya bas: çıkan kodu yeni
              adreste “Zaten hesabım var”a yazarsın.
            </p>
          )}
          {manual && (
            <p className="address-band-line" data-testid="address-manual">
              Uygulama menüsü › Sunucu adresini değiştir › <b>{manual.host}</b>, sonra “Zaten hesabım var”a bu kodu yaz:{' '}
              <code className="link-code" data-testid="address-manual-code">
                {formatLinkCode(manual.code)}
              </code>{' '}
              <button type="button" className="link" onClick={() => void copy()}>
                {copied ? 'Kopyalandı' : 'Kopyala'}
              </button>{' '}
              (10 dakika geçerli)
            </p>
          )}
          {notificationsAllowed() && (
            <p className="address-band-line" data-testid="address-push-line">
              Bildirim iznini yeni adreste bir kez daha vermen gerekir.
            </p>
          )}
          {installedApp() && (
            <p className="address-band-line" data-testid="address-pwa-line">
              Ana ekrana eklediysen: yeni adresi açıp yeniden ekle.
            </p>
          )}
          {error && (
            <p className="address-band-line error" role="alert" data-testid="address-error">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
