/**
 * "Oyun durumu" in the client (CONTRACT-V5): who is playing what.
 *
 * Kept OUT of store.ts on purpose (other work edits it): a small external
 * store fed with the same server events, read with useSyncExternalStore.
 *
 * - `activityStore` holds everybody's activity from `ready.activity` and
 *   `activity` frames.
 * - `GameForwarder` takes the desktop app's statuses
 *   (`window.trioDesktop.onGameStatus`) and sends them to the server
 *   (`activity.set` / `activity.clear`), again after a reconnect and every few
 *   minutes (the server forgets an entry after 10 minutes without one).
 * - `gameShare` is the "Oyun durumumu paylaş" switch (this device,
 *   localStorage `trio.gameShare`; on by default). Off sends one
 *   `activity.clear` and nothing else.
 */

export interface GameDetail {
  character: string
  realm: string
  level: number
  class: string
  zone: string
  subzone: string
  source: 'log' | 'saved'
}

/** CONTRACT-V11-ACTIVITY: what somebody is listening to. */
export interface Listening {
  title: string
  /** "" when unknown. */
  artist: string
  /** "" when unknown; a short friendly name ("Spotify"). */
  app: string
}

export interface Activity {
  /** Null when only listening (V11). */
  game: string | null
  /** Unix seconds: when the game was first seen running; null without a game. */
  since: number | null
  detail: GameDetail | null
  listening: Listening | null
}

/** An activity with a game (V5's shape). */
export type GameActivity = Activity & { game: string; since: number }

export function hasGame(activity: Activity): activity is GameActivity {
  return activity.game !== null && activity.since !== null
}

export interface ActivityEntry {
  activity: Activity
  /** ISO time the server last heard of it. */
  updatedAt: string
}

/** What the desktop bridge hands over (CONTRACT-V5 §5). */
export interface DesktopGameStatus {
  game: string
  since: number
  detail?: Partial<GameDetail> | null
}

export interface GameStatusBridge {
  gameStatus?: { supported?: boolean }
  onGameStatus?: (cb: (status: DesktopGameStatus | null) => void) => () => void
}

type Listener = () => void

// --------------------------------------------------------------------- the activity store

function str(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

export function parseListening(value: unknown): Listening | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const title = oneLine(v.title, 120)
  if (!title) return null
  return { title, artist: oneLine(v.artist, 120), app: oneLine(v.app, 40) }
}

/** A string as one line of text: controls and bidi characters out, whitespace collapsed, capped. */
export function oneLine(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ')
  return Array.from(text.replace(/\s+/g, ' ').trim()).slice(0, max).join('').trim()
}

/** A server activity, checked field by field; null when unusable. */
export function parseActivity(value: unknown): Activity | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const listening = parseListening(v.listening)
  const game = str(v.game, 64)
  const timed = typeof v.since === 'number' && Number.isFinite(v.since)
  if (!game || !timed) {
    return listening ? { game: null, since: null, detail: null, listening } : null
  }
  let detail: GameDetail | null = null
  if (v.detail && typeof v.detail === 'object') {
    const d = v.detail as Record<string, unknown>
    const level = typeof d.level === 'number' && Number.isInteger(d.level) ? d.level : 0
    const character = str(d.character, 48)
    if (character && level > 0) {
      detail = {
        character,
        realm: str(d.realm, 64),
        level,
        class: /^[A-Z_]{0,24}$/.test(str(d.class, 24)) ? str(d.class, 24) : '',
        zone: str(d.zone, 96),
        subzone: str(d.subzone, 96),
        source: d.source === 'saved' ? 'saved' : 'log',
      }
    }
  }
  return { game, since: v.since as number, detail, listening }
}

export class ActivityStore {
  private entries: Record<number, ActivityEntry> = {}
  private listeners = new Set<Listener>()

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): Record<number, ActivityEntry> => this.entries

  get(userId: number): ActivityEntry | undefined {
    return this.entries[userId]
  }

  private set(next: Record<number, ActivityEntry>): void {
    this.entries = next
    for (const listener of this.listeners) listener()
  }

  /** Feed every server event; only the ones about activity change anything. */
  handleEvent(event: { type: string } & Record<string, unknown>): void {
    if (event.type === 'ready') {
      const next: Record<number, ActivityEntry> = {}
      const map = event.activity
      if (map && typeof map === 'object') {
        for (const [key, value] of Object.entries(map as Record<string, unknown>)) {
          const id = Number(key)
          const entry = value as { activity?: unknown; updated_at?: unknown } | null
          const activity = parseActivity(entry?.activity)
          if (Number.isInteger(id) && activity) {
            next[id] = { activity, updatedAt: typeof entry?.updated_at === 'string' ? entry.updated_at : '' }
          }
        }
      }
      this.set(next)
    } else if (event.type === 'activity') {
      const id = event.user_id
      if (typeof id !== 'number') return
      const activity = parseActivity(event.activity)
      const next = { ...this.entries }
      if (activity) {
        next[id] = { activity, updatedAt: typeof event.updated_at === 'string' ? event.updated_at : '' }
      } else {
        if (!(id in next)) return
        delete next[id]
      }
      this.set(next)
    } else if (event.type === 'user.removed') {
      const id = event.user_id
      if (typeof id !== 'number' || !(id in this.entries)) return
      const next = { ...this.entries }
      delete next[id]
      this.set(next)
    }
  }

  reset(): void {
    this.set({})
  }
}

