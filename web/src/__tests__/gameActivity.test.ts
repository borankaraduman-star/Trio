import { describe, expect, it } from 'vitest'
import {
  ActivityStore,
  activityLine,
  activityTooltip,
  elapsedText,
  GameForwarder,
  gameStatusBridge,
  MIN_GAP_MS,
  REFRESH_MS,
  ShareSetting,
  toFrame,
  type ActivityFrame,
  type DesktopGameStatus,
  type GameStatusBridge,
} from '../gameActivity'
import { desktopBridge } from '../ptt'

const T0 = 1_800_000_000
const DETAIL = {
  character: 'Kahve Kokusu',
  realm: '',
  level: 37,
  class: 'ROGUE',
  zone: 'Orgrimmar',
  subzone: 'Valley of Strength',
  source: 'log' as const,
}

describe('ActivityStore', () => {
  it('reads ready.activity, applies activity frames and user.removed', () => {
    const store = new ActivityStore()
    let changes = 0
    store.subscribe(() => changes++)
    store.handleEvent({
      type: 'ready',
      activity: {
        '1': { activity: { game: 'WoW Forever', since: T0, detail: DETAIL }, updated_at: '2026-11-19T10:00:00.000Z' },
        '2': { activity: { game: '', since: T0 } }, // unusable: dropped
      },
    })
    expect(Object.keys(store.getSnapshot())).toEqual(['1'])
    expect(store.get(1)?.activity.detail?.zone).toBe('Orgrimmar')
    store.handleEvent({ type: 'activity', user_id: 3, activity: { game: 'Dota 2', since: T0, detail: null }, updated_at: 'x' })
    expect(store.get(3)?.activity).toEqual({ game: 'Dota 2', since: T0, detail: null, listening: null })
    store.handleEvent({ type: 'activity', user_id: 3, activity: null })
    expect(store.get(3)).toBeUndefined()
    store.handleEvent({ type: 'activity', user_id: 3, activity: null }) // nothing to remove: no change
    store.handleEvent({ type: 'user.removed', user_id: 1 })
    expect(store.getSnapshot()).toEqual({})
    store.handleEvent({ type: 'message.new' })
    expect(changes).toBe(4)
  })

  it('a ready from an old server (no activity) empties the store', () => {
    const store = new ActivityStore()
    store.handleEvent({ type: 'activity', user_id: 3, activity: { game: 'Dota 2', since: T0 } })
    store.handleEvent({ type: 'ready' })
    expect(store.getSnapshot()).toEqual({})
  })
})

describe('display', () => {
  it('the line', () => {
    expect(activityLine({ game: 'WoW Forever', since: T0, detail: DETAIL, listening: null })).toBe('WoW Forever · 37 · Orgrimmar')
    expect(activityLine({ game: 'Counter-Strike 2', since: T0, detail: null, listening: null })).toBe('Counter-Strike 2')
    expect(activityLine({ game: 'WoW', since: T0, detail: { ...DETAIL, zone: '', subzone: 'Dalaran' }, listening: null })).toBe('WoW · 37 · Dalaran')
  })

  it('elapsed time', () => {
    expect(elapsedText(T0, T0 * 1000 + 30_000)).toBe('az önce')
    expect(elapsedText(T0, T0 * 1000 + 5 * 60_000)).toBe('5 dk')
    expect(elapsedText(T0, T0 * 1000 + 80 * 60_000)).toBe('1 sa 20 dk')
    expect(elapsedText(T0, T0 * 1000 + 120 * 60_000)).toBe('2 sa')
  })

  it('the tooltip names character, realm, class, place and freshness', () => {
    const text = activityTooltip(
      { activity: { game: 'WoW Forever', since: T0, detail: { ...DETAIL, realm: 'Kazzak' }, listening: null }, updatedAt: new Date(T0 * 1000).toISOString() },
      T0 * 1000 + 3 * 60_000,
    )
    expect(text).toContain('Kahve Kokusu (Kazzak) · 37. seviye · Haydut')
    expect(text).toContain('Orgrimmar › Valley of Strength')
    expect(text).toContain('WoW Forever · 3 dk oynuyor')
    expect(text).toContain('Güncellendi: 3 dk önce')
  })
})

