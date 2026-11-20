import { describe, expect, it } from 'vitest'
import {
  ActivityForwarder,
  ActivityStore,
  activityLine,
  activitySummary,
  LISTEN_GAP_MS,
  listeningLine,
  MIN_GAP_MS,
  parseActivity,
  ShareSetting,
  shortActivity,
  songText,
  type ActivityFrame,
  type Listening,
} from '../gameActivity'
import {
  healthText,
  ListeningSource,
  ListenPrefs,
  listeningSupport,
  parseDesktopState,
  type DesktopListeningState,
  type ListeningBridge,
} from '../activity/listening'

const T0 = 1_800_000_000
const SONG: Listening = { title: 'Bir Derdim Var', artist: 'mor ve ötesi', app: 'Spotify' }

function memory(initial: Record<string, string> = {}) {
  const data: Record<string, string> = { ...initial }
  return {
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => void (data[k] = v),
    removeItem: (k: string) => void delete data[k],
    data,
  }
}

describe('the activity on the wire (V11)', () => {
  it('a listening-only entry parses with a null game; a game entry keeps listening', () => {
    expect(parseActivity({ game: null, since: null, detail: null, listening: SONG })).toEqual({
      game: null,
      since: null,
      detail: null,
      listening: SONG,
    })
    expect(parseActivity({ game: 'Dota 2', since: T0, listening: { title: ' A\n‮B ', artist: 5 } })).toEqual({
      game: 'Dota 2',
      since: T0,
      detail: null,
      listening: { title: 'A B', artist: '', app: '' },
    })
    expect(parseActivity({ game: null, listening: { title: '' } })).toBeNull()
    expect(parseActivity({ listening: '<b>x</b>' })).toBeNull()
  })

  it('the store keeps one person’s entry object when somebody else changes', () => {
    const store = new ActivityStore()
    store.handleEvent({ type: 'activity', user_id: 1, activity: { game: null, since: null, detail: null, listening: SONG } })
    const one = store.get(1)
    store.handleEvent({ type: 'activity', user_id: 2, activity: { game: 'Dota 2', since: T0 } })
    expect(store.get(1)).toBe(one)
  })
})

describe('display', () => {
  it('song, line, short and summary', () => {
    expect(songText(SONG)).toBe('mor ve ötesi — Bir Derdim Var')
    expect(songText({ title: 'mor ve ötesi - Bir Derdim Var', artist: 'mor ve ötesi', app: '' })).toBe(
      'mor ve ötesi - Bir Derdim Var',
    )
    expect(listeningLine(SONG)).toBe('Spotify · mor ve ötesi — Bir Derdim Var')
    expect(listeningLine({ ...SONG, app: '' })).toBe('mor ve ötesi — Bir Derdim Var')
    const both = { game: 'WoW Forever', since: T0, detail: null, listening: SONG }
    expect(shortActivity(both)).toBe('WoW Forever')
    expect(shortActivity({ ...both, game: null, since: null })).toBe('mor ve ötesi — Bir Derdim Var')
    expect(activityLine({ ...both, game: null, since: null })).toBe('')
    expect(activitySummary(both)).toBe('WoW Forever · dinliyor: Spotify · mor ve ötesi — Bir Derdim Var')
  })
})

// --------------------------------------------------------------------- the page's listening source

function fakeBridge(opts: { supported?: boolean; v11?: boolean } = {}) {
  const wishes: { on: boolean; browsers: boolean }[] = []
  let cb: ((s: DesktopListeningState) => void) | null = null
  const bridge: ListeningBridge = { isDesktop: true }
  if (opts.v11 !== false) {
    bridge.listeningStatus = { supported: opts.supported !== false }
    bridge.setListeningStatus = (w) => wishes.push(w)
    bridge.onListening = (c) => {
      cb = c
      return () => {
        cb = null
      }
    }
  }
  return { bridge, wishes, emit: (s: DesktopListeningState) => cb?.(s), get listening() {
    return cb !== null
  } }
}

const PLAYING: DesktopListeningState = { playing: { title: SONG.title, artist: SONG.artist, app: SONG.app }, health: 'ok' }

