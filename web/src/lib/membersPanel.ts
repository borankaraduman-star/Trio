/**
 * CONTRACT-V10-GROUPS §4a: the member panel can be shown and hidden at every
 * width from "Üyeler (n)" in the channel header. Wide (> 960 px) it is the
 * column, remembered per device (`trio.v10.membersHidden` = "1" while hidden);
 * narrower it opens over the chat and always starts closed.
 */
export const MEMBERS_HIDDEN_KEY = 'trio.v10.membersHidden'

export function loadMembersHidden(storage: Pick<Storage, 'getItem'> = localStorage): boolean {
  try {
    return storage.getItem(MEMBERS_HIDDEN_KEY) === '1'
  } catch {
    return false
  }
}

export function saveMembersHidden(hidden: boolean, storage: Pick<Storage, 'setItem' | 'removeItem'> = localStorage): void {
  try {
    if (hidden) storage.setItem(MEMBERS_HIDDEN_KEY, '1')
    else storage.removeItem(MEMBERS_HIDDEN_KEY)
  } catch {
    // Private mode: the choice holds for this page only.
  }
}

/** "Üyeler — 5 çevrimiçi" (the panel's title) */
export function membersTitle(online: number): string {
  return `Üyeler — ${online} çevrimiçi`
}