describe('toFrame', () => {
  it('a full status, a process-only status, junk', () => {
    expect(toFrame({ game: 'WoW Forever', since: T0, detail: DETAIL })).toEqual({
      type: 'activity.set',
      game: 'WoW Forever',
      since: T0,
      detail: DETAIL,
    })
    expect(toFrame({ game: 'Dota 2', since: T0 + 0.7 })).toEqual({ type: 'activity.set', game: 'Dota 2', since: T0 })
    expect(toFrame(null)).toBeNull()
    expect(toFrame({ game: '', since: T0 })).toBeNull()
    expect(toFrame({ game: 'X', since: Number.NaN })).toBeNull()
  })
})

function memoryStorage(initial: Record<string, string> = {}) {
  const data = { ...initial }
  return { getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => void (data[k] = v), data }
}

function setup(opts: { bridge?: boolean; share?: boolean; held?: boolean } = {}) {
  let now = 1_000_000
  const timers: { at: number; fn: () => void; id: number }[] = []
  let nextId = 1
  const sent: ActivityFrame[] = []
  let connected = true
  let emit: ((s: DesktopGameStatus | null) => void) | null = null
  let subscriptions = 0
  const bridge: GameStatusBridge = {
    gameStatus: { supported: true },
    onGameStatus: (cb) => {
      emit = cb
      subscriptions++
      return () => {
        emit = null
      }
    },
  }
  const storage = memoryStorage(opts.share === false ? { 'trio.gameShare': '0' } : {})
  const share = new ShareSetting(storage)
  const store = new ActivityStore()
  if (opts.held) store.handleEvent({ type: 'activity', user_id: 7, activity: { game: 'WoW', since: T0 } })
  const forwarder = new GameForwarder(
    (frame) => {
      if (!connected) return false
      sent.push(frame)
      return true
    },
    opts.bridge === false ? null : bridge,
    share,
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
    share,
    store,
    storage,
    advance,
    emit: (s: DesktopGameStatus | null) => emit?.(s),
    get subscribed() {
      return emit !== null
    },
    get subscriptions() {
      return subscriptions
    },
    setConnected: (c: boolean) => {
      connected = c
    },
  }
}

const WOW: DesktopGameStatus = { game: 'WoW Forever', since: T0, detail: DETAIL }

