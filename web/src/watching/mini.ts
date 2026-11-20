/**
 * CONTRACT-V12-WATCHING §6: the mini players, from the Trio window's side.
 *
 * Where it opens:
 * - the desktop app (`trioDesktop.mini.supported`): a child window
 *   `/mini.html?m=<id>` named `trio-mini-<id>`; the shell makes it frameless,
 *   always on top (above borderless-fullscreen games), aspect-locked and
 *   remembered per monitor, and offers opacity and click-through;
 * - a browser with Document Picture-in-Picture (Chromium): that window (always
 *   on top, one per page), with the same UI rendered into it;
 * - any other browser, or a second mini while Document PiP is taken: the same
 *   child window as an ordinary popup (its own ⧉ button puts its picture in
 *   the browser's classic picture-in-picture, which is always on top).
 *
 * The stream never leaves this window's hands: it is attached to the mini's
 * muted `<video>` and re-attached when the engine hands over a new one (a
 * renegotiation, a fresh connection); the share's sound keeps playing here.
 */
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MiniView } from '../mini/MiniView'
import { MINI_READY_EVENT, miniUrl, miniWindowName, type MiniController, type MiniSnapshot } from '../mini/controller'
import { viewSizeFor } from '../lib/multishare'
import { MAX_VOLUME, voicePrefsStore, volumeOf } from '../lib/voicePrefs'
import { desktopBridge, type DesktopMiniBridge } from '../ptt'
import type { VoiceSnapshot } from '../voice'
import { viewSizes } from './sizes'
import { shareOrder, watchStore } from './store'

export type MiniKind = 'desktop' | 'docpip' | 'popup'

export interface MiniEnv {
  getVoice(): VoiceSnapshot
  nameOf(userId: number): string
}

interface Instance {
  id: string
  sharerId: number
  kind: MiniKind
  win: Window
  video: HTMLVideoElement | null
  attached: MediaStream | null
  listeners: Set<() => void>
  snapshot: MiniSnapshot
  clickThrough: boolean
  visible: boolean
  ended: boolean
  /** Opened by the automatic mini player (closed again when Trio comes back). */
  auto: boolean
  root: Root | null
  poll: ReturnType<typeof setInterval> | null
  controller: MiniController
}

const POPUP_FEATURES = 'popup,width=480,height=270'
/** Volume a mute goes back to, per sharer. */
const unmuteTo = new Map<number, number>()

export function desktopMini(): DesktopMiniBridge | null {
  const mini = desktopBridge()?.mini
  return mini && mini.supported === true && typeof mini.setOptions === 'function' ? mini : null
}

export function documentPipAvailable(): boolean {
  return typeof (globalThis as { documentPictureInPicture?: { requestWindow?: unknown } }).documentPictureInPicture?.requestWindow === 'function'
}

/** "Yayın sesi" mute: to 0 and back to the level it had. */
export function toggleShareMute(userId: number): void {
  const current = volumeOf(voicePrefsStore.getSnapshot(), userId).stream
  if (current > 0) {
    unmuteTo.set(userId, current)
    voicePrefsStore.setVolume(userId, 'stream', 0)
  } else {
    voicePrefsStore.setVolume(userId, 'stream', unmuteTo.get(userId) ?? 1)
  }
}

export function changeShareVolume(userId: number, delta: number): void {
  const current = volumeOf(voicePrefsStore.getSnapshot(), userId).stream
  const next = Math.min(MAX_VOLUME, Math.max(0, Math.round((current + delta) * 100) / 100))
  voicePrefsStore.setVolume(userId, 'stream', next)
}

class MiniPlayers {
  private env: MiniEnv | null = null
  private readonly open = new Map<string, Instance>()
  private desktopOff: (() => void) | null = null
  private counter = 0

  private storesOff: (() => void) | null = null

