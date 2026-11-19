/**
 * CONTRACT-V8-MUSIC §3: capturing "the sound playing on my computer".
 *
 * Two paths, chosen by where the page runs:
 *
 * - **The desktop app** (`trioDesktop.isDesktop`): the app arms its next
 *   getDisplayMedia as a music share (`prepareMusicCapture`), which Electron
 *   answers with a Windows process loopback that leaves Trio's own process
 *   out — Windows 11 only. Nothing slow happens between the click and
 *   getDisplayMedia except that one IPC round trip, so the click's transient
 *   activation (a few seconds in Chromium) is still there. An app without
 *   `prepareMusicCapture` is older: its picker's "system sound" would send
 *   the room back into the room, so nothing is captured at all.
 * - **A browser** (Chrome, Edge): the picker, asking for a TAB with its
 *   sound. Trio's own tab is not offered (`selfBrowserSurface: "exclude"`,
 *   and no switching to it mid-share). Screens and windows are offered only
 *   where the browser lists `restrictOwnAudio`, and a capture is kept only
 *   if what came back is a tab (another tab's sound has none of Trio's) or
 *   reports `restrictOwnAudio: true` (verified after the fact, since a
 *   listed constraint is not a working one: Linux Chromium lists it and
 *   answers false).
 *
 * Option names checked on 19 Nov 2026 against Chrome's documentation and
 * blink-dev intents (web search): `selfBrowserSurface` (107),
 * `systemAudio` (105), `surfaceSwitching` (107), `monitorTypeSurfaces`
 * (119), `preferCurrentTab` (94), `windowAudio` (141),
 * `suppressLocalAudioPlayback` (109, an audio constraint) and
 * `restrictOwnAudio` (141, an audio constraint, Windows and macOS). In this
 * Chromium (153) `getSupportedConstraints()` lists `restrictOwnAudio` and
 * `suppressLocalAudioPlayback`; a tab capture reports `restrictOwnAudio: false`.
 *
 * The picture track Chromium insists on (there is no audio-only display
 * capture) is stopped at once; its sound keeps flowing (measured) and only
 * an audio-only stream leaves this module.
 */

/** The desktop bridge's music members (CONTRACT-V8-MUSIC §5), all optional. */
export type MusicRefusal = 'windows-version' | 'unsupported-platform' | 'busy' | 'not-allowed'
export type MusicSupport = { systemAudio: true } | { systemAudio: false; reason: MusicRefusal; message: string }
export type PrepareResult = { ok: true } | { ok: false; reason: MusicRefusal; message: string }
export interface NowPlaying {
  title: string
  artist?: string
  app?: string
}

export interface DesktopMusicBridge {
  isDesktop?: unknown
  musicCaptureSupport?: () => Promise<MusicSupport | null>
  prepareMusicCapture?: () => Promise<PrepareResult | null>
  setNowPlayingWatch?: (on: boolean) => void
  onNowPlaying?: (cb: (info: NowPlaying | null) => void) => () => void
}

/** The page's desktop bridge if it runs in the desktop app, else null. */
export function desktopMusicBridge(): DesktopMusicBridge | null {
  const bridge = (globalThis as { trioDesktop?: DesktopMusicBridge }).trioDesktop
  return bridge && bridge.isDesktop === true ? bridge : null
}

export const OLD_APP_MESSAGE =
  "Müzik paylaşmak için masaüstü uygulamasını güncelle ya da Trio'yu Chrome'da açıp sekmeyi paylaş."
export const NO_SEPARATION_MESSAGE = 'Bu bilgisayarda Trio kendi sesini paylaşılan sesten ayıramıyor.'
export const NO_AUDIO_MESSAGE =
  'Ses gelmedi: paylaşırken seçicide bir sekme seç ve “Sekme sesini de paylaş” seçeneğini işaretle.'
export const OWN_AUDIO_MESSAGE =
  'Trio kendi sesini bu paylaşımdan ayıramıyor (odanın sesi geri giderdi). Müziğin çaldığı sekmeyi seç ve “Sekme sesini de paylaş”ı işaretle.'
export const NOT_SUPPORTED_MESSAGE = 'Bu tarayıcı müzik paylaşamıyor. Chrome ya da Edge ile dene.'
export const PREPARE_FAILED_MESSAGE = 'Müzik paylaşımı başlatılamadı.'

/** Raw sound, never treated as a voice (CONTRACT-V8-MUSIC §3). */
const AUDIO: MediaTrackConstraints = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 2,
}

