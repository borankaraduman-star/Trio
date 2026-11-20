import { useEffect, useState } from 'react'
import { api, type Auth } from '../../api'
import { errorText, MOVE_ERRORS, moveApi } from '../../lib/address'
import type { User } from '../../types'
import { BrandMark } from '../BrandMark'

/**
 * CONTRACT-V11-ADDRESS §3, on the canonical address with `#tasi=<code>`,
 * signed out: one screen that names the account (from the server, never from
 * the link) and redeems nothing until the person taps "Devam et".
 */
export function MoveArrival({
  code,
  onJoined,
  onCancel,
}: {
  code: string
  onJoined: (auth: Auth) => void
  onCancel: () => void
}) {
  const [who, setWho] = useState<User | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    moveApi
      .peek(code)
      .then((peek) => live && setWho(peek.user))
      .catch((failure) => live && setError(errorText(MOVE_ERRORS, failure)))
    return () => {
      live = false
    }
  }, [code])

  const go = async () => {
    setBusy(true)
    setError(null)
    try {
      // The join path redeems a move code, applies the carried preferences and ends the old session.
      const result = await api.joinWithLinkCode(code)
      onJoined({ token: result.token, user: result.user })
    } catch (failure) {
      setError(errorText(MOVE_ERRORS, failure))
      setBusy(false)
    }
  }

  return (
    <main className="join">
      <div className="join-card address-arrival" data-testid="move-arrival">
        <BrandMark size={56} className="join-brand living" />
        <h1>Trio’nun yeni adresi</h1>
        {who ? (
          <>
            <p className="join-lead" data-testid="move-arrival-who">
              Bu cihazda <b>{who.name}</b> olarak devam et
            </p>
            <p className="join-hint">
              Ayarların ve taslakların eski adresten geliyor. Eski adresteki oturum bu cihazda kapanır.
            </p>
            <button type="button" className="primary" data-testid="move-arrival-go" disabled={busy} onClick={() => void go()}>
              {busy ? 'Giriliyor…' : 'Devam et'}
            </button>
          </>
        ) : (
          !error && <p className="join-hint">Bakılıyor…</p>
        )}
        {error && (
          <p className="form-error" role="alert" data-testid="move-arrival-error">
            {error}
          </p>
        )}
        <button type="button" className="link" data-testid="move-arrival-cancel" onClick={onCancel}>
          {who && !error ? 'Vazgeç' : 'Giriş ekranına dön'}
        </button>
      </div>
    </main>
  )
}
