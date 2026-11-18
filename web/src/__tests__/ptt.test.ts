import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { attachPtt, isTypingTarget, mouseButtonCode, PTT_RELEASE_TAIL_MS, PttGate, type TrioDesktopBridge } from '../ptt'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

function gate() {
  const changes: boolean[] = []
  return { gate: new PttGate((open) => changes.push(open)), changes }
}

describe('PttGate', () => {
  it('opens at once and closes 150 ms after release', () => {
    const { gate: g, changes } = gate()
    expect(PTT_RELEASE_TAIL_MS).toBe(150)
    g.setPage(true)
    expect(g.isOpen).toBe(true)
    g.setPage(false)
    vi.advanceTimersByTime(149)
    expect(g.isOpen).toBe(true)
    vi.advanceTimersByTime(1)
    expect(g.isOpen).toBe(false)
    expect(changes).toEqual([true, false])
  })

  it('a press inside the tail keeps it open without flapping', () => {
    const { gate: g, changes } = gate()
    g.setPage(true)
    g.setPage(false)
    vi.advanceTimersByTime(100)
    g.setPage(true)
    vi.advanceTimersByTime(500)
    expect(g.isOpen).toBe(true)
    g.setPage(false)
    vi.advanceTimersByTime(150)
    expect(changes).toEqual([true, false])
  })

  it('combines the desktop hook and the page: held while either holds', () => {
    const { gate: g } = gate()
    g.setDesktop(true)
    g.setPage(true)
    g.setPage(false)
    vi.advanceTimersByTime(1000)
    expect(g.isOpen).toBe(true)
    g.setDesktop(false)
    vi.advanceTimersByTime(150)
    expect(g.isOpen).toBe(false)
  })

  it('reset closes immediately, no tail', () => {
    const { gate: g } = gate()
    g.setPage(true)
    g.reset()
    expect(g.isOpen).toBe(false)
    vi.advanceTimersByTime(1000)
    expect(g.isOpen).toBe(false)
  })

  it('releasing what was never held does nothing', () => {
    const { gate: g, changes } = gate()
    g.setPage(false)
    g.setDesktop(false)
    vi.advanceTimersByTime(1000)
    expect(changes).toEqual([])
  })
})

// --- attachPtt with fake window, document and bridge ---------------------------------

type Listener = (event: never) => void

function fakeTarget() {
  const listeners = new Map<string, Set<Listener>>()
  return {
    visibilityState: 'visible' as DocumentVisibilityState,
    addEventListener: (type: string, listener: Listener) => {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(listener)
    },
    removeEventListener: (type: string, listener: Listener) => {
      listeners.get(type)?.delete(listener)
    },
    fire(type: string, event: object = {}) {
      for (const listener of listeners.get(type) ?? []) (listener as (e: object) => void)(event)
    },
    count: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
  }
}

function fakeBridge() {
  let callback: ((down: boolean) => void) | null = null
  const keys: (string | null)[] = []
  const bridge: TrioDesktopBridge = {
    isDesktop: true,
    setPttKey: (code) => {
      keys.push(code)
    },
    onPtt: (cb) => {
      callback = cb
      return () => {
        callback = null
      }
    },
  }
  return { bridge, keys, press: (down: boolean) => callback?.(down), subscribed: () => callback !== null }
}

const textField = { closest: () => ({ type: 'text' }), isContentEditable: false }
const plain = { closest: () => null, isContentEditable: false }

describe('attachPtt', () => {
  function setup(withBridge = false) {
    const win = fakeTarget()
    const doc = fakeTarget()
    const desk = fakeBridge()
    const { gate: g } = gate()
    const detach = attachPtt(g, 'Backquote', {
      window: win as unknown as Window,
      document: doc as unknown as Document,
      bridge: withBridge ? desk.bridge : null,
    })
    return { win, doc, desk, g, detach }
  }

  it('opens on the key outside text fields', () => {
    const { win, g } = setup()
    win.fire('keydown', { code: 'Backquote', repeat: false, target: plain })
    expect(g.isOpen).toBe(true)
    win.fire('keyup', { code: 'Backquote', target: plain })
    vi.advanceTimersByTime(150)
    expect(g.isOpen).toBe(false)
  })

  it('ignores other keys, auto-repeat and typing in a text field', () => {
    const { win, g } = setup()
    win.fire('keydown', { code: 'KeyA', repeat: false, target: plain })
    win.fire('keydown', { code: 'Backquote', repeat: false, target: textField })
    win.fire('keydown', { code: 'Backquote', repeat: true, target: plain })
    expect(g.isOpen).toBe(false)
  })

  it('a key-up inside a text field still releases', () => {
    const { win, g } = setup()
    win.fire('keydown', { code: 'Backquote', repeat: false, target: plain })
    win.fire('keyup', { code: 'Backquote', target: textField })
    vi.advanceTimersByTime(150)
    expect(g.isOpen).toBe(false)
  })

  it('blur and a hidden page release the in-page key', () => {
    const { win, doc, g } = setup()
    win.fire('keydown', { code: 'Backquote', repeat: false, target: plain })
    win.fire('blur')
    vi.advanceTimersByTime(150)
    expect(g.isOpen).toBe(false)

    win.fire('keydown', { code: 'Backquote', repeat: false, target: plain })
    doc.visibilityState = 'hidden'
    doc.fire('visibilitychange')
    vi.advanceTimersByTime(150)
    expect(g.isOpen).toBe(false)
  })

  it('desktop: tells the bridge the key, uses its events AND the page, blur does not release the global hook', () => {
    const { win, desk, g, detach } = setup(true)
    expect(desk.keys).toEqual(['Backquote'])
    desk.press(true)
    expect(g.isOpen).toBe(true)
    win.fire('blur')
    vi.advanceTimersByTime(500)
    expect(g.isOpen).toBe(true)
    desk.press(false)
    vi.advanceTimersByTime(150)
    expect(g.isOpen).toBe(false)
    // The hook may be dead: the page listener still works on its own.
    win.fire('keydown', { code: 'Backquote', repeat: false, target: plain })
    expect(g.isOpen).toBe(true)
    detach()
    expect(desk.keys).toEqual(['Backquote', null])
    expect(desk.subscribed()).toBe(false)
    expect(g.isOpen).toBe(false)
  })

  it('removes every listener on detach', () => {
    const { win, doc, detach } = setup()
    expect(win.count()).toBeGreaterThan(0)
    detach()
    expect(win.count()).toBe(0)
    expect(doc.count()).toBe(0)
  })

  it('mouse buttons as keys', () => {
    expect(mouseButtonCode(1)).toBe('MouseMiddle')
    expect(mouseButtonCode(3)).toBe('MouseBack')
    expect(mouseButtonCode(4)).toBe('MouseForward')
    expect(mouseButtonCode(0)).toBeNull()
  })

  it('typing targets', () => {
    expect(isTypingTarget(null)).toBe(false)
    expect(isTypingTarget({ isContentEditable: true, closest: () => null } as unknown as EventTarget)).toBe(true)
    expect(isTypingTarget(textField as unknown as EventTarget)).toBe(true)
    expect(isTypingTarget(plain as unknown as EventTarget)).toBe(false)
  })
})
