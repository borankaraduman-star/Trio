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
  /** v4: the picture cropper is open, or a name (own or the server's) is typed but not saved. */
  profileEdit: boolean
  /**
   * v4: a message being edited in place, a reply being composed, or the emoji
   * picker, the action menu/sheet, the delete confirmation or the pins panel
   * open (see `messageFamilyBusy`).
   */
  messageAction: boolean
  /** V4 A4: somebody is calling me into voice (the ring band is up). */
  ringing: boolean
  /** V4 A3: Ayarlar › Bağlantı testi is measuring (microphone, TURN probe, the call's stats). */
  connectionTest: boolean
}

export type ReloadBlocker = keyof ReloadState

/** The first thing a reload would lose, or null when it is safe. */
export function reloadBlocker(state: ReloadState): ReloadBlocker | null {
  for (const key of [
    'inCall',
    'dialogOpen',
    'pendingFiles',
    'draft',
    'unsentMessages',
    'profileEdit',
    'messageAction',
    'ringing',
    'connectionTest',
  ] as const) {
    if (state[key]) return key
  }
  return null
}

/** What the message family (useMessageFamily, MessageFamilyLayer) has open. */
export interface MessageFamilyOpen {
  /** The message being edited in place, or null. */
  editing: unknown
  /** The message a reply is being composed to, or null. */
  reply: unknown
  pinsOpen: boolean
  /** The emoji picker, the action menu or sheet, or the delete confirmation. */
  overlayOpen: boolean
}

/** Whether a reload would throw away something the person is doing with a message. */
export function messageFamilyBusy(open: MessageFamilyOpen): boolean {
  return open.editing != null || open.reply != null || open.pinsOpen || open.overlayOpen
}
