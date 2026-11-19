import { useEffect, useState, type FormEvent } from 'react'
import { api, ApiError, joinErrorMessage, loadLastName, type Auth } from '../api'
import { linkCodeProblem, normalizeLinkCode, tidyLinkCodeInput } from '../lib/linkCode'
import { rateLimitMessage } from '../lib/retryAfter'
import { desktopBridge } from '../ptt'
import { BrandMark } from './BrandMark'

export type JoinMode = 'invite' | 'link'

/**
 * The mode the join screen opens in. Somebody whose session was just ended
 * has an account; so, almost always, does somebody opening the desktop app
 * (they found it from the browser, where they are signed in).
 */
export function initialJoinMode(options: { desktop: boolean; sessionEnded: boolean; inviteLink?: boolean }): JoinMode {
  // An invite link says plainly what the person came for.
  if (options.inviteLink) return 'invite'
  return options.desktop || options.sessionEnded ? 'link' : 'invite'
}

export function JoinScreen({
  onJoined,
  notice,
  linkInvite = null,
}: {
  /** `inviteCode`: the invite code that worked, null for a device-code join. */
  onJoined: (auth: Auth, inviteCode: string | null) => void
  /** Why the person is back here (their session was ended elsewhere), or null. */
  notice?: string | null
  /** The code of an invite link (`#davet=…`) this page was opened with. */
  linkInvite?: string | null
}) {
  const desktop = desktopBridge() !== null
  const [mode, setMode] = useState<JoinMode>(() =>
    initialJoinMode({ desktop, sessionEnded: Boolean(notice), inviteLink: linkInvite !== null }),
  )
  const [name, setName] = useState(() => loadLastName() ?? '')
  const [code, setCode] = useState(linkInvite ?? '')
  /** The code came from the link and is not shown; "değiştir" opens the field. */
  const [codeFromLink, setCodeFromLink] = useState(linkInvite !== null)
  const [linkCode, setLinkCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** A rate limit in force: until when (ms), null for "the server did not say", undefined for none. */
  const [limitedUntil, setLimitedUntil] = useState<number | null | undefined>(undefined)
  const [now, setNow] = useState(() => Date.now())

  const limited = limitedUntil !== undefined
  const secondsLeft = limitedUntil == null ? null : Math.max(0, Math.ceil((limitedUntil - now) / 1000))
  const waiting = secondsLeft !== null && secondsLeft > 0

  useEffect(() => {
    if (limitedUntil == null) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [limitedUntil])

  const normalized = normalizeLinkCode(linkCode)
  const canSubmit =
    !busy && !waiting && (mode === 'invite' ? name.trim().length > 0 && code.length > 0 : normalized !== null)

  const switchMode = (next: JoinMode) => {
    if (next === mode) return
    setMode(next)
    setError(null)
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    setLimitedUntil(undefined)
    try {
      const result =
        mode === 'invite' ? await api.join(code, name.trim()) : await api.joinWithLinkCode(normalized ?? '')
      onJoined({ token: result.token, user: result.user }, mode === 'invite' ? code : null)
    } catch (failure) {
      // A wrong or old code from a link: back to the ordinary form, with the ordinary error.
      if (failure instanceof ApiError && failure.code === 'INVALID_INVITE') setCodeFromLink(false)
      if (failure instanceof ApiError && failure.code === 'RATE_LIMITED') {
        setNow(Date.now())
        setLimitedUntil(failure.retryAfter === null ? null : Date.now() + failure.retryAfter * 1000)
      } else {
        setError(joinErrorMessage(failure))
      }
      setBusy(false)
    }
  }

  const typedProblem = mode === 'link' ? linkCodeProblem(linkCode) : null
  const message = limited ? rateLimitMessage(secondsLeft) : (error ?? typedProblem)

  return (
    <main className="join">
      <form className="join-card" onSubmit={submit} data-testid="join-form" data-mode={mode}>
        <BrandMark size={56} className="join-brand" />
        <div className="join-logo" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <h1>Trio</h1>
        <p className="join-lead">Arkadaşlarınla yazış, konuş, ekranını paylaş.</p>

        {notice && (
          <p className="join-notice" role="status" data-testid="join-notice">
            {notice}
          </p>
        )}

        <div className="join-modes" role="tablist" aria-label="Nasıl gireceksin?">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'invite'}
            className={mode === 'invite' ? 'active' : undefined}
            data-testid="join-mode-invite"
            onClick={() => switchMode('invite')}
          >
            Yeni hesap
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'link'}
            className={mode === 'link' ? 'active' : undefined}
            data-testid="join-mode-link"
            onClick={() => switchMode('link')}
          >
            Zaten hesabım var
          </button>
        </div>

        {mode === 'invite' ? (
          <>
            <label htmlFor="join-name">İsim</label>
            <input
              id="join-name"
              data-testid="join-name"
              value={name}
              onChange={(event) => {
                setName(event.target.value)
                setError(null)
              }}
              maxLength={32}
              autoComplete="nickname"
              autoFocus
              placeholder="Sana ne diyelim?"
            />

            {codeFromLink ? (
              <p className="join-link-note" data-testid="join-code-from-link">
                Davet koduyla katılıyorsun.{' '}
                <button type="button" className="link" data-testid="join-code-change" onClick={() => setCodeFromLink(false)}>
                  değiştir
                </button>
              </p>
            ) : (
              <>
                <label htmlFor="join-code">Davet kodu</label>
                <input
                  id="join-code"
                  data-testid="join-code"
                  value={code}
                  onChange={(event) => {
                    setCode(event.target.value)
                    setError(null)
                  }}
                  type="password"
                  autoComplete="off"
                  placeholder="Arkadaşından aldığın kod"
                />
              </>
            )}
          </>
        ) : (
          <>
            {desktop && (
              <p className="join-hint desktop" data-testid="join-desktop-hint">
                Masaüstü uygulaması ayrı bir cihaz sayılır: tarayıcıda açık hesabından bir cihaz kodu al.
              </p>
            )}
            <label htmlFor="join-link-code">Cihaz kodu</label>
            <input
              id="join-link-code"
              data-testid="join-link-code"
              className="link-code-input"
              value={linkCode}
              onChange={(event) => {
                // What the server said was about the code as it was; it no longer applies.
                setLinkCode(tidyLinkCodeInput(event.target.value))
                setError(null)
              }}
              autoComplete="one-time-code"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              autoFocus
              placeholder="ABCDE-FGHJK"
              aria-describedby="join-link-help"
            />
            <p className="join-hint" id="join-link-help">
              Giriş yaptığın diğer cihazda Ayarlar › Hesap › “Cihaz ekle”ye bas ve çıkan kodu buraya yaz. Kod 10
              dakika geçerlidir, bir kez kullanılır.
            </p>
          </>
        )}

        {message && (
          <p className="form-error" role="alert" data-testid="join-error">
            {message}
          </p>
        )}

        <button type="submit" className="primary" data-testid="join-submit" disabled={!canSubmit}>
          {busy ? (mode === 'invite' ? 'Katılınıyor…' : 'Giriliyor…') : mode === 'invite' ? 'Katıl' : 'Giriş yap'}
        </button>
      </form>
    </main>
  )
}
