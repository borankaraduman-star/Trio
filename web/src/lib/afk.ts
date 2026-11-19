/**
 * Auto-AFK (CONTRACT-V6-VOICE §4), the pure state machine.
 *
 * Activity is anything that says somebody is there: speech on the
 * microphone (before the mute), an input event in the page, the push-to-talk
 * or a hotkey, and in the desktop app a short system idle time (playing a
 * game in another window counts as being there). After `timeoutMs` without
 * any, the user is AFK; if they were not muted they are muted, and that mute
 * is remembered as automatic. The first activity after it ends AFK and
 * unmutes ONLY if the mute was automatic and still in place — a mute the user
 * chose (before, or by clicking during AFK) is theirs.
 */

export const AFK_TIMEOUT_MS = 10 * 60 * 1000

export interface AfkActions {
  /** Called on every change of the AFK flag (announce it). */
  setAfk(afk: boolean): void
  /** Mute or unmute as the machine decided. */
  setMuted(muted: boolean): void
}

export class AfkMachine {
  private last: number
  private afk = false
  private autoMuted = false
  private enabled = true

  constructor(
    private readonly actions: AfkActions,
    now: number,
    private timeoutMs = AFK_TIMEOUT_MS,
  ) {
    this.last = now
  }

  get isAfk(): boolean {
    return this.afk
  }

  get mutedByAfk(): boolean {
    return this.autoMuted
  }

  setTimeout(ms: number): void {
    this.timeoutMs = ms
  }

  /** Turning auto-AFK off ends an AFK in progress the same way activity would. */
  setEnabled(enabled: boolean, now: number, muted: boolean): void {
    this.enabled = enabled
    if (!enabled) this.activity(now, muted)
  }

  /** Somebody is there. `muted` is the current mute state. */
  activity(now: number, muted: boolean): void {
    this.last = now
    if (!this.afk) return
    this.afk = false
    const unmute = this.autoMuted && muted
    this.autoMuted = false
    this.actions.setAfk(false)
    if (unmute) this.actions.setMuted(false)
  }

  /** The user changed the mute themselves: from now on it is theirs. */
  manualMute(): void {
    this.autoMuted = false
  }

  /** Called periodically. */
  tick(now: number, muted: boolean): void {
    if (!this.enabled || this.afk) return
    if (now - this.last < this.timeoutMs) return
    this.afk = true
    this.autoMuted = !muted
    this.actions.setAfk(true)
    if (!muted) this.actions.setMuted(true)
  }

  /** Leaving the call: everything forgotten. */
  reset(now: number): void {
    this.afk = false
    this.autoMuted = false
    this.last = now
  }
}
