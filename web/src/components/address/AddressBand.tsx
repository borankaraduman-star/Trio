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
  nextPending,
  offCanonical,
  type MoveCode,
  saveMovedTo,
} from '../../lib/address'
import { askShellToMove, moveKind, shellKeepsNextCode, storeNextInShell } from './desktopMove'

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

const NEXT_DISMISSED_KEY = 'trio.nextDismissed'

function readDismissed(): string | null {
  try {
    return localStorage.getItem(NEXT_DISMISSED_KEY)
  } catch {
    return null
  }
}

function writeDismissed(value: string | null): void {
  try {
    if (value) localStorage.setItem(NEXT_DISMISSED_KEY, value)
  } catch {
    // Shown again next time.
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
export function AddressBand({
  auth,
  ...rest
}: {
  auth: Auth | null
  moveCode: string | null
  onMoveCodeUsed: () => void
}) {
  // Keyed by token: a different account starts with a fresh band.
  return auth ? <SignedInBand key={auth.token} auth={auth} {...rest} /> : null
}

function SignedInBand({ auth, moveCode, onMoveCodeUsed }: { auth: Auth; moveCode: string | null; onMoveCodeUsed: () => void }) {
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

  // §8: an address is announced. The desktop app keeps a 7-day code itself; a browser shows it.
  const next = nextPending(window.location.origin, address) && !off
  const nextHost = address.nextUrl ? hostOf(address.nextUrl) : ''
  const [nextCode, setNextCode] = useState<MoveCode | null>(null)
  const [nextStored, setNextStored] = useState(false)
  const [dismissed, setDismissed] = useState(readDismissed)
  const nextHidden = Boolean(address.nextUrl) && dismissed === address.nextUrl
  const nextAsked = useRef(false)
  useEffect(() => {
    if (!next || !shellKeepsNextCode() || nextAsked.current) return
    nextAsked.current = true
    void (async () => {
      try {
        const made = await moveApi.createNext(auth.token, collectMovePrefs(localStorage))
        const stored = await storeNextInShell(made.publicUrl, made.code, made.expiresAt)
        setNextStored(stored.ok)
      } catch {
        setNextStored(false)
      }
    })()
  }, [next, auth.token])

  const showNextCode = async () => {
    setBusy(true)
    setError(null)
    try {
      setNextCode(await moveApi.createNext(auth.token, collectMovePrefs(localStorage)))
    } catch (failure) {
      setError(errorText(MOVE_ERRORS, failure))
    }
    setBusy(false)
  }

  const showMove = off && address.publicUrl !== null
  const showNext = next && (!nextHidden || nextCode !== null)
  useBanded(showMove || showNext || recoveryUsed || notice !== null)

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

  const copy = async (text: string | undefined = manual?.code) => {
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  if (!showMove && !showNext && !recoveryUsed && !notice) return null
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
      {showNext && (
        <div className="address-band next" role="status" data-testid="address-next" data-host={nextHost}>
          <div className="address-band-main">
            <span className="address-band-text">
              Trio’nun adresi yakında değişecek: <b>{nextHost}</b>
            </span>
            {!nextCode && !shellKeepsNextCode() && (
              <button
                type="button"
                className="address-band-action"
                data-testid="address-next-show"
                disabled={busy}
                onClick={() => void showNextCode()}
              >
                Taşınma kodunu göster
              </button>
            )}
            {!nextCode && (
              <button
                type="button"
                className="address-band-close"
                aria-label="Kapat"
                onClick={() => {
                  writeDismissed(address.nextUrl ?? null)
                  setDismissed(address.nextUrl ?? null)
                }}
              >
                ×
              </button>
            )}
          </div>
          {shellKeepsNextCode() ? (
            <p className="address-band-line" data-testid="address-next-shell">
              {nextStored
                ? 'Masaüstü uygulaması hazır: adres değişince yeni adrese kendisi geçer.'
                : 'Masaüstü uygulaması yeni adrese geçmek için hazırlanıyor…'}
            </p>
          ) : nextCode ? (
            <p className="address-band-line" data-testid="address-next-code">
              Bu kodu bir yere not al (7 gün geçerli, bir kez kullanılır):{' '}
              <code className="link-code" data-testid="address-next-code-value">
                {formatLinkCode(nextCode.code)}
              </code>{' '}
              <button type="button" className="link" onClick={() => void copy(nextCode.url)}>
                {copied ? 'Bağlantı kopyalandı' : 'Bağlantıyı kopyala'}
              </button>
              . Adres değişince bağlantıyı aç ya da yeni adreste “Zaten hesabım var”a kodu yaz.
            </p>
          ) : (
            <p className="address-band-line">
              Adres değişince bu cihazda yeniden giriş gerekir. Taşınma kodunu şimdi alırsan tek dokunuşla geçersin.
            </p>
          )}
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
              Trio menüsü › Sunucuyu değiştir… › <b>{host}</b>. Önce “Bu cihazı taşı”ya bas: çıkan kodu yeni
              adreste “Zaten hesabım var”a yazarsın.
            </p>
          )}
          {manual && (
            <p className="address-band-line" data-testid="address-manual">
              Trio menüsü › Sunucuyu değiştir… › <b>{manual.host}</b>, sonra “Zaten hesabım var”a bu kodu yaz:{' '}
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
