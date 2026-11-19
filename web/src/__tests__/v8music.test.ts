import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  browserMusicOptions,
  captureMusic,
  DESKTOP_MUSIC_OPTIONS,
  NO_AUDIO_MESSAGE,
  NO_SEPARATION_MESSAGE,
  OLD_APP_MESSAGE,
  OWN_AUDIO_MESSAGE,
  titleFromLabel,
  type CaptureEnv,
  type DesktopMusicBridge,
} from '../music/capture'
import {
  cleanTitle,
  DEFAULT_MUSIC_VOLUME,
  MUSIC_PREFS_KEY,
  MusicPrefsStore,
  musicElementState,
  nowPlayingTitle,
  validateMusicPrefs,
} from '../music/musicPrefs'
import { midsForStream, withStereo } from '../music/opusStereo'
import { classifyStreams, parseMeta, sameMeta } from '../lib/streamMeta'
import { createInitialState, reducer } from '../store'

// --- fakes -----------------------------------------------------------------------

class FakeTrack {
  readyState = 'live'
  stopped = false
  contentHint = ''
  constructor(
    public kind: 'audio' | 'video',
    public label = '',
    private settings: Record<string, unknown> = {},
  ) {}
  stop() {
    this.stopped = true
    this.readyState = 'ended'
  }
  getSettings() {
    return this.settings
  }
}

class FakeStream {
  static next = 0
  id = `s${++FakeStream.next}`
  constructor(public tracks: FakeTrack[] = []) {}
  getTracks() {
    return this.tracks
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio')
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video')
  }
}