export const activityStore = new ActivityStore()

// --------------------------------------------------------------------- the share switch

const SHARE_KEY = 'trio.gameShare'

export class ShareSetting {
  private listeners = new Set<Listener>()
  private value: boolean

  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null) {
    let stored: string | null = null
    try {
      stored = storage?.getItem(SHARE_KEY) ?? null
    } catch {
      stored = null
    }
    this.value = stored !== '0'
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): boolean => this.value

  set(on: boolean): void {
    if (on === this.value) return
    this.value = on
    try {
      this.storage?.setItem(SHARE_KEY, on ? '1' : '0')
    } catch {
      // private mode: in memory only
    }
    for (const listener of this.listeners) listener()
  }
}

export const gameShare = new ShareSetting(typeof localStorage === 'undefined' ? null : localStorage)

// --------------------------------------------------------------------- the forwarder

/** The bridge, when the desktop app offers game status (an old app does not). */
export function gameStatusBridge(): GameStatusBridge | null {
  const bridge = (globalThis as { trioDesktop?: GameStatusBridge }).trioDesktop
  if (!bridge || typeof bridge.onGameStatus !== 'function') return null
  return bridge
}

interface GamePart {
  game: string
  since: number
  detail?: GameDetail
}

export type ActivityFrame =
  | { type: 'activity.set'; game?: string; since?: number; detail?: GameDetail; listening?: Listening }
  | { type: 'activity.clear' }

/** The desktop's status as an `activity.set` frame, or null when unusable. */
export function toFrame(status: DesktopGameStatus | null): ActivityFrame | null {
  const part = toGamePart(status)
  return part ? { type: 'activity.set', ...part } : null
}

function toGamePart(status: DesktopGameStatus | null): GamePart | null {
  if (!status) return null
  const parsed = parseActivity({ ...status, listening: null, since: Math.floor(Number(status.since)) })
  if (!parsed || !hasGame(parsed)) return null
  const part: GamePart = { game: parsed.game, since: parsed.since }
  if (parsed.detail) part.detail = parsed.detail
  return part
}

/**
 * CONTRACT-V11-ACTIVITY: the listening half the forwarder merges in
 * (`activity/listening.ts`'s ListeningSource). `resolved` is false while the
 * desktop app has not said yet what plays (the forwarder then waits after a
 * `ready` instead of clearing what the server holds).
 */
export interface ListeningInput {
  subscribe(listener: () => void): () => void
  value(): Listening | null
  resolved(): boolean
}