/** What the browser picker is asked for. */
export function browserMusicOptions(supported: { restrictOwnAudio?: boolean; suppressLocalAudioPlayback?: boolean }): DisplayMediaStreamOptions {
  const canRestrict = supported.restrictOwnAudio === true
  return {
    video: true,
    audio: {
      ...AUDIO,
      ...(canRestrict ? { restrictOwnAudio: true } : {}),
      // The sharer keeps hearing the tab they share.
      ...(supported.suppressLocalAudioPlayback ? { suppressLocalAudioPlayback: false } : {}),
    } as MediaTrackConstraints,
    selfBrowserSurface: 'exclude',
    preferCurrentTab: false,
    surfaceSwitching: 'exclude',
    systemAudio: canRestrict ? 'include' : 'exclude',
    windowAudio: canRestrict ? 'window' : 'exclude',
    monitorTypeSurfaces: canRestrict ? 'include' : 'exclude',
  } as DisplayMediaStreamOptions
}

/** What the desktop app's armed request must carry (CONTRACT-V8-MUSIC §3, step 3). */
export const DESKTOP_MUSIC_OPTIONS = {
  video: true,
  audio: { ...AUDIO, restrictOwnAudio: true },
  systemAudio: 'include',
} as DisplayMediaStreamOptions

export type CaptureResult =
  | { ok: true; stream: MediaStream; title: null; source: 'desktop' | 'browser' }
  /** `message` null: the user closed the picker — say nothing. */
  | { ok: false; message: string | null }

export interface CaptureEnv {
  getDisplayMedia?: (options: DisplayMediaStreamOptions) => Promise<MediaStream>
  supported: { restrictOwnAudio?: boolean; suppressLocalAudioPlayback?: boolean }
  bridge: DesktopMusicBridge | null
}

export function defaultCaptureEnv(): CaptureEnv {
  const media = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices
  return {
    getDisplayMedia: typeof media?.getDisplayMedia === 'function' ? (options) => media.getDisplayMedia(options) : undefined,
    supported: (media?.getSupportedConstraints?.() ?? {}) as CaptureEnv['supported'],
    bridge: desktopMusicBridge(),
  }
}

function stopAll(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop()
}

/**
 * Capture music. Call it FIRST in the click handler, with nothing awaited
 * before it: the browser's picker (and the app's armed request) needs the
 * click's activation.
 */
export async function captureMusic(env: CaptureEnv = defaultCaptureEnv()): Promise<CaptureResult> {
  if (!env.getDisplayMedia) return { ok: false, message: NOT_SUPPORTED_MESSAGE }
  const desktop = env.bridge
  let options: DisplayMediaStreamOptions
  if (desktop) {
    if (typeof desktop.prepareMusicCapture !== 'function') return { ok: false, message: OLD_APP_MESSAGE }
    let prepared: PrepareResult | null
    try {
      prepared = await desktop.prepareMusicCapture()
    } catch {
      prepared = null
    }
    if (!prepared) return { ok: false, message: PREPARE_FAILED_MESSAGE }
    if (!prepared.ok) return { ok: false, message: prepared.message || PREPARE_FAILED_MESSAGE }
    options = DESKTOP_MUSIC_OPTIONS
  } else {
    options = browserMusicOptions(env.supported)
  }

  let stream: MediaStream
  try {
    stream = await env.getDisplayMedia(options)
  } catch (error) {
    const name = error instanceof Error ? error.name : ''
    // Closing the picker is a decision, not a failure (as for a screen share).
    if (name === 'NotAllowedError' || name === 'AbortError') return { ok: false, message: null }
    console.warn('trio: music share did not start', error)
    return { ok: false, message: desktop ? PREPARE_FAILED_MESSAGE : NOT_SUPPORTED_MESSAGE }
  }

  const video = stream.getVideoTracks()[0]
  const surface = (video?.getSettings() as { displaySurface?: string } | undefined)?.displaySurface
  // The picture is never sent: stopped before anything else.
  for (const track of stream.getVideoTracks()) track.stop()
  const audio = stream.getAudioTracks()[0]
  if (!audio || audio.readyState !== 'live') {
    stopAll(stream)
    return { ok: false, message: desktop ? NO_SEPARATION_MESSAGE : NO_AUDIO_MESSAGE }
  }
  const restricted = (audio.getSettings() as { restrictOwnAudio?: boolean }).restrictOwnAudio === true
  if (desktop ? !restricted : surface !== 'browser' && !restricted) {
    stopAll(stream)
    if (!desktop) return { ok: false, message: OWN_AUDIO_MESSAGE }
    let message = NO_SEPARATION_MESSAGE
    try {
      const support = await desktop.musicCaptureSupport?.()
      if (support && !support.systemAudio && support.message) message = support.message
    } catch {
      // The fallback sentence.
    }
    return { ok: false, message }
  }
  for (const extra of stream.getAudioTracks().slice(1)) extra.stop()
  try {
    audio.contentHint = 'music'
  } catch {
    // Not supported: the encoder's default.
  }
  return {
    ok: true,
    stream: new MediaStream([audio]),
    // No browser exposes the captured tab's title to the capturer: Chrome's track
    // label is an id (`web-contents-media-stream://…`, measured). The sharer types it.
    title: null,
    source: desktop ? 'desktop' : 'browser',
  }
}
