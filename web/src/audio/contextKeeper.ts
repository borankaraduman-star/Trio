/**
 * Keeps an AudioContext running through interruptions (review finding 10b).
 *
 * On iOS a phone call, Siri or another app taking the audio session puts
 * every AudioContext into `interrupted` (WebKit's own state) or `suspended`,
 * and it does NOT come back by itself when the interruption ends: the
 * outgoing microphone graph then sends silence until the user leaves and
 * rejoins. iOS also refuses `resume()` outside a user gesture in some states.
 *
 * So: on every `statechange` to anything but `running`/`closed`, try
 * `resume()` at once (it works when the interruption is already over and the
 * page is allowed to), and arm one-shot listeners for the next user gesture
 * and for the page becoming visible again, which try once more. They are
 * removed as soon as the context runs again, or when the keeper is stopped.
 *
 * Framework-free and injectable, so it is unit-tested with a fake context;
 * the real iOS behaviour has NOT been verified (no iOS device here).
 */

export interface ResumableContext {
  readonly state: string
  resume(): Promise<void>
  onstatechange: ((this: never, event: Event) => unknown) | null
}

export interface KeeperTargets {
  /** Where user gestures are heard (the window in the app). */
  gestures: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>
  /** Where `visibilitychange` is heard, and whether the page is visible. */
  visibility: Pick<EventTarget, 'addEventListener' | 'removeEventListener'> & { visibilityState?: string }
}

const GESTURES = ['pointerdown', 'touchend', 'keydown', 'click'] as const

function defaultTargets(): KeeperTargets | null {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null
  return { gestures: window, visibility: document }
}

export class ContextKeeper {
  private armed = false
  private stopped = false
  private readonly onPoke = () => {
    if (this.targets.visibility.visibilityState === 'hidden') return
    this.tryResume()
  }

  /** Called after every state change the keeper sees (the engine re-reads its state). */
  onChange: (() => void) | null = null

  constructor(
    private readonly context: ResumableContext,
    private readonly targets: KeeperTargets,
  ) {
    context.onstatechange = () => this.check()
    this.check()
  }

  /** Watches `context`; null when there is no DOM to listen on. */
  static watch(context: ResumableContext, targets: KeeperTargets | null = defaultTargets()): ContextKeeper | null {
    return targets ? new ContextKeeper(context, targets) : null
  }

  /** True while the context is not running and the keeper waits for a chance to resume it. */
  get waiting(): boolean {
    return this.armed
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.disarm()
    this.context.onstatechange = null
  }

  private check(): void {
    if (this.stopped) return
    const state = this.context.state
    if (state === 'running' || state === 'closed') {
      this.disarm()
    } else {
      // 'suspended', or WebKit's 'interrupted'.
      this.arm()
      this.tryResume()
    }
    this.onChange?.()
  }

  private tryResume(): void {
    if (this.stopped || this.context.state === 'running' || this.context.state === 'closed') return
    void this.context.resume().then(
      () => this.check(),
      () => undefined, // Not allowed yet: the armed listeners try again.
    )
  }

  private arm(): void {
    if (this.armed) return
    this.armed = true
    for (const type of GESTURES) this.targets.gestures.addEventListener(type, this.onPoke, { capture: true, passive: true })
    this.targets.visibility.addEventListener('visibilitychange', this.onPoke)
  }

  private disarm(): void {
    if (!this.armed) return
    this.armed = false
    for (const type of GESTURES) this.targets.gestures.removeEventListener(type, this.onPoke, { capture: true })
    this.targets.visibility.removeEventListener('visibilitychange', this.onPoke)
  }
}
