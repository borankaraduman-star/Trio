import { useEffect, useRef, type Dispatch, type MutableRefObject } from 'react'
import { readsToSend } from './lib/readState'
import type { Action, AppState } from './store'
import type { ClientEvent } from './types'

/** At most one round of `channel.read` frames per this long (a busy channel moves the mark often). */
export const READ_SEND_MS = 400

/**
 * CONTRACT-V7-READING: every mark this device moved forward is told to the
 * server (which tells my other devices). A frame the socket could not take is
 * simply sent again later: after the next `ready`, the server's marks are
 * known again and whatever is still ahead goes out.
 */
export function useReadSync(
  socket: { send(event: ClientEvent): boolean },
  state: AppState,
  stateRef: MutableRefObject<AppState>,
  dispatch: Dispatch<Action>,
): void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { readSync, connection, lastRead, serverRead } = state
  useEffect(() => {
    if (!readSync || connection !== 'open' || timer.current !== null) return
    const textIds = stateRef.current.channels.filter((c) => c.kind === 'text').map((c) => c.id)
    if (readsToSend(lastRead, serverRead, textIds).length === 0) return
    timer.current = setTimeout(() => {
      timer.current = null
      const current = stateRef.current
      if (!current.readSync || current.connection !== 'open') return
      const ids = current.channels.filter((c) => c.kind === 'text').map((c) => c.id)
      for (const [channelId, messageId] of readsToSend(current.lastRead, current.serverRead, ids)) {
        if (socket.send({ type: 'channel.read', channel_id: channelId, message_id: messageId })) {
          dispatch({ type: 'read.sent', channelId, messageId })
        }
      }
    }, READ_SEND_MS)
  }, [readSync, connection, lastRead, serverRead, socket, stateRef, dispatch])
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current)
    },
    [],
  )
}