export interface ForwarderTimers {
  now: () => number
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

const realTimers: ForwarderTimers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** Re-send an unchanged status this often (the server's TTL is 10 minutes). */
export const REFRESH_MS = 4 * 60_000
/** At most one frame per this interval (the server allows 30 a minute). */
export const MIN_GAP_MS = 3_000
/** V11: a new song at most this often (the server refuses one within 4 s). Stopping goes at once. */
export const LISTEN_GAP_MS = 5_000

/**
 * Sends this user's activity: the game part from the desktop app
 * (`onGameStatus`, while "Oyun durumumu paylaş" is on) and the listening part
 * (V11, `ListeningInput`), merged into one frame.
 */
export class ActivityForwarder {
  private game: GamePart | null = null
  /** What the server has from us: the last frame sent, or null when cleared/nothing. */
  private sentKey: string | null = null
  private sentAt = -Infinity
  private sentListening: string | null = null
  private listeningSentAt = -Infinity
  private timer: unknown = null
  private unbridge: (() => void) | null = null
  private unshare: (() => void) | null = null
  private unlisten: (() => void) | null = null
  private started = false
  /** The desktop app has told us something since sharing was (re)enabled. */
  private heard = false
  /** The server knows the listening part (`ready.activity_parts`). */
  private serverListening = false

  constructor(
    private readonly send: (frame: ActivityFrame) => boolean,
    private readonly bridge: GameStatusBridge | null,
    private readonly share: ShareSetting,
    private readonly myId: () => number | null,
    private readonly timers: ForwarderTimers = realTimers,
    private readonly store: Pick<ActivityStore, 'get'> = activityStore,
    private readonly listening: ListeningInput | null = null,
  ) {}

  start(): void {
    if (this.started) return
    this.started = true
    this.unshare = this.share.subscribe(() => this.applyShare(true))
    this.unlisten = this.listening?.subscribe(() => this.flush()) ?? null
    this.applyShare(false)
  }

  stop(): void {
    this.started = false
    this.unshare?.()
    this.unshare = null
    this.unlisten?.()
    this.unlisten = null
    this.unbridge?.()
    this.unbridge = null
    if (this.timer !== null) this.timers.clearTimeout(this.timer)
    this.timer = null
  }

  private applyShare(changed: boolean): void {
    if (this.share.getSnapshot()) {
      if (!this.unbridge && this.bridge?.onGameStatus) {
        this.unbridge = this.bridge.onGameStatus((status) => this.onStatus(status))
      }
    } else {
      this.unbridge?.()
      this.unbridge = null
      this.game = null
      this.heard = false
      if (changed) {
        // Switched off here and now: what the server holds for us changes.
        this.sentKey = 'unknown'
        this.flush()
      }
    }
  }

  private onStatus(status: DesktopGameStatus | null): void {
    if (!this.share.getSnapshot()) return
    this.heard = true
    this.game = toGamePart(status)
    this.flush()
  }

  /** Every part has spoken (or is off), so "nothing" really means nothing. */
  private resolved(): boolean {
    const gameKnown = !this.bridge || !this.share.getSnapshot() || this.heard
    const listenKnown = !this.listening || this.listening.resolved()
    return gameKnown && listenKnown
  }

  /**
   * After every `ready` (a connect or a reconnect): the server may have lost
   * our entry (a restart) or still hold one from before the switch went off.
   */
  onReady(parts?: unknown): void {
    this.serverListening = Array.isArray(parts) && parts.includes('listening')
    // Only the desktop app speaks for this user; a plain browser tab never
    // sends anything on its own (it would fight the desktop app).
    if (!this.bridge && !this.listening) return
    const me = this.myId()
    const held = me !== null && this.store.get(me) !== undefined
    this.sentAt = -Infinity
    this.listeningSentAt = -Infinity
    this.sentKey = held ? 'unknown' : null
    this.sentListening = held ? 'unknown' : null
    // Not everything has spoken yet: its first word is on its way and is sent then.
    if (this.resolved()) this.flush()
  }

  private wanted(): Extract<ActivityFrame, { type: 'activity.set' }> | null {
    const listening = this.serverListening ? (this.listening?.value() ?? null) : null
    if (!this.game && !listening) return null
    return { type: 'activity.set', ...(this.game ?? {}), ...(listening ? { listening } : {}) }
  }

  private schedule(ms: number): void {
    if (this.timer !== null) this.timers.clearTimeout(this.timer)
    this.timer = this.timers.setTimeout(() => {
      this.timer = null
      this.flush()
    }, ms)
  }

  /** Send what the server should have, within the rate; keep it fresh. */
  flush(): void {
    if (!this.started) return
    const now = this.timers.now()
    const frame = this.wanted()
    const want = frame ? JSON.stringify(frame) : null
    const stale = want !== null && now - this.sentAt >= REFRESH_MS
    if (want === this.sentKey && !stale) {
      if (want !== null) this.schedule(this.sentAt + REFRESH_MS - now)
      return
    }
    if (want === null && this.sentKey === null) return
    // Nothing known yet from a part that may still speak: do not clear on its behalf.
    if (want === null && !this.resolved()) return
    const listening = frame && 'listening' in frame && frame.listening ? JSON.stringify(frame.listening) : null
    let wait = this.sentAt + MIN_GAP_MS - now
    // A new song waits for the listening gap; stopping does not.
    if (listening !== null && listening !== this.sentListening) {
      wait = Math.max(wait, this.listeningSentAt + LISTEN_GAP_MS - now)
    }
    if (wait > 0) {
      this.schedule(wait)
      return
    }
    if (!this.send(frame ?? { type: 'activity.clear' })) return // not connected: onReady sends it
    this.sentKey = want
    this.sentAt = now
    if (listening !== this.sentListening) {
      this.sentListening = listening
      if (listening !== null) this.listeningSentAt = now
    }
    if (want !== null) this.schedule(REFRESH_MS)
  }
}

/** V5's name. */
export const GameForwarder = ActivityForwarder
export type GameForwarder = ActivityForwarder

// --------------------------------------------------------------------- display

/** WoW class tokens: Turkish name and the game's class colour. */
export const CLASSES: Record<string, { name: string; color: string }> = {
  WARRIOR: { name: 'Savaşçı', color: '#C69B6D' },
  PALADIN: { name: 'Paladin', color: '#F48CBA' },
  HUNTER: { name: 'Avcı', color: '#AAD372' },
  ROGUE: { name: 'Haydut', color: '#FFF468' },
  PRIEST: { name: 'Rahip', color: '#FFFFFF' },
  DEATHKNIGHT: { name: 'Ölüm Şövalyesi', color: '#C41E3A' },
  SHAMAN: { name: 'Şaman', color: '#0070DD' },
  MAGE: { name: 'Büyücü', color: '#3FC7EB' },
  WARLOCK: { name: 'Büyücü (Warlock)', color: '#8788EE' },
  MONK: { name: 'Keşiş', color: '#00FF98' },
  DRUID: { name: 'Druid', color: '#FF7C0A' },
  DEMONHUNTER: { name: 'İblis Avcısı', color: '#A330C9' },
  EVOKER: { name: 'Evoker', color: '#33937F' },
}

/** "WoW Forever · 37 · Orgrimmar", or just the game; "" without a game. */
export function activityLine(activity: Activity): string {
  if (activity.game === null) return ''
  const parts = [activity.game]
  const d = activity.detail
  if (d) {
    parts.push(String(d.level))
    const place = d.zone || d.subzone
    if (place) parts.push(place)
  }
  return parts.join(' · ')
}

/** "Sanatçı — Şarkı" (the V8 title's shape), or the title alone when it already names the artist. */
export function songText(listening: Listening): string {
  const { title, artist } = listening
  return artist && !title.includes(artist) ? `${artist} — ${title}` : title
}

/** "Spotify · Sanatçı — Şarkı" (the app first when known). */
export function listeningLine(listening: Listening): string {
  const song = songText(listening)
  return listening.app ? `${listening.app} · ${song}` : song
}

/** The one short thing for a tight row: the game's name, else the song. */
export function shortActivity(activity: Activity): string {
  return activity.game ?? (activity.listening ? songText(activity.listening) : '')
}

/** One line for a list of people's tooltips: "Ece — WoW Forever · 37 · Orgrimmar · ♪ Spotify · Şarkı". */
export function activitySummary(activity: Activity): string {
  const parts: string[] = []
  const game = activityLine(activity)
  if (game) parts.push(game)
  if (activity.listening) parts.push(`dinliyor: ${listeningLine(activity.listening)}`)
  return parts.join(' · ')
}

/** "1 sa 20 dk", "5 dk", "az önce". */
export function elapsedText(since: number, nowMs: number): string {
  const minutes = Math.max(0, Math.floor((nowMs / 1000 - since) / 60))
  if (minutes < 1) return 'az önce'
  if (minutes < 60) return `${minutes} dk`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours} sa ${rest} dk` : `${hours} sa`
}

function agoText(iso: string, nowMs: number): string | null {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return null
  const minutes = Math.max(0, Math.round((nowMs - at) / 60_000))
  return minutes < 1 ? 'az önce' : `${minutes} dk önce`
}

/** The tooltip: character, realm, class, zone with subzone, how long, how fresh. */
export function activityTooltip(entry: ActivityEntry, nowMs: number): string {
  const { activity } = entry
  const lines: string[] = []
  const d = activity.detail
  if (d) {
    const who = d.realm ? `${d.character} (${d.realm})` : d.character
    const klass = CLASSES[d.class]?.name ?? d.class
    lines.push([who, `${d.level}. seviye`, klass].filter(Boolean).join(' · '))
    const place = [d.zone, d.subzone].filter(Boolean).join(' › ')
    if (place) lines.push(place)
    if (d.source === 'saved') lines.push('Oyundan çıkarken kaydedilen bilgi')
  }
  if (activity.game !== null && activity.since !== null) {
    lines.push(`${activity.game} · ${elapsedText(activity.since, nowMs)} oynuyor`)
  }
  const ago = agoText(entry.updatedAt, nowMs)
  if (ago) lines.push(`Güncellendi: ${ago}`)
  return lines.join('\n')
}

/** The music line's tooltip. */
export function listeningTooltip(listening: Listening): string {
  const lines = [listening.title]
  if (listening.artist) lines.push(listening.artist)
  lines.push(listening.app ? `${listening.app} ile dinliyor` : 'Dinliyor')
  return lines.join('\n')
}
