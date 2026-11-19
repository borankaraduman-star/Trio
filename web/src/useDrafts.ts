import { useCallback, useEffect, useMemo, useRef, type MutableRefObject } from 'react'
import { anyText, loadDrafts, saveDrafts, withDraft, type Drafts } from './lib/drafts'
import type { AppState } from './store'
import type { Message } from './types'

export interface DraftsApi {
  textOf: (channelId: number) => string
  setText: (channelId: number, text: string) => void
  clear: (channelId: number) => void
  /** Unsent text in any channel (the reload guard's "draft"). */
  anyText: () => boolean
}

/**
 * Drafts per channel (CONTRACT-V6-MEDIA §5, lib/drafts.ts). The text is
 * written as it is typed; the reply target follows the message family's reply
 * (one at a time, for the open channel): saved while a channel is open, and
 * started again when the channel is opened again or the tab is reloaded.
 */
export function useDrafts(
  activeChannelId: number | null,
  reply: Message | null,
  actions: { startReply: (message: Message) => void },
  stateRef: MutableRefObject<AppState>,
): DraftsApi {
  const drafts = useRef<Drafts>(loadDrafts())
  const shownChannel = useRef<number | null>(null)

  const update = useCallback((channelId: number, change: (d: { text: string; reply: Message | null }) => { text: string; reply: Message | null }) => {
    const current = drafts.current[channelId] ?? { text: '', reply: null }
    drafts.current = withDraft(drafts.current, channelId, change(current))
    saveDrafts(drafts.current)
  }, [])

  useEffect(() => {
    if (activeChannelId === null) return
    if (shownChannel.current !== activeChannelId) {
      // Another channel opened (or the first after a load): its reply comes back.
      shownChannel.current = activeChannelId
      const saved = drafts.current[activeChannelId]?.reply
      if (saved && !stateRef.current.deleted[saved.id] && reply?.id !== saved.id) actions.startReply(saved)
      return
    }
    update(activeChannelId, (d) => ({ ...d, reply }))
  }, [activeChannelId, reply, actions, stateRef, update])

  return useMemo(
    () => ({
      textOf: (channelId) => drafts.current[channelId]?.text ?? '',
      setText: (channelId, text) => update(channelId, (d) => ({ ...d, text })),
      clear: (channelId) => {
        drafts.current = withDraft(drafts.current, channelId, { text: '', reply: null })
        saveDrafts(drafts.current)
      },
      anyText: () => anyText(drafts.current),
    }),
    [update],
  )
}