beforeEach(() => {
  vi.stubGlobal('MediaStream', FakeStream)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

function displayStream(surface: string, audio: Record<string, unknown> | null, label = 'web-contents-media-stream://AB') {
  const tracks = [new FakeTrack('video', label, { displaySurface: surface })]
  if (audio) tracks.push(new FakeTrack('audio', 'Tab audio', audio))
  return new FakeStream(tracks)
}

function env(stream: FakeStream | Error, bridge: DesktopMusicBridge | null = null, restrict = true) {
  const calls: { options: DisplayMediaStreamOptions; at: number }[] = []
  const e: CaptureEnv = {
    getDisplayMedia: vi.fn(async (options: DisplayMediaStreamOptions) => {
      calls.push({ options, at: Date.now() })
      if (stream instanceof Error) throw stream
      return stream as unknown as MediaStream
    }),
    supported: { restrictOwnAudio: restrict, suppressLocalAudioPlayback: true },
    bridge,
  }
  return { e, calls }
}

// --- capture -------------------------------------------------------------------------

describe('captureMusic in a browser', () => {
  it('asks for a tab with raw stereo sound, without Trio\'s own tab, and stops the picture at once', async () => {
    const stream = displayStream('browser', { restrictOwnAudio: false })
    const { e, calls } = env(stream)
    const result = await captureMusic(e)
    expect(result.ok).toBe(true)
    const options = calls[0].options as Record<string, unknown>
    expect(options.selfBrowserSurface).toBe('exclude')
    expect(options.surfaceSwitching).toBe('exclude')
    expect(options.preferCurrentTab).toBe(false)
    expect(options.audio).toMatchObject({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 2,
      restrictOwnAudio: true,
      suppressLocalAudioPlayback: false,
    })
    expect(stream.getVideoTracks()[0].stopped).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    const out = result.stream as unknown as FakeStream
    expect(out.getVideoTracks()).toHaveLength(0)
    expect(out.getAudioTracks()[0].stopped).toBe(false)
    expect(out.getAudioTracks()[0].contentHint).toBe('music')
    expect(result.source).toBe('browser')
    // Chrome's tab label is an internal id: no title from it.
    expect(result.title).toBeNull()
  })

  it('offers only tabs where the browser cannot keep its own sound out', () => {
    const options = browserMusicOptions({}) as Record<string, unknown>
    expect(options.systemAudio).toBe('exclude')
    expect(options.monitorTypeSurfaces).toBe('exclude')
    expect(options.windowAudio).toBe('exclude')
    expect((options.audio as Record<string, unknown>).restrictOwnAudio).toBeUndefined()
    const restricting = browserMusicOptions({ restrictOwnAudio: true }) as Record<string, unknown>
    expect(restricting.systemAudio).toBe('include')
  })

  it('a share with no sound (the box was not ticked) is a clear error, not a silent share', async () => {
    const stream = displayStream('browser', null)
    const { e } = env(stream)
    expect(await captureMusic(e)).toEqual({ ok: false, message: NO_AUDIO_MESSAGE })
    expect(stream.getTracks().every((t) => t.stopped)).toBe(true)
  })

  it('a screen whose sound still has Trio in it is refused', async () => {
    const stream = displayStream('monitor', { restrictOwnAudio: false })
    const { e } = env(stream)
    expect(await captureMusic(e)).toEqual({ ok: false, message: OWN_AUDIO_MESSAGE })
    expect(stream.getTracks().every((t) => t.stopped)).toBe(true)
    // ...and accepted where the browser did keep its own sound out.
    expect((await captureMusic(env(displayStream('monitor', { restrictOwnAudio: true })).e)).ok).toBe(true)
  })

  it('closing the picker says nothing', async () => {
    const error = Object.assign(new Error('x'), { name: 'NotAllowedError' })
    expect(await captureMusic(env(error).e)).toEqual({ ok: false, message: null })
  })

  it('a window label can be a title; internal ids are not', () => {
    expect(titleFromLabel('web-contents-media-stream://1F17')).toBeNull()
    expect(titleFromLabel('screen:0:0')).toBeNull()
    expect(titleFromLabel('window:12:0')).toBeNull()
    expect(titleFromLabel('  Lo-fi beats - YouTube ')).toBe('Lo-fi beats - YouTube')
  })
})

describe('captureMusic in the desktop app', () => {
  it('an app without prepareMusicCapture captures nothing', async () => {
    const { e } = env(displayStream('monitor', { restrictOwnAudio: true }), { isDesktop: true })
    expect(await captureMusic(e)).toEqual({ ok: false, message: OLD_APP_MESSAGE })
    expect(e.getDisplayMedia).not.toHaveBeenCalled()
  })

  it('prepare, then getDisplayMedia straight after (nothing between), with the contract\'s options', async () => {
    const order: string[] = []
    const stream = displayStream('monitor', { restrictOwnAudio: true })
    const bridge: DesktopMusicBridge = {
      isDesktop: true,
      prepareMusicCapture: vi.fn(async () => {
        order.push('prepare')
        return { ok: true as const }
      }),
      musicCaptureSupport: vi.fn(async () => {
        order.push('support')
        return { systemAudio: true as const }
      }),
    }
    const e: CaptureEnv = {
      getDisplayMedia: vi.fn(async (options: DisplayMediaStreamOptions) => {
        order.push('getDisplayMedia')
        expect(options).toBe(DESKTOP_MUSIC_OPTIONS)
        return stream as unknown as MediaStream
      }),
      supported: {},
      bridge,
    }
    // The click handler's first await is the capture: count the microtask turns
    // between prepare resolving and getDisplayMedia being called.
    let turns = 0
    let counting = false
    bridge.prepareMusicCapture = vi.fn(() => {
      order.push('prepare')
      counting = true
      const tick = () => {
        if (!counting) return
        turns += 1
        if (turns < 50) queueMicrotask(tick)
      }
      queueMicrotask(tick)
      return Promise.resolve({ ok: true as const })
    })
    const original = e.getDisplayMedia!
    e.getDisplayMedia = vi.fn(async (options: DisplayMediaStreamOptions) => {
      counting = false
      return original(options)
    })
    const result = await captureMusic(e)
    expect(result.ok).toBe(true)
    expect(order).toEqual(['prepare', 'getDisplayMedia'])
    // Only the await of prepare itself: no timer, no other request in between.
    expect(turns).toBeLessThanOrEqual(3)
    expect(DESKTOP_MUSIC_OPTIONS.audio).toMatchObject({ restrictOwnAudio: true, echoCancellation: false, channelCount: 2 })
    expect((DESKTOP_MUSIC_OPTIONS as Record<string, unknown>).systemAudio).toBe('include')
    if (result.ok) expect(result.source).toBe('desktop')
    expect(stream.getVideoTracks()[0].stopped).toBe(true)
  })

  it('a refused prepare shows its message and captures nothing', async () => {
    const bridge: DesktopMusicBridge = {
      isDesktop: true,
      prepareMusicCapture: async () => ({ ok: false, reason: 'windows-version', message: 'Windows 11 gerekir.' }),
    }
    const { e } = env(displayStream('monitor', { restrictOwnAudio: true }), bridge)
    expect(await captureMusic(e)).toEqual({ ok: false, message: 'Windows 11 gerekir.' })
    expect(e.getDisplayMedia).not.toHaveBeenCalled()
  })

  it('a track that does not say restrictOwnAudio: true is never kept', async () => {
    const stream = displayStream('monitor', { restrictOwnAudio: false })
    const bridge: DesktopMusicBridge = { isDesktop: true, prepareMusicCapture: async () => ({ ok: true }) }
    expect(await captureMusic(env(stream, bridge).e)).toEqual({ ok: false, message: NO_SEPARATION_MESSAGE })
    expect(stream.getTracks().every((t) => t.stopped)).toBe(true)
    const withSupport: DesktopMusicBridge = {
      ...bridge,
      musicCaptureSupport: async () => ({ systemAudio: false, reason: 'windows-version', message: 'Bu Windows desteklemiyor.' }),
    }
    expect(await captureMusic(env(displayStream('monitor', { restrictOwnAudio: false }), withSupport).e)).toEqual({
      ok: false,
      message: 'Bu Windows desteklemiyor.',
    })
  })
})

// --- stereo SDP ---------------------------------------------------------------------------

const SDP = [
  'v=0',
  'o=- 1 2 IN IP4 127.0.0.1',
  's=-',
  'a=group:BUNDLE 0 1 2',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 63',
  'a=mid:0',
  'a=msid:micstream mictrack',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 minptime=10;useinbandfec=1',
  'a=rtpmap:63 red/48000/2',
  'm=video 9 UDP/TLS/RTP/SAVPF 96',
  'a=mid:1',
  'a=rtpmap:96 VP8/90000',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'a=mid:2',
  'a=msid:musicstream musictrack',
  'a=rtpmap:111 opus/48000/2',
  'a=fmtp:111 minptime=10;useinbandfec=1',
  '',
].join('\r\n')

describe('withStereo', () => {
  it('makes only the named audio m-lines stereo', () => {
    const out = withStereo(SDP, new Set(['2']))
    const sections = out.split('\r\nm=')
    expect(sections[1]).toContain('a=fmtp:111 minptime=10;useinbandfec=1\r\n')
    expect(sections[3]).toContain('a=fmtp:111 minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1')
    expect(out.split('\r\n').length).toBe(SDP.split('\r\n').length)
  })

  it('is idempotent and leaves the description alone with no mids', () => {
    const once = withStereo(SDP, new Set(['2']))
    expect(withStereo(once, new Set(['2']))).toBe(once)
    expect(withStereo(SDP, new Set())).toBe(SDP)
  })

  it('adds an fmtp line where there is none', () => {
    const bare = SDP.replace('a=mid:2\r\na=msid:musicstream musictrack\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;useinbandfec=1', 'a=mid:2\r\na=rtpmap:111 opus/48000/2')
    expect(withStereo(bare, new Set(['2']))).toContain('a=rtpmap:111 opus/48000/2\r\na=fmtp:111 stereo=1;sprop-stereo=1')
  })

  it('finds the m-lines of a stream by msid', () => {
    expect(midsForStream(SDP, 'musicstream')).toEqual(['2'])
    expect(midsForStream(SDP, 'micstream')).toEqual(['0'])
    expect(midsForStream(SDP, null)).toEqual([])
    expect(midsForStream(undefined, 'x')).toEqual([])
  })
})

// --- meta, store, prefs ------------------------------------------------------------------

describe('meta.music', () => {
  const stream = (id: string, kinds: string[]) => ({
    id,
    getTracks: () => kinds,
    getVideoTracks: () => kinds.filter((k) => k === 'video'),
  })

  it('is read, compared, and never taken for the microphone', () => {
    expect(parseMeta({ meta: { camera: null, screen: null, music: 'm1' } })).toEqual({ camera: null, screen: null, music: 'm1' })
    expect(parseMeta({ meta: { camera: null, screen: null, music: '' } })).toEqual({ camera: null, screen: null })
    expect(sameMeta({ camera: null, screen: null }, { camera: null, screen: null, music: null })).toBe(true)
    expect(sameMeta({ camera: null, screen: null }, { camera: null, screen: null, music: 'm1' })).toBe(false)
    const mic = stream('mic', ['audio'])
    const music = stream('m1', ['audio'])
    // Whatever the order, the named stream is music and the mic stays the mic.
    expect(classifyStreams([mic, music], { camera: null, screen: null, music: 'm1' })).toMatchObject({ audio: mic, music })
    expect(classifyStreams([music, mic], { camera: null, screen: null, music: 'm1' })).toMatchObject({ audio: mic, music })
  })
})

describe('the store', () => {
  it('keeps music and its title from voice.joined and voice.state, and drops them when a frame has none', () => {
    let state = createInitialState({ me: { id: 1, name: 'Ali' } as never })
    const base = { channel_id: 2, user_id: 7, muted: false, deafened: false, screensharing: false }
    const server = (event: unknown) => reducer(state, { type: 'server', event, now: 1000, viewing: true } as never)
    state = server({ type: 'voice.joined', ...base, music: true, music_title: 'Parça' })
    expect(state.voice[2][0]).toMatchObject({ music: true, music_title: 'Parça' })
    state = server({ type: 'voice.state', ...base, music: true, music_title: null })
    expect(state.voice[2][0]).toMatchObject({ music: true, music_title: null })
    state = server({ type: 'voice.state', ...base })
    expect(state.voice[2][0].music).toBeUndefined()
    expect(state.voice[2][0].music_title).toBeUndefined()
  })
})

describe('music prefs', () => {
  it('defaults to 50 %, title on; validates field by field', () => {
    expect(validateMusicPrefs(null)).toEqual({ volumes: {}, showTitle: true })
    expect(validateMusicPrefs({ showTitle: false, volumes: { '3': { volume: 7, muted: true }, x: { volume: 1 }, '4': { volume: 0.5 } } })).toEqual({
      showTitle: false,
      volumes: { '3': { volume: 1, muted: true } },
    })
  })

  it('is remembered on the device, apart from the voice volume', () => {
    const data = new Map<string, string>()
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) }
    const store = new MusicPrefsStore(storage)
    store.setVolume(5, 0.3)
    store.setMuted(5, true)
    store.setShowTitle(false)
    expect(JSON.parse(data.get(MUSIC_PREFS_KEY)!)).toEqual({ volumes: { '5': { volume: 0.3, muted: true } }, showTitle: false })
    expect(data.has('trio.voice6')).toBe(false)
    expect(new MusicPrefsStore(storage).getSnapshot().volumes['5']).toEqual({ volume: 0.3, muted: true })
  })

  it('deafen and the music mute both silence the element; the volume never boosts', () => {
    const prefs = validateMusicPrefs({ volumes: { '5': { volume: 0.8, muted: false } } })
    expect(musicElementState(prefs, 5, false)).toEqual({ volume: 0.8, muted: false })
    expect(musicElementState(prefs, 5, true)).toEqual({ volume: 0.8, muted: true })
    expect(musicElementState(prefs, 9, false)).toEqual({ volume: DEFAULT_MUSIC_VOLUME, muted: false })
    expect(validateMusicPrefs({ volumes: { '5': { volume: 2 } } }).volumes['5'].volume).toBe(1)
  })

  it('cleans titles to one line of text', () => {
    expect(cleanTitle('  a‮b\nc  ')).toBe('a b c')
    expect(cleanTitle('   ')).toBeNull()
    expect(cleanTitle('x'.repeat(200))).toHaveLength(120)
    expect(nowPlayingTitle({ title: 'One More Time', artist: 'Daft Punk', app: 'Spotify' })).toBe('Daft Punk — One More Time')
    expect(nowPlayingTitle({ title: 'Daft Punk - One More Time', artist: 'Daft Punk' })).toBe('Daft Punk - One More Time')
    expect(nowPlayingTitle(null)).toBeNull()
  })
})