describe('GameForwarder', () => {
  it('forwards a status, a change and a clear', () => {
    const t = setup()
    t.forwarder.start()
    expect(t.subscribed).toBe(true)
    t.emit(WOW)
    expect(t.sent).toEqual([toFrame(WOW)])
    t.advance(MIN_GAP_MS)
    t.emit({ ...WOW, detail: { ...DETAIL, zone: 'Durotar' } })
    expect(t.sent).toHaveLength(2)
    t.advance(MIN_GAP_MS)
    t.emit(null)
    expect(t.sent[2]).toEqual({ type: 'activity.clear' })
    t.emit(null) // nothing more to clear
    t.advance(REFRESH_MS * 2)
    expect(t.sent).toHaveLength(3)
  })

  it('a burst is coalesced to the latest, within the rate', () => {
    const t = setup()
    t.forwarder.start()
    t.emit(WOW)
    for (let level = 38; level < 45; level++) t.emit({ ...WOW, detail: { ...DETAIL, level } })
    expect(t.sent).toHaveLength(1)
    t.advance(MIN_GAP_MS)
    expect(t.sent).toHaveLength(2)
    expect(t.sent[1]).toMatchObject({ detail: { level: 44 } })
  })

  it('an unchanged status is re-sent every few minutes (the server forgets after 10)', () => {
    const t = setup()
    t.forwarder.start()
    t.emit(WOW)
    t.emit(WOW)
    expect(t.sent).toHaveLength(1)
    t.advance(REFRESH_MS - 1)
    expect(t.sent).toHaveLength(1)
    t.advance(1)
    expect(t.sent).toHaveLength(2)
    t.advance(REFRESH_MS)
    expect(t.sent).toHaveLength(3)
  })

  it('after a reconnect the status is sent again', () => {
    const t = setup()
    t.forwarder.start()
    t.setConnected(false)
    t.emit(WOW)
    expect(t.sent).toHaveLength(0)
    t.setConnected(true)
    t.forwarder.onReady()
    expect(t.sent).toEqual([toFrame(WOW)])
    t.advance(1000)
    t.forwarder.onReady() // another reconnect: the server may have restarted
    expect(t.sent).toHaveLength(2)
  })

  it('a status that went away while disconnected is cleared on reconnect', () => {
    const t = setup({ held: true })
    t.forwarder.start()
    t.emit(WOW)
    t.setConnected(false)
    t.advance(MIN_GAP_MS)
    t.emit(null)
    t.setConnected(true)
    t.forwarder.onReady()
    expect(t.sent.at(-1)).toEqual({ type: 'activity.clear' })
  })

  it('sharing off: unsubscribes, clears once, sends nothing more; on again resumes', () => {
    const t = setup()
    t.forwarder.start()
    t.emit(WOW)
    t.advance(MIN_GAP_MS)
    t.share.set(false)
    expect(t.storage.data['trio.gameShare']).toBe('0')
    expect(t.subscribed).toBe(false)
    expect(t.sent.at(-1)).toEqual({ type: 'activity.clear' })
    const count = t.sent.length
    t.advance(REFRESH_MS * 3)
    t.forwarder.onReady()
    expect(t.sent).toHaveLength(count)
    t.share.set(true)
    expect(t.subscribed).toBe(true)
    t.emit(WOW)
    expect(t.sent.at(-1)).toEqual(toFrame(WOW))
  })

  it('stored off: never subscribes; clears a leftover on ready', () => {
    const t = setup({ share: false, held: true })
    t.forwarder.start()
    expect(t.subscriptions).toBe(0)
    t.forwarder.onReady()
    expect(t.sent).toEqual([{ type: 'activity.clear' }])
  })

  it('a browser without the desktop bridge never sends on its own', () => {
    const t = setup({ bridge: false, held: true })
    t.forwarder.start()
    t.forwarder.onReady()
    t.advance(REFRESH_MS * 2)
    expect(t.sent).toEqual([])
  })

  it('before the desktop app has said anything, a ready does not clear', () => {
    const t = setup({ held: true })
    t.forwarder.start()
    t.forwarder.onReady()
    expect(t.sent).toEqual([])
  })
})

describe('the desktop bridge, old and new', () => {
  const withBridge = (bridge: unknown, check: () => void) => {
    const holder = globalThis as { trioDesktop?: unknown }
    const before = holder.trioDesktop
    holder.trioDesktop = bridge
    try {
      check()
    } finally {
      holder.trioDesktop = before
    }
  }
  const ptt = { isDesktop: true, setPttKey: () => undefined, onPtt: () => () => undefined }

  it('an old desktop app (before CONTRACT-V5) is still the desktop for push-to-talk and sends no game status', () => {
    withBridge(ptt, () => {
      expect(desktopBridge()).not.toBeNull()
      expect(gameStatusBridge()).toBeNull()
    })
  })

  it('a new one is both', () => {
    withBridge({ ...ptt, gameStatus: { supported: true }, onGameStatus: () => () => undefined }, () => {
      expect(desktopBridge()).not.toBeNull()
      expect(gameStatusBridge()).not.toBeNull()
    })
  })

  it('a browser is neither', () => {
    withBridge(undefined, () => {
      expect(desktopBridge()).toBeNull()
      expect(gameStatusBridge()).toBeNull()
    })
  })
})
