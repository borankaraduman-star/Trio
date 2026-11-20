/**
 * CONTRACT-V4 A4: calling friends into voice. Pure state machines, unit-tested
 * in ring.test.ts; Session.tsx feeds them events and draws the band.
 *
 * Receiving: a `voice.ring {channel_id, from}` shows a band "X seni <kanal>
 * odasına çağırıyor — Katıl / Kapat" and plays the ringtone. The SOUND lasts
 * at most RING_SOUND_MS; the band stays until Katıl, Kapat, my joining any
 * voice room, the ringer leaving that room, or RING_BAND_MS. A second ring
 * replaces the first.
 */

export const RING_SOUND_MS = 20_000
export const RING_BAND_MS = 120_000
/** The server allows one ring per user per 30 s; the button waits as long. */
export const RING_COOLDOWN_MS = 30_000

export interface IncomingRing {
  channelId: number
  from: number
  at: number
}

export type RingEvent =
  | { type: 'ring'; channelId: number; from: number; now: number; myVoiceChannel: number | null }
  /** I joined (or am joining) a voice room. */
  | { type: 'self-joined' }
  | { type: 'dismiss' }
  /** `from` is no longer in `channelId` (voice.left, or joined another room). */
  | { type: 'left'; userId: number; channelId: number }
  | { type: 'tick'; now: number }

export function reduceRing(state: IncomingRing | null, event: RingEvent): IncomingRing | null {
  switch (event.type) {
    case 'ring':
      // Already there (the server does not send it then; a race can).
      if (event.myVoiceChannel === event.channelId) return state
      return { channelId: event.channelId, from: event.from, at: event.now }
    case 'self-joined':
    case 'dismiss':
      return null
    case 'left':
      return state && state.from === event.userId && state.channelId === event.channelId ? null : state
    case 'tick':
      return state && event.now - state.at >= RING_BAND_MS ? null : state
  }
}

/** Whether the ringtone should be sounding for this ring now. */
export function ringSounding(
  ring: IncomingRing | null,
  now: number,
  opts: { doNotDisturb: boolean; deafened: boolean },
): boolean {
  if (!ring || opts.doNotDisturb || opts.deafened) return false
  return now - ring.at < RING_SOUND_MS
}

/** Milliseconds until the "Çağır" button may be used again (0 = now). */
export function ringCooldownLeft(lastRingAt: number | null, now: number): number {
  if (lastRingAt === null) return 0
  return Math.max(0, RING_COOLDOWN_MS - (now - lastRingAt))
}

/** The Turkish sentence for a refused `voice.ring`. */
export function ringErrorMessage(code: string): string {
  switch (code) {
    case 'RATE_LIMITED':
      return 'Az önce çağırdın; 30 saniyede bir çağırabilirsin.'
    case 'NOT_IN_VOICE':
      return 'Çağırmak için ses odasında olmalısın.'
    case 'INVALID_CHANNEL':
      return 'Bu ses odası bulunamadı.'
    case 'ROOM_FULL':
      return 'Oda dolu: çağırdığın kimse katılamaz.'
    default:
      return 'Çağrı gönderilemedi.'
  }
}

/**
 * "X ses odasına girdi" (A4): a room went from empty to one person. Given the
 * room's members before and after a voice.joined, the joiner when it is that
 * case and the joiner is not me.
 */
export function roomOpenedBy(
  before: readonly number[],
  after: readonly number[],
  joiner: number,
  myId: number,
): number | null {
  if (joiner === myId) return null
  if (before.length !== 0 || after.length !== 1 || after[0] !== joiner) return null
  return joiner
}
