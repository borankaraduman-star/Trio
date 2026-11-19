import { useCallback, useState } from 'react'
import { clearAuth, clearInviteCode, loadAuth, saveAuth, saveInviteCode, saveLastName, type Auth } from './api'
import { takeInviteFromLocation } from './lib/inviteLink'
import { takeDeviceCodeFromLocation } from './lib/deviceLink'
import { JoinScreen } from './components/JoinScreen'
import { Session } from './components/Session'
import { clearStoredState } from './store'
import { PersistenceBand } from './components/owner/PersistenceBand'
import { sessionEndedNotice } from './lib/persistence'
import { fetchHealth, loadKnownDataSince } from './owner/healthStore'

/** Shown on the join screen when the server ended this device's session (CONTRACT-V3 §2, §3). */
export const SESSION_ENDED_NOTICE =
  'Bu cihazdaki oturum kapatıldı. Hesabın duruyorsa, giriş yaptığın başka bir cihazdan cihaz kodu alıp “Zaten hesabım var” ile yeniden girebilirsin.'

export function App() {
  const [auth, setAuth] = useState<Auth | null>(loadAuth)
  const [notice, setNotice] = useState<string | null>(null)
  // An invite link's code, read (and taken out of the address bar) on load, signed in or not.
  const [linkInvite, setLinkInvite] = useState(takeInviteFromLocation)
  // V7-READING §7: a device code's link (`#cihaz=`), the same way.
  const [linkDeviceCode, setLinkDeviceCode] = useState(takeDeviceCodeFromLocation)

  const onJoined = useCallback((next: Auth, inviteCode: string | null) => {
    saveAuth(next)
    saveLastName(next.user.name)
    // Kept to share as a link from Ayarlar › Hesap; a device-code join does not know it.
    if (inviteCode !== null) saveInviteCode(inviteCode)
    setNotice(null)
    // Used once: a later sign-out does not bring the link's code back.
    setLinkInvite(null)
    setLinkDeviceCode(null)
    setAuth(next)
  }, [])

  const forget = useCallback(() => {
    clearAuth()
    clearInviteCode()
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
    const known = loadKnownDataSince()
    setNotice(SESSION_ENDED_NOTICE)
    forget()
    // V6-OPS §7: another database than the one this session lived in: the server was reset.
    void fetchHealth().then(({ dataSince }) => {
      const text = sessionEndedNotice(known, dataSince, SESSION_ENDED_NOTICE)
      setNotice((current) => (current === SESSION_ENDED_NOTICE ? text : current))
    })
  }, [forget])

  // Keyed by the notice, so a join screen reached a second way starts in the right mode.
  // V6-OPS §7: the not-persistent band sits above both screens.
  return (
    <>
      <PersistenceBand />
      {auth ? (
        // Keyed by token: a different account never inherits the previous one's state.
        <Session key={auth.token} auth={auth} onSignedOut={onSignedOut} onSessionEnded={onSessionEnded} />
      ) : (
        <JoinScreen key={notice ?? ''} onJoined={onJoined} notice={notice} linkInvite={linkInvite} linkDeviceCode={linkDeviceCode} />
      )}
    </>
  )
}