  bind(env: MiniEnv | null): void {
    this.env = env
    if (!env) {
      this.closeAll()
      this.storesOff?.()
      this.storesOff = null
      return
    }
    if (!this.storesOff) {
      const a = voicePrefsStore.subscribe(() => this.update())
      const b = watchStore.subscribe(() => this.update())
      this.storesOff = () => {
        a()
        b()
      }
    }
    const mini = desktopMini()
    if (mini && !this.desktopOff) {
      this.desktopOff = mini.onState((state) => {
        const instance = this.open.get(state.id)
        if (!instance) return
        instance.clickThrough = state.clickThrough
        instance.visible = state.visible
        if (!state.visible) viewSizes.report(instance.sharerId, `mini-${instance.id}`, null)
        this.refresh(instance)
      })
    }
  }

  isOpen(sharerId: number): boolean {
    return [...this.open.values()].some((instance) => instance.sharerId === sharerId)
  }

  openIds(): number[] {
    return [...new Set([...this.open.values()].map((instance) => instance.sharerId))]
  }

  /**
   * Open `sharerId`'s screen in a mini window. Call it from the click (a popup
   * and Document PiP need the user's gesture; the desktop shell does not).
   * Resolves to where it opened, or `blocked` (the browser refused the popup).
   */
  async show(sharerId: number, options: { auto?: boolean } = {}): Promise<MiniKind | 'blocked'> {
    for (const instance of this.open.values()) {
      if (instance.sharerId === sharerId) {
        if (instance.kind === 'desktop') desktopMini()?.show(instance.id)
        else instance.win.focus()
        return instance.kind
      }
    }
    this.counter += 1
    const id = String(sharerId)
    const desktop = desktopMini()
    const docTaken = [...this.open.values()].some((instance) => instance.kind === 'docpip')
    if (!desktop && documentPipAvailable() && !docTaken) {
      try {
        const api = (globalThis as unknown as { documentPictureInPicture: { requestWindow(o: object): Promise<Window> } })
          .documentPictureInPicture
        const win = await api.requestWindow({ width: 480, height: 270 })
        const instance = this.create(id, sharerId, 'docpip', win, options.auto === true)
        this.renderInto(instance)
        return 'docpip'
      } catch {
        // No gesture (an automatic open) or refused: a popup instead.
      }
    }
    const win = window.open(miniUrl(id), miniWindowName(id), POPUP_FEATURES)
    if (!win) return 'blocked'
    const instance = this.create(id, sharerId, desktop ? 'desktop' : 'popup', win, options.auto === true)
    this.waitForPage(instance)
    return instance.kind
  }

  close(sharerId: number): void {
    for (const instance of [...this.open.values()]) if (instance.sharerId === sharerId) this.dispose(instance, true)
  }

  closeAll(onlyAuto = false): void {
    for (const instance of [...this.open.values()]) if (!onlyAuto || instance.auto) this.dispose(instance, true)
  }

  /** The voice snapshot changed: re-attach streams, end the minis whose share ended. */
  update(): void {
    for (const instance of this.open.values()) this.refresh(instance)
  }

  /** Desktop: click-through for every mini (a hotkey). */
  toggleClickThrough(): void {
    const mini = desktopMini()
    if (!mini) return
    const anyOff = [...this.open.values()].some((instance) => !instance.clickThrough)
    for (const instance of this.open.values()) {
      instance.clickThrough = anyOff
      mini.setOptions(instance.id, { clickThrough: anyOff })
      this.refresh(instance)
    }
  }

  setOpacity(value: number): void {
    const mini = desktopMini()
    watchStore.update({ miniOpacity: value })
    for (const instance of this.open.values()) {
      if (instance.kind === 'desktop') mini?.setOptions(instance.id, { opacity: value })
      this.refresh(instance)
    }
  }

  // --- internals --------------------------------------------------------------------