describe('privacy defaults and the first-run notice', () => {
  it('on by default, browsers off by default, the notice not answered', () => {
    const prefs = new ListenPrefs(memory())
    expect(prefs.getSnapshot()).toEqual({ on: true, browsers: false, acked: false })
  })

  it('the watcher starts with the setting; nothing is offered for sending until “Tamam”', () => {
    const storage = memory()
    const prefs = new ListenPrefs(storage)
    const b = fakeBridge()
    const source = new ListeningSource(b.bridge, prefs)
    source.start()
    expect(b.wishes).toEqual([{ on: true, browsers: false }])
    b.emit(PLAYING)
    expect(source.getSnapshot().needsNotice).toBe(true)
    expect(source.value()).toBeNull()
    expect(source.resolved()).toBe(true) // not acked: nothing may go, and that is decided
    prefs.answerNotice(true)
    expect(storage.data['trio.v11.listenAck']).toBe('1')
    expect(source.getSnapshot().needsNotice).toBe(false)
    expect(source.value()).toEqual(SONG)
  })

  it('“Kapat” on the notice turns the setting off and stops the watcher', () => {
    const storage = memory()
    const prefs = new ListenPrefs(storage)
    const b = fakeBridge()
    const source = new ListeningSource(b.bridge, prefs)
    source.start()
    b.emit(PLAYING)
    prefs.answerNotice(false)
    expect(prefs.getSnapshot().on).toBe(false)
    expect(storage.data['trio.v11.listen']).toBe('0')
    expect(b.wishes.at(-1)).toEqual({ on: false, browsers: false })
    expect(b.listening).toBe(false)
    expect(source.value()).toBeNull()
  })

  it('the browsers option goes to the shell (and only with the setting on)', () => {
    const prefs = new ListenPrefs(memory({ 'trio.v11.listenAck': '1' }))
    const b = fakeBridge()
    const source = new ListeningSource(b.bridge, prefs)
    source.start()
    prefs.setBrowsers(true)
    expect(b.wishes.at(-1)).toEqual({ on: true, browsers: true })
    prefs.setOn(false)
    expect(b.wishes.at(-1)).toEqual({ on: false, browsers: false })
  })

  it('a browser, an old app and macOS/Linux read nothing and say why', () => {
    expect(listeningSupport(null)).toBe('browser')
    const old = fakeBridge({ v11: false })
    expect(listeningSupport(old.bridge)).toBe('old-app')
    const mac = fakeBridge({ supported: false })
    expect(listeningSupport(mac.bridge)).toBe('unsupported-os')
    const prefs = new ListenPrefs(memory({ 'trio.v11.listenAck': '1' }))
    const source = new ListeningSource(old.bridge, prefs)
    source.start()
    expect(source.value()).toBeNull()
    expect(healthText('old-app', null, true)).toMatch(/güncelle/)
    expect(healthText('unsupported-os', null, true)).toBe('Bu sistemde otomatik algılanamıyor.')
    expect(healthText('browser', null, true)).toMatch(/masaüstü/)
    const macSource = new ListeningSource(mac.bridge, prefs)
    macSource.start()
    expect(mac.wishes).toEqual([])
  })

  it('a failed reader is shown, not silent', () => {
    expect(healthText('ok', { playing: null, health: 'failed', message: 'Müzik durumu okunamadı: x' }, true)).toBe(
      'Müzik durumu okunamadı: x',
    )
    expect(healthText('ok', { playing: null, health: 'ok' }, true)).toBeNull()
  })

  it('the desktop state is checked: junk is cleaned or dropped', () => {
    expect(parseDesktopState(null)).toBeNull()
    expect(parseDesktopState({ health: 'weird', playing: { title: '' } })).toEqual({ playing: null, health: 'failed' })
    expect(parseDesktopState({ health: 'ok', playing: { title: 'A\nB' }, lastApp: { name: 'Spotify.exe', shown: true } })).toEqual({
      playing: { title: 'A B', artist: '', app: '' },
      health: 'ok',
      lastApp: { name: 'Spotify.exe', shown: true },
    })
  })
})

// --------------------------------------------------------------------- the forwarder with both parts

