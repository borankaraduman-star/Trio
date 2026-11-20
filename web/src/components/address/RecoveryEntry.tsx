import { useState, type FormEvent } from 'react'
import type { Auth } from '../../api'
import { errorText, RECOVERY_ERRORS, RECOVERY_MIN_LENGTH, recover } from '../../lib/address'

/** CONTRACT-V11-ADDRESS §6: "Zaten hesabım var" › the owner's recovery code. */
export function RecoveryEntry({ onJoined }: { onJoined: (auth: Auth, inviteCode: string | null) => void }) {
  const [open, setOpen] = useState(false)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!open) {
    return (
      <button type="button" className="link recovery-open" data-testid="recovery-open" onClick={() => setOpen(true)}>
        Sunucunun sahibiysen: kurtarma kodu
      </button>
    )
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    event.stopPropagation()
    if (busy || code.trim().length < RECOVERY_MIN_LENGTH) return
    setBusy(true)
    setError(null)
    try {
      const result = await recover(code.trim())
      onJoined({ token: result.token, user: result.user }, null)
    } catch (failure) {
      setError(errorText(RECOVERY_ERRORS, failure))
      setBusy(false)
    }
  }

  // Not a nested <form> (the join card is one): Enter and the button both call submit.
  return (
    <div className="recovery-entry" data-testid="recovery-entry">
      <label htmlFor="recovery-code">Kurtarma kodu</label>
      <input
        id="recovery-code"
        data-testid="recovery-code"
        type="password"
        autoComplete="off"
        value={code}
        onChange={(event) => {
          setCode(event.target.value)
          setError(null)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void submit(event)
        }}
        placeholder="Railway’de TRIO_RECOVERY_CODE’a yazdığın değer"
      />
      <p className="join-hint">
        Bütün cihazların gittiyse: hosting panelinde (Railway › Variables) TRIO_RECOVERY_CODE’a uzun, rastgele bir
        değer yaz, sunucu yeniden başlasın, aynı değeri buraya gir. Girdikten sonra değişkeni sil.
      </p>
      {error && (
        <p className="form-error" role="alert" data-testid="recovery-error">
          {error}
        </p>
      )}
      <button
        type="button"
        className="secondary"
        data-testid="recovery-submit"
        disabled={busy || code.trim().length < RECOVERY_MIN_LENGTH}
        onClick={(event) => void submit(event)}
      >
        {busy ? 'Giriliyor…' : 'Kurtarma koduyla gir'}
      </button>
    </div>
  )
}
