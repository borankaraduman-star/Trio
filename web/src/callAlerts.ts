import { cues, type CuePlayer, type CueKind } from './audio/cues'
import {
  reduceRing,
  ringErrorMessage,
  roomOpenedBy,
  RING_SOUND_MS,
  type IncomingRing,
  type RingEvent,
} from './lib/ring'
import type { Settings } from './settings'
import type { ServerEvent } from './types'

/**
 * CONTRACT-V4 A4 around the call: rings in and out, cue sounds, and the "X
 * ses odasına girdi" notification. Framework-free like the voice engine;
 * Session feeds it server events and the user's own mute/deafen actions and
 * draws `getSnapshot()`.
 */

export interface CallAlertsSnapshot {
  incoming: IncomingRing | null
  lastRingAt: number | null
  ringError: string | null
}

export interface CallAlertsDeps {
  myId: number
  send: (event: { type: 'voice.ring'; channel_id: number }) => boolean
  settings: () => Pick<Settings, 'cuesEnabled' | 'cueVolume' | 'doNotDisturb' | 'outputDeviceId'>
  viewing: () => boolean
  /** The room this tab is in (joining or connected), or null. */
  myVoiceChannel: () => number | null
  /** In a room and connected: joins/leaves of others are cued then. */
  inCall: () => boolean
  deafened: () => boolean
  nameOf: (userId: number) => string
  channelName: (channelId: number) => string
  /** A browser Notification, when allowed (the caller checks the permission). */
  notify: (title: string, body: string, tag: string, silent: boolean) => void
  player?: CuePlayer
  now?: () => number
}

const TICK_MS = 1000

export class CallAlerts {
  private readonly listeners = new Set<() => void>()
  private snapshot: CallAlertsSnapshot = { incoming: null, lastRingAt: null, ringError: null }
  private tick: ReturnType<typeof setInterval> | null = null
  private readonly player: CuePlayer
  private readonly now: () => number

  constructor(private readonly deps: CallAlertsDeps) {
    this.player = deps.player ?? cues
    this.now = deps.now ?? Date.now
    this.refreshPrefs()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): CallAlertsSnapshot => this.snapshot