  private create(id: string, sharerId: number, kind: MiniKind, win: Window, auto: boolean): Instance {
    const instance: Instance = {
      id,
      sharerId,
      kind,
      win,
      video: null,
      attached: null,
      listeners: new Set(),
      snapshot: null as unknown as MiniSnapshot,
      clickThrough: false,
      visible: true,
      ended: false,
      auto,
      root: null,
      poll: null,
      controller: null as unknown as MiniController,
    }
    instance.controller = this.controllerFor(instance)
    instance.snapshot = this.snapshotOf(instance)
    this.open.set(id, instance)
    watchStore.setMini(sharerId, true)
    // Closed by the user (its own ✕, the window's close button, the OS): forget it.
    instance.poll = setInterval(() => {
      if (instance.win.closed) this.dispose(instance, false)
    }, 500)
    if (kind === 'desktop') desktopMini()?.setOptions(id, { opacity: watchStore.getSnapshot().miniOpacity, alwaysOnTop: true })
    return instance
  }

  private waitForPage(instance: Instance): void {
    const started = Date.now()
    const timer = setInterval(() => {
      if (!this.open.has(instance.id) || instance.win.closed) {
        clearInterval(timer)
        return
      }
      let ready = false
      try {
        ready = instance.win.location.pathname === '/mini.html' && instance.win.document.readyState !== 'loading'
      } catch {
        ready = false
      }
      if (ready) {
        clearInterval(timer)
        ;(instance.win as unknown as { __trioMini: MiniController }).__trioMini = instance.controller
        instance.win.dispatchEvent(new Event(MINI_READY_EVENT))
      } else if (Date.now() - started > 15_000) {
        clearInterval(timer)
      }
    }, 50)
  }

  private renderInto(instance: Instance): void {
    const doc = instance.win.document
    for (const node of document.head.querySelectorAll('link[rel="stylesheet"], style')) doc.head.appendChild(node.cloneNode(true))
    doc.documentElement.style.height = '100%'
    doc.body.className = 'trio-mini-doc'
    doc.title = 'Trio · küçük pencere'
    const holder = doc.createElement('div')
    holder.className = 'trio-mini-root'
    doc.body.appendChild(holder)
    instance.root = createRoot(holder)
    instance.root.render(createElement(MiniView, { controller: instance.controller, win: instance.win }))
    instance.win.addEventListener('pagehide', () => this.dispose(instance, false))
  }

  private dispose(instance: Instance, closeWindow: boolean): void {
    if (this.open.get(instance.id) !== instance) return
    this.open.delete(instance.id)
    if (instance.poll) clearInterval(instance.poll)
    viewSizes.report(instance.sharerId, `mini-${instance.id}`, null)
    if (instance.video) instance.video.srcObject = null
    instance.root?.unmount()
    if (closeWindow) {
      if (instance.kind === 'desktop') desktopMini()?.close(instance.id)
      try {
        instance.win.close()
      } catch {
        // Already gone.
      }
    }
    if (!this.isOpen(instance.sharerId)) watchStore.setMini(instance.sharerId, false)
  }

  private streamOf(sharerId: number): MediaStream | null {
    return this.env?.getVoice().remoteVideo.find((media) => media.userId === sharerId)?.stream ?? null
  }

  private refresh(instance: Instance): void {
    const stream = this.streamOf(instance.sharerId)
    if (stream === null && !instance.ended) {
      // The share ended (or the sharer left): say so, then close cleanly.
      instance.ended = true
      setTimeout(() => this.dispose(instance, true), 1500)
    }
    if (stream !== null && instance.ended) instance.ended = false
    if (instance.video && stream !== instance.attached) {
      instance.attached = stream
      instance.video.srcObject = stream
      if (stream) void instance.video.play().catch(() => undefined)
    }
    instance.snapshot = this.snapshotOf(instance)
    for (const listener of instance.listeners) listener()
  }

