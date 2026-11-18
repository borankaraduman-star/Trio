import { useCallback, useState } from 'react'
import { clearAuth, loadAuth, saveAuth, type Auth } from './api'
import { JoinScreen } from './components/JoinScreen'
import { Session } from './components/Session'
import { clearStoredState } from './store'

/** Shown on the join screen when the server ended this device's session (CONTRACT-V3 §2, §3). */
export const SESSION_ENDED_NOTICE =
  'Bu cihazdaki oturum kapatıldı. Hesabın duruyorsa, giriş yaptığın başka bir cihazdan cihaz kodu alıp “Zaten hesabım var” ile yeniden girebilirsin.'

export function App() {
  const [auth, setAuth] = useState<Auth | null>(loadAuth)
  const [notice, setNotice] = useState<string | null>(null)

  const onJoined = useCallback((next: Auth) => {
    saveAuth(next)
    setNotice(null)
    setAuth(next)
  }, [])

  const forget = useCallback(() => {
    clearAuth()
    clearStoredState()
    setAuth(null)
  }, [])

  /** The person signed out here (the server has been told already). */
  const onSignedOut = useCallback(() => {
    setNotice(null)
    forget()
  }, [forget])

  /** The server no longer accepts this token: signed out from elsewhere, revoked or removed. */
  const onSessionEnded = useCallback(() => {
    setNotice(SESSION_ENDED_NOTICE)
    forget()
  }, [forget])

  // Keyed by the notice, so a join screen reached a second way starts in the right mode.
  if (!auth) return <JoinScreen key={notice ?? ''} onJoined={onJoined} notice={notice} />
  // Keyed by token: a different account never inherits the previous one's state.
  return <Session key={auth.token} auth={auth} onSignedOut={onSignedOut} onSessionEnded={onSessionEnded} />
}