  private set(patch: Partial<CallAlertsSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of [...this.listeners]) listener()
  }

  /** Settings, deafen or the output device changed. */
  refreshPrefs(): void {
    const settings = this.deps.settings()
    this.player.setPrefs({
      enabled: settings.cuesEnabled,
      volume: settings.cueVolume,
      deafened: this.deps.deafened(),
    })
    this.player.setOutput(settings.outputDeviceId)
    this.syncRingSound()
  }

  destroy(): void {
    this.player.stopRing()
    if (this.tick !== null) clearInterval(this.tick)
    this.tick = null
    this.listeners.clear()
  }

  // --- my own actions ------------------------------------------------------

  /** After the user's own mute or deafen click: the cue for what changed. */
  selfChanged(before: { muted: boolean; deafened: boolean }, after: { muted: boolean; deafened: boolean }): void {
    this.refreshPrefs()
    let kind: Exclude<CueKind, 'ring'> | null = null
    if (before.deafened !== after.deafened) kind = after.deafened ? 'deafen' : 'undeafen'
    else if (before.muted !== after.muted) kind = after.muted ? 'mute' : 'unmute'
    if (kind) this.player.play(kind)
  }

  /** "Çağır". */
  ring(channelId: number): void {
    if (!this.deps.send({ type: 'voice.ring', channel_id: channelId })) {
      this.set({ ringError: 'Sunucu bağlantısı yok; bağlantı gelince yeniden dene.' })
      return
    }
    this.set({ lastRingAt: this.now(), ringError: null })
  }

  /** The user joined a room (Katıl, or any join): the band and its sound go. */
  selfJoined(): void {
    this.apply({ type: 'self-joined' })
  }

  dismiss(): void {
    this.apply({ type: 'dismiss' })
  }

  // --- the server ------------------------------------------------------------

  /**
   * `membersBefore` is the channel's members as the store had them BEFORE this
   * event (for "the room went from empty to one person").
   */
  handleEvent(event: ServerEvent, membersBefore: (channelId: number) => readonly number[]): void {
    switch (event.type) {
      case 'voice.ring': {
        if (typeof event.channel_id !== 'number' || typeof event.from !== 'number') return
        if (event.from === this.deps.myId) return
        const previous = this.snapshot.incoming
        this.apply({
          type: 'ring',
          channelId: event.channel_id,
          from: event.from,
          now: this.now(),
          myVoiceChannel: this.deps.myVoiceChannel(),
        })
        const incoming = this.snapshot.incoming
        if (incoming && incoming !== previous && !this.deps.viewing() && !this.deps.settings().doNotDisturb) {
          this.deps.notify(
            'Trio — sesli çağrı',
            `${this.deps.nameOf(incoming.from)} seni ${this.deps.channelName(incoming.channelId)} odasına çağırıyor`,
            'trio-ring',
            false,
          )
        }
        return
      }

      case 'voice.joined': {
        const resumed = event.resumed === true
        if (event.user_id === this.deps.myId) return
        // The ringer moved to another room.
        const incoming = this.snapshot.incoming
        if (incoming && incoming.from === event.user_id && incoming.channelId !== event.channel_id) {
          this.apply({ type: 'left', userId: event.user_id, channelId: incoming.channelId })
        }
        if (resumed) return // the call never stopped; nothing to announce
        if (this.deps.inCall() && this.deps.myVoiceChannel() === event.channel_id) this.player.play('join')
        const before = membersBefore(event.channel_id).filter((id) => id !== event.user_id)
        const opener = roomOpenedBy(before, [event.user_id], event.user_id, this.deps.myId)
        if (opener !== null && !this.deps.viewing()) {
          this.deps.notify(
            `${this.deps.nameOf(opener)} ses odasına girdi`,
            this.deps.channelName(event.channel_id),
            `trio-voice-${event.channel_id}`,
            this.deps.settings().doNotDisturb,
          )
        }
        return
      }

      case 'voice.left': {
        if (event.user_id === this.deps.myId) return
        this.apply({ type: 'left', userId: event.user_id, channelId: event.channel_id })
        if (this.deps.inCall() && this.deps.myVoiceChannel() === event.channel_id) this.player.play('leave')
        return
      }

      case 'error': {
        if ((event as { request?: unknown }).request !== 'voice.ring') return
        this.set({
          ringError: ringErrorMessage(event.code),
          // Only the limit means "wait"; any other refusal may be tried again.
          lastRingAt: event.code === 'RATE_LIMITED' ? this.snapshot.lastRingAt : null,
        })
        return
      }

      default:
        return
    }
  }

  // --- the ring's state and sound ---------------------------------------------

  private apply(event: RingEvent): void {
    const next = reduceRing(this.snapshot.incoming, event)
    if (next !== this.snapshot.incoming) this.set({ incoming: next })
    this.syncRingSound(event.type === 'ring' && next !== null)
    if (next && this.tick === null) {
      this.tick = setInterval(() => {
        this.apply({ type: 'tick', now: this.now() })
        this.syncRingSound()
      }, TICK_MS)
    } else if (!next && this.tick !== null) {
      clearInterval(this.tick)
      this.tick = null
    }
  }

  private syncRingSound(restart = false): void {
    const ring = this.snapshot.incoming
    const allowed = ring !== null && !this.deps.settings().doNotDisturb && !this.deps.deafened()
    const left = ring ? RING_SOUND_MS - (this.now() - ring.at) : 0
    if (!allowed || left <= 0) {
      if (this.player.ringing) this.player.stopRing()
      return
    }
    if (restart || !this.player.ringing) {
      if (restart || left >= RING_SOUND_MS - TICK_MS) this.player.startRing(left / 1000)
    }
  }
}
