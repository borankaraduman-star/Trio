/**
 * Whether the person is looking at the page right now.
 *
 * Visible is not enough: a browser window behind another one is "visible",
 * and the desktop app keeps its page visible while it sits in the tray
 * (background throttling is off). Only a visible AND focused page counts as
 * read; anything else counts unread and may notify.
 */
export interface ViewingDocument {
  visibilityState: DocumentVisibilityState
  hasFocus(): boolean
}

export function isViewing(doc: ViewingDocument = document): boolean {
  return doc.visibilityState === 'visible' && doc.hasFocus()
}

/** Calls `onChange` whenever being looked at may have changed. Returns the cleanup. */
export function onViewingChange(onChange: () => void): () => void {
  document.addEventListener('visibilitychange', onChange)
  window.addEventListener('focus', onChange)
  window.addEventListener('blur', onChange)
  return () => {
    document.removeEventListener('visibilitychange', onChange)
    window.removeEventListener('focus', onChange)
    window.removeEventListener('blur', onChange)
  }
}