  private snapshotOf(instance: Instance): MiniSnapshot {
    const voice = this.env?.getVoice()
    const nameOf = this.env?.nameOf ?? (() => 'Biri')
    const stream = this.streamOf(instance.sharerId)
    const volume = volumeOf(voicePrefsStore.getSnapshot(), instance.sharerId).stream
    const choice = watchStore.choice(instance.sharerId)
    const speaking = (voice?.speaking ?? []).map((id) => nameOf(id))
    return {
      sharerId: instance.sharerId,
      name: nameOf(instance.sharerId),
      hasAudio: (stream?.getAudioTracks().length ?? 0) > 0,
      volume,
      muted: volume === 0,
      speaking: speaking.length > 0 ? `Konuşuyor: ${speaking.join(', ')}` : null,
      shareCount: voice?.remoteVideo.length ?? 0,
      light: choice.light,
      audioOnly: choice.audioOnly,
      desktop: instance.kind === 'desktop',
      clickThrough: instance.clickThrough,
      opacity: watchStore.getSnapshot().miniOpacity,
      ended: instance.ended,
    }
  }

  private controllerFor(instance: Instance): MiniController {
    const self = this
    const refresh = () => self.refresh(instance)
    return {
      getSnapshot: () => instance.snapshot,
      subscribe(listener) {
        instance.listeners.add(listener)
        return () => instance.listeners.delete(listener)
      },
      attach(video) {
        instance.video = video
        instance.attached = null
        refresh()
        if (video && instance.kind === 'desktop') {
          video.addEventListener('resize', () => {
            if (video.videoWidth > 0 && video.videoHeight > 0) {
              desktopMini()?.setOptions(instance.id, { aspect: video.videoWidth / video.videoHeight })
            }
          })
        }
      },
      report(height, dpr, visible) {
        const shown = visible && instance.visible
        viewSizes.report(instance.sharerId, `mini-${instance.id}`, shown ? viewSizeFor(height, dpr, true) : null)
      },
      close: () => self.dispose(instance, true),
      toggleMute() {
        toggleShareMute(instance.sharerId)
        refresh()
      },
      setVolume(value) {
        voicePrefsStore.setVolume(instance.sharerId, 'stream', Math.min(MAX_VOLUME, Math.max(0, value)))
        refresh()
      },
      next() {
        const voice = self.env?.getVoice()
        if (!voice) return
        const order = shareOrder(
          voice.remoteVideo.map((media) => media.userId),
          watchStore.getSnapshot().pinned,
        )
        const at = order.indexOf(instance.sharerId)
        const next = order[(at + 1) % order.length]
        if (next === undefined || next === instance.sharerId) return
        viewSizes.report(instance.sharerId, `mini-${instance.id}`, null)
        const before = instance.sharerId
        instance.sharerId = next
        if (!self.isOpen(before)) watchStore.setMini(before, false)
        watchStore.setMini(next, true)
        instance.attached = null
        refresh()
        instance.win.dispatchEvent(new Event('resize'))
      },
      toggleLight() {
        watchStore.setChoice(instance.sharerId, { light: !watchStore.choice(instance.sharerId).light })
        viewSizes.refresh(instance.sharerId)
        refresh()
      },
      toggleAudioOnly() {
        watchStore.setChoice(instance.sharerId, { audioOnly: !watchStore.choice(instance.sharerId).audioOnly })
        viewSizes.refresh(instance.sharerId)
        refresh()
      },
      setOpacity(value) {
        self.setOpacity(Math.min(1, Math.max(0.4, value)))
      },
      toggleClickThrough() {
        const mini = desktopMini()
        if (!mini) return
        instance.clickThrough = !instance.clickThrough
        mini.setOptions(instance.id, { clickThrough: instance.clickThrough })
        refresh()
      },
      backToTrio() {
        try {
          window.focus()
        } catch {
          // ignore
        }
        self.dispose(instance, true)
      },
    }
  }
}

export const miniPlayers = new MiniPlayers()
