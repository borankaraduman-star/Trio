/**
 * CONTRACT-V11-ACTIVITY §3, §5–6: "ne dinliyor" as a status, in the page.
 *
 * - `listenPrefs`: "Ne dinlediğimi göster" (on by default), "Tarayıcılarda ve
 *   diğer uygulamalarda çalanları da göster" (off by default) and whether the
 *   first-run notice was answered — this device, localStorage.
 * - `ListeningSource`: turns the desktop app's status watcher on and off
 *   with the setting (`setListeningStatus`), holds its last `ListeningState`
 *   for Ayarlar, and hands the forwarder a value ONLY once the notice was
 *   answered with "Tamam". Without the V11 bridge (a browser, a 0.9.x app)
 *   it is inert: nothing is read, nothing is sent.
 */
import { oneLine, type Listening, type ListeningInput } from '../gameActivity'

export const LISTEN_KEY = 'trio.v11.listen'
export const LISTEN_BROWSERS_KEY = 'trio.v11.listenBrowsers'
export const LISTEN_ACK_KEY = 'trio.v11.listenAck'

type Listener = () => void
type KV = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

export interface ListenPrefsSnapshot {
  on: boolean
  browsers: boolean
  acked: boolean
}

export class ListenPrefs {
  private listeners = new Set<Listener>()
  private value: ListenPrefsSnapshot

  constructor(private readonly storage: KV | null) {
    const read = (key: string): string | null => {
      try {
        return storage?.getItem(key) ?? null
      } catch {
        return null
      }
    }
    this.value = { on: read(LISTEN_KEY) !== '0', browsers: read(LISTEN_BROWSERS_KEY) === '1', acked: read(LISTEN_ACK_KEY) === '1' }
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): ListenPrefsSnapshot => this.value

  private write(key: string, value: string | null): void {
    try {
      if (value === null) this.storage?.removeItem(key)
      else this.storage?.setItem(key, value)
    } catch {
      // private mode: in memory only
    }
  }

  private update(next: Partial<ListenPrefsSnapshot>): void {
    const merged = { ...this.value, ...next }
    if (merged.on === this.value.on && merged.browsers === this.value.browsers && merged.acked === this.value.acked) return
    this.value = merged
    for (const listener of this.listeners) listener()
  }

  setOn(on: boolean): void {
    this.write(LISTEN_KEY, on ? null : '0')
    this.update({ on })
  }

  setBrowsers(on: boolean): void {
    this.write(LISTEN_BROWSERS_KEY, on ? '1' : null)
    this.update({ browsers: on })
  }

  /** The first-run notice: "Tamam" (send from now on) or "Kapat" (turn the setting off). */
  answerNotice(send: boolean): void {
    this.write(LISTEN_ACK_KEY, '1')
    if (!send) this.write(LISTEN_KEY, '0')
    this.update(send ? { acked: true } : { acked: true, on: false })
  }
}

export const listenPrefs = new ListenPrefs(typeof localStorage === 'undefined' ? null : localStorage)

// --------------------------------------------------------------------- the bridge

export type ListeningHealth = 'off' | 'starting' | 'ok' | 'limited' | 'failed' | 'unsupported'

export interface DesktopListeningState {
  playing: { title: string; artist?: string; app?: string } | null
  health: ListeningHealth
  message?: string
  lastApp?: { name: string; shown: boolean }
}

export interface ListeningBridge {
  isDesktop?: unknown
  listeningStatus?: { supported?: boolean }
  setListeningStatus?: (opts: { on: boolean; browsers: boolean }) => void
  onListening?: (cb: (state: DesktopListeningState) => void) => () => void
}

/** What this page can do about listening. */
export type ListeningSupport = 'ok' | 'unsupported-os' | 'old-app' | 'browser'

export function listeningSupport(bridge = currentBridge()): ListeningSupport {
  if (!bridge || bridge.isDesktop !== true) return 'browser'
  if (typeof bridge.setListeningStatus !== 'function' || typeof bridge.onListening !== 'function') return 'old-app'
  return bridge.listeningStatus?.supported === false ? 'unsupported-os' : 'ok'
}

function currentBridge(): ListeningBridge | null {
  return (globalThis as { trioDesktop?: ListeningBridge }).trioDesktop ?? null
}

