import { useState, type FormEvent } from 'react'
import { api, joinErrorMessage, type Auth } from '../api'
import { BrandMark } from './BrandMark'

export function JoinScreen({ onJoined }: { onJoined: (auth: Auth) => void }) {
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canSubmit = name.trim().length > 0 && code.length > 0 && !busy

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    try {
      const result = await api.join(code, name.trim())
      onJoined({ token: result.token, user: result.user })
    } catch (failure) {
      setError(joinErrorMessage(failure))
      setBusy(false)
    }
  }

  return (
    <main className="join">
      <form className="join-card" onSubmit={submit}>
        <BrandMark size={56} className="join-brand" />
        <div className="join-logo" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <h1>Trio</h1>
        <p className="join-lead">Arkadaşlarınla yazış, konuş, ekranını paylaş.</p>

        <label htmlFor="join-name">İsim</label>
        <input
          id="join-name"
          data-testid="join-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={32}
          autoComplete="nickname"
          autoFocus
          placeholder="Sana ne diyelim?"
        />

        <label htmlFor="join-code">Davet kodu</label>
        <input
          id="join-code"
          data-testid="join-code"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          type="password"
          autoComplete="off"
          placeholder="Arkadaşından aldığın kod"
        />

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        <button type="submit" className="primary" data-testid="join-submit" disabled={!canSubmit}>
          {busy ? 'Katılınıyor…' : 'Katıl'}
        </button>
      </form>
    </main>
  )
}
