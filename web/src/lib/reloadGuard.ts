/**
 * Whether reloading onto a newer build right now would cost the person
 * something. The reload after a reconnect (lib/buildCheck.ts) is a surprise
 * to whoever is looking at the page, so it only happens when nothing in
 * memory would be lost by it; otherwise the next reconnect asks again.
 */
export interface ReloadState {
  /** In a voice room (or joining one): a reload drops the call. */
  inCall: boolean
  /** Settings (a device code counting down, a setting being changed) or the sign-out dialog. */
  dialogOpen: boolean
  /** Files chosen for a message: uploading, waiting, done but not sent, or in error. */
  pendingFiles: boolean
  /** Text in the composer that was not sent. */
  draft: boolean
  /** A message still sending or failed: it exists only in this page. */
  unsentMessages: boolean
}

export type ReloadBlocker = keyof ReloadState

/** The first thing a reload would lose, or null when it is safe. */
export function reloadBlocker(state: ReloadState): ReloadBlocker | null {
  for (const key of ['inCall', 'dialogOpen', 'pendingFiles', 'draft', 'unsentMessages'] as const) {
    if (state[key]) return key
  }
  return null
}
