/**
 * The client half of CONTRACT-V6-PUSH: the service worker, this device's push
 * subscription, the preferences, the viewing reports, and the notifications a
 * tab shows itself. One module-level store (like `settingsStore`): Session
 * attaches it (`NotifyBridge`), the settings section draws it.
 *
 * One code path for clicks: every notification, pushed or shown by a tab, goes
 * through the service worker registration (`showNotification`) with the same
 * tags and `data` the worker uses, so `notificationclick` in sw.js routes them
 * all. `new Notification` is only the fallback where no worker registered.
 */
import { showChannel } from '../viewers'
import { ApiError } from '../../api'
import type { Channel, ClientEvent, Message } from '../../types'
import { isViewing } from '../viewing'
import { mentionsUser } from './mentions'
import {
  canEnablePush,
  defaultDeviceLabel,
  notifyState,
  platformOf,
  probeEnvironment,
  uaFamily,
  type NotifyEnvironment,
  type NotifyState,
  type Platform,
} from './permission'
import { pushApi, type PrefsPatch, type PushDevice, type PushPrefs } from './pushApi'
import { browserTimeZone, inQuietHours } from './quietHours'

export const DEVICE_KEY = 'trio.push.device'

export interface NotifyContext {
  token: string
  myId: number
  channels: () => readonly Channel[]
  names: () => Record<number, string>
  activeChannelId: () => number | null
  send: (event: ClientEvent) => boolean
  /** A notification was clicked (or the page was opened with `?open=`). */
  open: (channelId: number | null, kind: string) => void
  onUnauthorized: () => void
}

export interface NotifySnapshot {
  env: NotifyEnvironment
  state: NotifyState
  platform: Platform
  prefs: PushPrefs | null
  devices: PushDevice[] | null
  /** This browser's subscription id on the server, or null (not subscribed here). */
  thisDeviceId: number | null
  busy: boolean
  error: string | null
  test: { sending: boolean; text: string; ok: boolean | null } | null
}

interface StoredDevice {
  id: number
  endpoint: string
}

function loadDevice(): StoredDevice | null {
  try {
    const raw = JSON.parse(localStorage.getItem(DEVICE_KEY) ?? 'null') as unknown
    if (raw && typeof raw === 'object') {
      const { id, endpoint } = raw as Record<string, unknown>
      if (typeof id === 'number' && typeof endpoint === 'string') return { id, endpoint }
    }
  } catch {
    // unreadable: not subscribed
  }
  return null
}

function saveDevice(device: StoredDevice | null): void {
  try {
    if (device) localStorage.setItem(DEVICE_KEY, JSON.stringify(device))
    else localStorage.removeItem(DEVICE_KEY)
  } catch {
    // storage full or blocked: the next sync finds the subscription again
  }
}

export function urlBase64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4)
  const raw = atob(padded)
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i)
  return out
}