/** The desktop's state, checked (it crosses a process boundary). */
export function parseDesktopState(value: unknown): DesktopListeningState | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const healths: ListeningHealth[] = ['off', 'starting', 'ok', 'limited', 'failed', 'unsupported']
  const health = healths.includes(v.health as ListeningHealth) ? (v.health as ListeningHealth) : 'failed'
  let playing: DesktopListeningState['playing'] = null
  if (v.playing && typeof v.playing === 'object') {
    const p = v.playing as Record<string, unknown>
    const title = oneLine(p.title, 120)
    if (title) playing = { title, artist: oneLine(p.artist, 120), app: oneLine(p.app, 40) }
  }
  const out: DesktopListeningState = { playing, health }
  const message = oneLine(v.message, 300)
  if (message) out.message = message
  if (v.lastApp && typeof v.lastApp === 'object') {
    const l = v.lastApp as Record<string, unknown>
    const name = oneLine(l.name, 80)
    if (name) out.lastApp = { name, shown: l.shown === true }
  }
  return out
}

export interface SourceSnapshot {
  state: DesktopListeningState | null
  /** Something plays, the setting is on, and the notice was not answered yet. */
  needsNotice: boolean
}

export class ListeningSource implements ListeningInput {
  private listeners = new Set<Listener>()
  private state: DesktopListeningState | null = null
  private unsubscribe: (() => void) | null = null
  private unprefs: (() => void) | null = null
  private snapshot: SourceSnapshot = { state: null, needsNotice: false }
  /** What the bridge was last told, to send each change once. */
  private told: string | null = null

  constructor(
    private readonly bridge: ListeningBridge | null,
    private readonly prefs: ListenPrefs,
  ) {}

  get supported(): boolean {
    return listeningSupport(this.bridge) === 'ok'
  }

  start(): void {
    if (this.unprefs) return
    this.unprefs = this.prefs.subscribe(() => this.apply())
    this.apply()
  }

  stop(): void {
    this.unprefs?.()
    this.unprefs = null
    this.unsubscribe?.()
    this.unsubscribe = null
    if (this.told !== null && this.bridge?.setListeningStatus) this.bridge.setListeningStatus({ on: false, browsers: false })
    this.told = null
    this.state = null
    this.publish()
  }

  private apply(): void {
    const prefs = this.prefs.getSnapshot()
    if (!this.supported || !this.bridge) {
      this.publish()
      return
    }
    const wish = { on: prefs.on, browsers: prefs.on && prefs.browsers }
    const key = JSON.stringify(wish)
    if (key !== this.told) {
      this.told = key
      this.bridge.setListeningStatus?.(wish)
    }
    if (prefs.on && !this.unsubscribe) {
      this.unsubscribe =
        this.bridge.onListening?.((raw) => {
          const state = parseDesktopState(raw)
          if (!state) return
          this.state = state
          this.publish()
        }) ?? null
    } else if (!prefs.on) {
      this.unsubscribe?.()
      this.unsubscribe = null
      this.state = null
    }
    this.publish()
  }

  private publish(): void {
    const prefs = this.prefs.getSnapshot()
    const needsNotice = prefs.on && !prefs.acked && this.state?.playing != null
    if (this.snapshot.state !== this.state || this.snapshot.needsNotice !== needsNotice) {
      this.snapshot = { state: this.state, needsNotice }
    }
    for (const listener of this.listeners) listener()
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): SourceSnapshot => this.snapshot

  /** What may go to the server: only with the setting on and the notice answered. */
  value(): Listening | null {
    const prefs = this.prefs.getSnapshot()
    if (!this.supported || !prefs.on || !prefs.acked) return null
    const playing = this.state?.playing
    if (!playing) return null
    return { title: playing.title, artist: playing.artist ?? '', app: playing.app ?? '' }
  }

  /** The forwarder may decide "nothing" only once the desktop has spoken (or nothing can come). */
  resolved(): boolean {
    const prefs = this.prefs.getSnapshot()
    if (!this.supported || !prefs.on || !prefs.acked) return true
    return this.state !== null && this.state.health !== 'starting'
  }
}

export const listeningSource = new ListeningSource(currentBridge(), listenPrefs)

/** The Turkish sentence for Ayarlar about this page's listening status. */
export function healthText(support: ListeningSupport, state: DesktopListeningState | null, on: boolean): string | null {
  if (support === 'browser') return 'Yalnızca Trio masaüstü uygulamasında (Windows) çalışır; bu tarayıcı ne dinlediğini bilemez.'
  if (support === 'old-app') return 'Bu masaüstü sürümü müzik durumunu göstermiyor; uygulamayı güncelle.'
  if (support === 'unsupported-os') return 'Bu sistemde otomatik algılanamıyor.'
  if (!on) return null
  if (!state || state.health === 'starting') return 'Müzik durumu okunuyor…'
  if (state.health === 'failed' || state.health === 'limited' || state.health === 'unsupported') {
    return state.message ?? 'Müzik durumu okunamadı.'
  }
  return null
}