function setup(opts: { game?: boolean } = {}) {
  let now = 1_000_000
  const timers: { at: number; fn: () => void; id: number }[] = []
  let nextId = 1
  const sent: ActivityFrame[] = []
  let value: Listening | null = null
  let resolved = true
  const listeners = new Set<() => void>()
  const input = {
    subscribe: (l: () => void) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    value: () => value,
    resolved: () => resolved,
  }
  let emitGame: ((s: unknown) => void) | null = null
  const bridge = opts.game
    ? {
        onGameStatus: (cb: (s: unknown) => void) => {
          emitGame = cb
          return () => undefined
        },
      }
    : null
  const store = new ActivityStore()
  const forwarder = new ActivityForwarder(
    (f) => {
      sent.push(f)
      return true
    },
    bridge as never,
    new ShareSetting(memory()),
    () => 7,
    {
      now: () => now,
      setTimeout: (fn, ms) => {
        const id = nextId++
        timers.push({ at: now + ms, fn, id })
        return id
      },
      clearTimeout: (id) => {
        const i = timers.findIndex((t) => t.id === id)
        if (i >= 0) timers.splice(i, 1)
      },
    },
    store,
    input,
  )
  const advance = (ms: number) => {
    const end = now + ms
    for (;;) {
      timers.sort((a, b) => a.at - b.at)
      const next = timers[0]
      if (!next || next.at > end) break
      timers.shift()
      now = next.at
      next.fn()
    }
    now = end
  }
  return {
    forwarder,
    sent,
    store,
    advance,
    set: (v: Listening | null) => {
      value = v
      for (const l of listeners) l()
    },
    setResolved: (r: boolean) => {
      resolved = r
    },
    game: (s: unknown) => emitGame?.(s),
  }
}

describe('ActivityForwarder with listening', () => {
  it('sends listening only once the server announced it', () => {
    const t = setup()
    t.forwarder.start()
    t.forwarder.onReady(['game'])
    t.set(SONG)
    expect(t.sent).toEqual([])
    t.forwarder.onReady(['game', 'listening'])
    expect(t.sent).toEqual([{ type: 'activity.set', listening: SONG }])
  })

  it('merges game and listening into one frame', () => {
    const t = setup({ game: true })
    t.forwarder.start()
    t.forwarder.onReady(['game', 'listening'])
    t.game({ game: 'Dota 2', since: T0 })
    t.advance(MIN_GAP_MS)
    t.set(SONG)
    t.advance(LISTEN_GAP_MS)
    expect(t.sent.at(-1)).toEqual({ type: 'activity.set', game: 'Dota 2', since: T0, listening: SONG })
  })

  it('a new song waits for the 5 s gap; stopping goes after the 3 s frame gap only', () => {
    const t = setup()
    t.forwarder.start()
    t.forwarder.onReady(['game', 'listening'])
    t.set(SONG)
    expect(t.sent).toHaveLength(1)
    t.advance(MIN_GAP_MS)
    t.set({ ...SONG, title: 'İkinci' })
    expect(t.sent).toHaveLength(1)
    t.advance(LISTEN_GAP_MS - MIN_GAP_MS - 1)
    expect(t.sent).toHaveLength(1)
    t.advance(1)
    expect(t.sent.at(-1)).toEqual({ type: 'activity.set', listening: { ...SONG, title: 'İkinci' } })
    // Rapid skipping: only the latest goes.
    t.advance(1000)
    t.set({ ...SONG, title: 'Üç' })
    t.set({ ...SONG, title: 'Dört' })
    t.advance(LISTEN_GAP_MS)
    expect(t.sent).toHaveLength(3)
    expect(t.sent.at(-1)).toEqual({ type: 'activity.set', listening: { ...SONG, title: 'Dört' } })
    // Stopping (the setting off): no listening gap.
    t.advance(MIN_GAP_MS)
    t.set(null)
    expect(t.sent.at(-1)).toEqual({ type: 'activity.clear' })
  })

  it('after a ready it waits for the desktop’s first word instead of clearing what the server holds', () => {
    const t = setup()
    t.forwarder.start()
    t.store.handleEvent({ type: 'activity', user_id: 7, activity: { game: null, listening: SONG } })
    t.setResolved(false)
    t.forwarder.onReady(['game', 'listening'])
    expect(t.sent).toEqual([])
    t.setResolved(true)
    t.set(SONG)
    expect(t.sent).toEqual([{ type: 'activity.set', listening: SONG }])
  })

  it('a reconnect re-sends the same song at once (the server may have restarted)', () => {
    const t = setup()
    t.forwarder.start()
    t.forwarder.onReady(['game', 'listening'])
    t.set(SONG)
    t.advance(1000)
    t.forwarder.onReady(['game', 'listening'])
    expect(t.sent).toHaveLength(2)
  })
})
