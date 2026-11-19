/**
 * Everything Session needs for CONTRACT-V4 C, in one hook so that Session
 * itself changes by a few lines: the profile and server actions the settings
 * use, what the reload guard must know (a cropper open, a name typed), and
 * keeping what this device remembers (`trio.user`, `trio.lastName`) in step
 * with a rename.
 */
import { useCallback, useEffect, useMemo, useRef, type Dispatch } from 'react'
import { ApiError, saveAuth, saveLastName } from './api'
import { isViewing } from './lib/viewing'
import { profileApi } from './lib/profileApi'
import type { ServerProfile, User } from './types'
import type { Action } from './store'
import type { ProfileProps } from './components/ProfileFields'
import type { ServerSettingsProps } from './components/ServerSection'

export function useIdentity({
  token,
  me,
  server,
  ready,
  dispatch,
  onLogout,
}: {
  token: string
  me: User
  server: ServerProfile
  ready: boolean
  dispatch: Dispatch<Action>
  onLogout: () => void
}): {
  profile: ProfileProps
  serverSettings: ServerSettingsProps
  /** Something about the profile is being edited (for lib/reloadGuard.ts). */
  editing: () => boolean
} {
  const edits = useRef(new Set<string>())
  const onEditing = useCallback((key: string, on: boolean) => {
    if (on) edits.current.add(key)
    else edits.current.delete(key)
  }, [])
  const editing = useCallback(() => edits.current.size > 0, [])

  /** The answer of a change, applied at once (the broadcast that follows changes nothing). */
  const applyUser = useCallback(
    (user: User) => dispatch({ type: 'server', event: { type: 'user.updated', user }, now: Date.now(), viewing: isViewing() }),
    [dispatch],
  )
  const applyServer = useCallback(
    (next: ServerProfile) =>
      dispatch({ type: 'server', event: { type: 'server.updated', server: next }, now: Date.now(), viewing: isViewing() }),
    [dispatch],
  )
  const guard = useCallback(
    async <T,>(work: () => Promise<T>): Promise<T> => {
      try {
        return await work()
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) onLogout()
        throw error
      }
    },
    [onLogout],
  )

  const profile = useMemo<ProfileProps>(
    () => ({
      me,
      onEditing,
      rename: async (name) => {
        const { user } = await guard(() => profileApi.rename(token, name))
        applyUser(user)
        return user.name
      },
      setAvatar: async (blob, ext) => applyUser((await guard(() => profileApi.setAvatar(token, blob, ext))).user),
      removeAvatar: async () => applyUser((await guard(() => profileApi.removeAvatar(token))).user),
    }),
    [me, onEditing, guard, applyUser, token],
  )

  const serverSettings = useMemo<ServerSettingsProps>(
    () => ({
      server,
      onEditing,
      rename: async (name) => {
        const result = await guard(() => profileApi.renameServer(token, name))
        applyServer(result.server)
        return result.server.name
      },
      setIcon: async (blob, ext) => applyServer((await guard(() => profileApi.setServerIcon(token, blob, ext))).server),
      removeIcon: async () => applyServer((await guard(() => profileApi.removeServerIcon(token))).server),
    }),
    [server, onEditing, guard, applyServer, token],
  )

  // A rename (here or on another device) is what this device remembers too:
  // the stored session's user, and the name the join screen offers next time.
  const stored = useRef({ name: me.name })
  useEffect(() => {
    if (!ready || me.name === stored.current.name) return
    stored.current = { name: me.name }
    saveAuth({ token, user: { id: me.id, name: me.name } })
    saveLastName(me.name)
  }, [ready, me.id, me.name, token])

  return { profile, serverSettings, editing }
}