function bytesToUrlBase64(buffer: ArrayBuffer | null): string {
  if (!buffer) return ''
  let text = ''
  for (const byte of new Uint8Array(buffer)) text += String.fromCharCode(byte)
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function sameKey(subscription: PushSubscription, key: Uint8Array): boolean {
  const current = subscription.options?.applicationServerKey
  if (!current) return true // not exposed: assume ours
  const bytes = new Uint8Array(current)
  return bytes.length === key.length && bytes.every((b, i) => b === key[i])
}

export type LocalKind = 'message' | 'voice' | 'ring'

/** Whether a tab should show a notification itself (pure: the unit tests call it). */
export function localNotifyAllowed(input: {
  kind: LocalKind
  permission: NotificationPermission | null
  pushedHere: boolean
  prefs: PushPrefs | null
  channelId: number | null
  mention: boolean
  now: number
}): boolean {
  if (input.permission !== 'granted') return false
  // The server pushes to this device for these events: showing one too would double it.
  if (input.pushedHere) return false
  const prefs = input.prefs
  if (!prefs) return true
  const level = input.channelId === null ? 'all' : (prefs.channels[String(input.channelId)] ?? 'all')
  const quiet = inQuietHours(prefs.quiet, input.now)
  if (input.kind === 'message') {
    if (level === 'none') return false
    if (input.mention) return true
    return level === 'all' && !quiet
  }
  if (input.kind === 'voice') return prefs.voice_rooms && level === 'all' && !quiet
  return prefs.calls && (!quiet || prefs.calls_break_quiet)
}

class NotifyHub {
  private ctx: NotifyContext | null = null
  private listeners = new Set<() => void>()
  private registration: Promise<ServiceWorkerRegistration | null> | null = null
  private key: string | null = null
  private lastViewing: string | null = null
  private snapshot: NotifySnapshot = this.fresh()

  private fresh(): NotifySnapshot {
    const env = probeEnvironment()
    return {
      env,
      state: notifyState(env),
      platform: platformOf(typeof navigator === 'undefined' ? '' : navigator.userAgent, typeof navigator === 'undefined' ? 0 : navigator.maxTouchPoints),
      prefs: null,
      devices: null,
      thisDeviceId: loadDevice()?.id ?? null,
      busy: false,
      error: null,
      test: null,
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): NotifySnapshot => this.snapshot

  /** The channels of the attached session (for the settings screen). */
  channels(): readonly Channel[] {
    return this.ctx?.channels() ?? []
  }

  private set(patch: Partial<NotifySnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    for (const listener of [...this.listeners]) listener()
  }

  /** Permission may have changed (a dialog answered, the site settings changed). */
  reprobe(): void {
    const env = probeEnvironment()
    this.set({ env, state: notifyState(env) })
  }

  private fail(error: unknown, fallback: string): void {
    if (error instanceof ApiError && error.status === 401) {
      this.ctx?.onUnauthorized()
      return
    }
    let text = fallback
    if (error instanceof ApiError && error.code === 'TOO_MANY_SUBSCRIPTIONS')
      text = 'En fazla 10 cihaz bildirim alabilir; önce listeden birini kaldır.'
    else if (error instanceof ApiError && error.status === 0) text = 'Sunucuya ulaşılamadı; bağlantı gelince yeniden dene.'
    else if (error instanceof DOMException && error.name === 'NotAllowedError') text = 'Tarayıcı bildirim aboneliğine izin vermedi.'
    this.set({ error: text, busy: false })
  }

  // --- lifecycle -----------------------------------------------------------

  attach(ctx: NotifyContext): () => void {
    this.ctx = ctx
    this.reprobe()
    void this.worker()
    void this.loadPrefs()
    void this.sync()
    return () => {
      if (this.ctx === ctx) this.ctx = null
    }
  }

  /** The registration of /sw.js, registered once per page; null where there can be none. */
  worker(): Promise<ServiceWorkerRegistration | null> {
    if (this.registration) return this.registration
    const env = this.snapshot.env
    if (!env.serviceWorker || !env.secure) {
      this.registration = Promise.resolve(null)
      return this.registration
    }
    this.registration = navigator.serviceWorker
      .register('/sw.js', { scope: '/', updateViaCache: 'none' })
      .then(async (registration) => {
        navigator.serviceWorker.addEventListener('message', this.onWorkerMessage)
        try {
          await navigator.serviceWorker.ready
        } catch {
          // still usable for subscribe once it activates
        }
        return registration
      })
      .catch(() => null)
    return this.registration
  }

  private onWorkerMessage = (event: MessageEvent): void => {
    const data = event.data as { type?: unknown; channel_id?: unknown; kind?: unknown } | null
    if (!data || typeof data !== 'object') return
    if (data.type === 'trio.open') {
      this.ctx?.open(typeof data.channel_id === 'number' ? data.channel_id : null, typeof data.kind === 'string' ? data.kind : '')
    } else if (data.type === 'trio.subscription-changed') {
      void this.sync()
    }
  }

  private async loadPrefs(): Promise<void> {
    const ctx = this.ctx
    if (!ctx) return
    try {
      const { prefs } = await pushApi.prefs(ctx.token)
      if (this.ctx === ctx) this.set({ prefs })
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) ctx.onUnauthorized()
      // 404: a server that predates push. Nothing to show.
    }
  }

  async loadDevices(): Promise<void> {
    const ctx = this.ctx
    if (!ctx) return
    try {
      const { subscriptions } = await pushApi.devices(ctx.token)
      const mine = loadDevice()
      if (mine && !subscriptions.some((d) => d.id === mine.id)) {
        // Removed elsewhere (another device's settings, or the push service said gone).
        saveDevice(null)
        this.set({ thisDeviceId: null })
      }
      this.set({ devices: subscriptions })
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) ctx.onUnauthorized()
    }
  }

  async publicKey(): Promise<string | null> {
    if (this.key) return this.key
    const ctx = this.ctx
    if (!ctx) return null
    try {
      this.key = (await pushApi.key(ctx.token)).public_key
    } catch {
      return null
    }
    return this.key
  }

  /**
   * On every start: if this device is meant to be subscribed, make sure the
   * server has the subscription the browser holds NOW (it may have been
   * replaced by `pushsubscriptionchange`, or this is a newly linked session).
   */
  async sync(): Promise<void> {
    const ctx = this.ctx
    const stored = loadDevice()
    if (!ctx || !stored || this.snapshot.state !== 'granted') return
    const registration = await this.worker()
    if (!registration) return
    try {
      let subscription = await registration.pushManager.getSubscription()
      if (!subscription) {
        const key = await this.publicKey()
        if (!key) return
        subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToBytes(key) })
      }
      await this.register(subscription, stored.endpoint === subscription.endpoint ? undefined : stored.id)
    } catch {
      // the next start tries again
    }
  }

  private async register(subscription: PushSubscription, replaces?: number): Promise<void> {
    const ctx = this.ctx
    if (!ctx) return
    const ua = navigator.userAgent
    const { subscription: device } = await pushApi.subscribe(ctx.token, {
      endpoint: subscription.endpoint,
      keys: {
        p256dh: bytesToUrlBase64(subscription.getKey('p256dh')),
        auth: bytesToUrlBase64(subscription.getKey('auth')),
      },
      ua_family: uaFamily(ua),
      label: defaultDeviceLabel(ua, navigator.maxTouchPoints),
    })
    if (replaces !== undefined && replaces !== device.id) {
      await pushApi.remove(ctx.token, replaces).catch(() => undefined)
    }
    saveDevice({ id: device.id, endpoint: subscription.endpoint })
    this.set({ thisDeviceId: device.id })
  }

  // --- actions (from a click: the permission prompt needs the gesture) ---------

  /** Ask for permission. Call straight from a click handler, before any await. */
  askPermission(): Promise<NotificationPermission | null> {
    if (typeof Notification === 'undefined') return Promise.resolve(null)
    let answer: Promise<NotificationPermission>
    try {
      answer = new Promise<NotificationPermission>((resolve) => {
        const result = Notification.requestPermission(resolve)
        if (result && typeof result.then === 'function') void result.then(resolve, () => resolve(Notification.permission))
      })
    } catch {
      return Promise.resolve(null)
    }
    return answer.then((permission) => {
      this.reprobe()
      return permission
    })
  }

  /** "Bu cihazda bildir" on: ask if need be, subscribe, tell the server. */
  async enableHere(): Promise<void> {
    if (!canEnablePush(this.snapshot.state, this.snapshot.env)) {
      // No push here: still ask, so a tab can show notifications while open.
      if (this.snapshot.state === 'default') await this.askPermission()
      return
    }
    this.set({ busy: true, error: null })
    // Before any await: iOS wants the prompt in the gesture's own task.
    const asked = this.snapshot.state === 'default' ? this.askPermission() : Promise.resolve(Notification.permission)
    try {
      const permission = await asked
      if (permission !== 'granted') {
        this.set({ busy: false })
        return
      }
      const [registration, key] = await Promise.all([this.worker(), this.publicKey()])
      if (!registration || !key) throw new ApiError(0, 'NETWORK', 'no key')
      const bytes = urlBase64ToBytes(key)
      let subscription = await registration.pushManager.getSubscription()
      if (subscription && !sameKey(subscription, bytes)) {
        await subscription.unsubscribe()
        subscription = null
      }
      subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes })
      await this.register(subscription)
      this.set({ busy: false })
      await this.loadDevices()
      if (this.ctx) this.reportViewing(true)
    } catch (error) {
      this.fail(error, 'Bu cihaz bildirime abone edilemedi.')
    }
  }

  async disableHere(): Promise<void> {
    const ctx = this.ctx
    const stored = loadDevice()
    this.set({ busy: true, error: null })
    try {
      const registration = await this.worker()
      const subscription = await registration?.pushManager.getSubscription()
      await subscription?.unsubscribe()
      if (ctx && stored) await pushApi.remove(ctx.token, stored.id).catch((error: unknown) => {
        if (!(error instanceof ApiError && error.status === 404)) throw error
      })
      saveDevice(null)
      this.set({ thisDeviceId: null, busy: false })
      await this.loadDevices()
    } catch (error) {
      this.fail(error, 'Bu cihazın aboneliği kaldırılamadı.')
    }
  }

  async removeDevice(id: number): Promise<void> {
    if (id === this.snapshot.thisDeviceId) return this.disableHere()
    const ctx = this.ctx
    if (!ctx) return
    try {
      await pushApi.remove(ctx.token, id)
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) return this.fail(error, 'Cihaz kaldırılamadı.')
    }
    await this.loadDevices()
  }

  async savePrefs(patch: PrefsPatch): Promise<void> {
    const ctx = this.ctx
    if (!ctx) return
    const quiet = patch.quiet ? { ...patch.quiet, tz: patch.quiet.tz ?? this.snapshot.prefs?.quiet.tz ?? browserTimeZone() } : undefined
    try {
      const { prefs } = await pushApi.savePrefs(ctx.token, { ...patch, ...(quiet ? { quiet } : {}) })
      this.set({ prefs, error: null })
    } catch (error) {
      this.fail(error, 'Ayar kaydedilemedi.')
    }
  }

  async sendTest(): Promise<void> {
    const ctx = this.ctx
    const id = this.snapshot.thisDeviceId
    if (!ctx || id === null) return
    this.set({ test: { sending: true, text: 'Gönderiliyor…', ok: null } })
    try {
      const result = await pushApi.test(ctx.token, id)
      const text = result.ok
        ? `Bildirim servisi kabul etti (HTTP ${result.status}). Birkaç saniye içinde bildirim gelmeli.`
        : result.removed
          ? `Bildirim servisi bu aboneliği tanımıyor (HTTP ${result.status ?? '—'}); abonelik silindi. Bildirimleri bu cihazda yeniden aç.`
          : `Bildirim servisi kabul etmedi: ${result.error ?? 'bilinmeyen hata'}.`
      if (result.removed) {
        saveDevice(null)
        this.set({ thisDeviceId: null })
      }
      this.set({ test: { sending: false, text, ok: result.ok } })
      await this.loadDevices()
    } catch (error) {
      const text =
        error instanceof ApiError && error.status === 429
          ? 'Çok sık denendi; bir dakika sonra yeniden dene.'
          : 'Deneme bildirimi gönderilemedi.'
      this.set({ test: { sending: false, text, ok: false } })
    }
  }

  // --- the socket ------------------------------------------------------------

  /** `client.viewing`: on every `ready`, and whenever looking-or-not or the channel changes. */
  reportViewing(force = false): void {
    const ctx = this.ctx
    if (!ctx) return
    const viewing = isViewing()
    const channelId = ctx.activeChannelId()
    // V10 (§4b): "Hangi kanalda olduğumu göster" off: the channel is still sent
    // for the push decisions, marked as not to be shown to anybody.
    const show = showChannel.getSnapshot()
    const key = `${viewing}:${channelId}:${show}`
    if (!force && key === this.lastViewing) return
    const frame = { type: 'client.viewing', viewing, channel_id: channelId, ...(show ? {} : { show_channel: false }) }
    if (ctx.send(frame as unknown as ClientEvent)) this.lastViewing = key
    if (viewing) void this.viewed()
  }

  /** A `ready` (a new connection): its state is unknown to the server until reported. */
  connected(): void {
    this.lastViewing = null
    this.reportViewing(true)
  }

  /** The app is being looked at: the message notifications and the badge go. */
  async viewed(): Promise<void> {
    const nav = navigator as Navigator & { clearAppBadge?: () => Promise<void> }
    void nav.clearAppBadge?.().catch(() => undefined)
    const registration = await this.worker()
    registration?.active?.postMessage({ type: 'trio.viewed' })
  }

  // --- notifications a tab shows itself (no push on this device) ---------------

  private pushedHere(): boolean {
    return this.snapshot.thisDeviceId !== null && this.snapshot.state === 'granted'
  }

  async local(kind: LocalKind, channelId: number | null, title: string, body: string, options: { silent?: boolean; mention?: boolean } = {}): Promise<void> {
    const permission = typeof Notification === 'undefined' ? null : Notification.permission
    const allowed = localNotifyAllowed({
      kind,
      permission,
      pushedHere: this.pushedHere(),
      prefs: this.snapshot.prefs,
      channelId,
      mention: options.mention === true,
      now: Date.now(),
    })
    if (!allowed) return
    const tag = kind === 'message' ? `ch-${channelId}` : kind === 'voice' ? `voice-${channelId}` : `ring-${channelId ?? 0}`
    const data = { kind: options.mention ? 'mention' : kind, channel_id: channelId, count: 1 }
    const registration = await this.worker()
    try {
      if (registration) {
        await registration.showNotification(title, { body, tag, silent: options.silent === true, data, icon: '/icon-192.png' })
        return
      }
    } catch {
      // fall back below
    }
    try {
      const notification = new Notification(title, { body, tag, silent: options.silent === true })
      notification.onclick = () => {
        window.focus()
        this.ctx?.open(channelId, kind)
      }
    } catch {
      // some browsers only allow notifications from a worker
    }
  }

  /** A `message.new` while this tab is not being looked at. */
  localMessage(message: Message, channelName: string): void {
    const ctx = this.ctx
    if (!ctx || message.author.id === ctx.myId || isViewing()) return
    const mention = mentionsUser(message.content, ctx.names(), ctx.myId)
    const body = message.content
      ? message.content.replace(/\s+/g, ' ').trim().slice(0, 120)
      : (message.attachments ?? []).every((a) => a.content_type.startsWith('audio/')) && (message.attachments ?? []).length > 0
        ? '🎤 sesli mesaj'
        : (message.attachments ?? []).every((a) => a.content_type.startsWith('image/')) && (message.attachments ?? []).length > 0
          ? '📎 fotoğraf'
          : '📎 dosya'
    void this.local('message', message.channel_id, `${message.author.name} — #${channelName}`, body, { mention })
  }
}

export const notifyHub = new NotifyHub()

// V10 (§4b): turning "Hangi kanalda olduğumu göster" on or off reports at once.
showChannel.subscribe(() => notifyHub.reportViewing())
