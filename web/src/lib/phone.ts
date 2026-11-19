/**
 * CONTRACT-V7-PHONE: the widths the phone layout follows, whether this
 * browser can share a screen at all, and the stage's remembered collapse.
 * Pure helpers and one hook; no React state lives here.
 */
import { useSyncExternalStore } from 'react'

/** At or under this the sidebar is a drawer (styles.css): the call bar and the header presence show. */
export const PHONE_QUERY = '(max-width: 680px)'
/** At or under this the member list column is hidden (styles.css): presence moves into the sidebar. */
export const NO_MEMBERS_QUERY = '(max-width: 960px)'

function subscribeTo(query: string) {
  return (onChange: () => void) => {
    if (typeof window.matchMedia !== 'function') return () => undefined
    const list = window.matchMedia(query)
    list.addEventListener('change', onChange)
    return () => list.removeEventListener('change', onChange)
  }
}

function matches(query: string): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(query).matches
}

const subscribers = new Map<string, (onChange: () => void) => () => void>()

/** Whether a media query matches now, re-rendering when it changes. */
export function useMediaQuery(query: string): boolean {
  let subscribe = subscribers.get(query)
  if (!subscribe) {
    subscribe = subscribeTo(query)
    subscribers.set(query, subscribe)
  }
  return useSyncExternalStore(subscribe, () => matches(query), () => false)
}

/**
 * Whether this browser can share a screen. Most phones cannot (no
 * `getDisplayMedia`); every share control is left out there rather than
 * offered and refused.
 */
export function screenShareSupported(media: { getDisplayMedia?: unknown } | undefined = navigator.mediaDevices): boolean {
  return typeof media?.getDisplayMedia === 'function'
}

export const STAGE_COLLAPSED_KEY = 'trio.v7.stageCollapsed'

export function loadStageCollapsed(storage: Pick<Storage, 'getItem'> = localStorage): boolean {
  try {
    return storage.getItem(STAGE_COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

export function saveStageCollapsed(collapsed: boolean, storage: Pick<Storage, 'setItem' | 'removeItem'> = localStorage): void {
  try {
    if (collapsed) storage.setItem(STAGE_COLLAPSED_KEY, '1')
    else storage.removeItem(STAGE_COLLAPSED_KEY)
  } catch {
    // Private mode or full storage: the choice holds for this page only.
  }
}

/** "Konuşuyor: Ayşe, Sen" / "3 kişi" — the call bar's second line. */
export function talkingLine(speakingIds: readonly number[], me: number, participantCount: number, nameOf: (id: number) => string): string {
  const names = speakingIds.map((id) => (id === me ? 'Sen' : nameOf(id)))
  if (names.length > 0) return `Konuşuyor: ${names.join(', ')}`
  return participantCount <= 1 ? 'Odada yalnızsın' : `${participantCount} kişi`
}

export interface StageCounts {
  remoteScreens: readonly { userId: number }[]
  hiddenScreens: Record<number, unknown>
  remoteCameras: readonly { userId: number }[]
  localScreen: unknown
  localCamera: unknown
}

/** What the stage is showing now, as the collapsed pill names it ("Mehmet ekranı", "Sen"). */
export function stageSources(input: StageCounts, nameOf: (id: number) => string): string[] {
  const out: string[] = []
  for (const media of input.remoteScreens) {
    if (input.hiddenScreens[media.userId] === undefined) out.push(`${nameOf(media.userId)} ekranı`)
  }
  for (const media of input.remoteCameras) out.push(`${nameOf(media.userId)} kamerası`)
  if (input.localScreen) out.push('Senin ekranın')
  if (input.localCamera) out.push('Senin kameran')
  return out
}
