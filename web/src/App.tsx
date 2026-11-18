import { useCallback, useState } from 'react'
import { clearAuth, loadAuth, saveAuth, type Auth } from './api'
import { JoinScreen } from './components/JoinScreen'
import { Session } from './components/Session'
import { clearStoredState } from './store'

export function App() {
  const [auth, setAuth] = useState<Auth | null>(loadAuth)

  const onJoined = useCallback((next: Auth) => {
    saveAuth(next)
    setAuth(next)
  }, [])

  const onLogout = useCallback(() => {
    clearAuth()
    clearStoredState()
    setAuth(null)
  }, [])

  if (!auth) return <JoinScreen onJoined={onJoined} />
  // Keyed by token: a different account never inherits the previous one's state.
  return <Session key={auth.token} auth={auth} onLogout={onLogout} />
}
