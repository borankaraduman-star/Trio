import { describe, expect, it } from 'vitest'
import { ContextKeeper, type KeeperTargets } from '../audio/contextKeeper'

/** An AudioContext as iOS treats one: resume() only works when the platform allows it. */
class FakeContext {
  state = 'running'
  onstatechange: ((event: Event) => unknown) | null = null
  /** Whether resume() would succeed now (an interruption over, a gesture in progress...). */
  allowResume = false
  resumeCalls = 0

  setState(state: string): void {
    this.state = state
    this.onstatechange?.(new Event('statechange'))
  }

  resume(): Promise<void> {
    this.resumeCalls += 1
    if (!this.allowResume) return Promise.reject(new DOMException('not allowed', 'NotAllowedError'))
    this.setState('running')
    return Promise.resolve()
  }
}

function targets(): KeeperTargets & { listeners: () => number; gestures: EventTarget; visibility: EventTarget & { visibilityState: string } } {
  const gestures = new EventTarget()
  const visibility = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  let count = 0
  for (const target of [gestures, visibility]) {
    const add = target.addEventListener.bind(target)
    const remove = target.removeEventListener.bind(target)
    target.addEventListener = (...args: Parameters<EventTarget['addEventListener']>) => {
      count += 1
      add(...args)
    }
    target.removeEventListener = (...args: Parameters<EventTarget['removeEventListener']>) => {
      count -= 1
      remove(...args)
    }
  }
  return { gestures, visibility, listeners: () => count }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('ContextKeeper', () => {
  it('does nothing while the context runs', () => {
    const context = new FakeContext()
    const t = targets()
    const keeper = new ContextKeeper(context as never, t)
    expect(keeper.waiting).toBe(false)
    expect(t.listeners()).toBe(0)
    expect(context.resumeCalls).toBe(0)
  })

  it('resumes at once when the interruption is already over', async () => {
    const context = new FakeContext()
    const t = targets()
    const keeper = new ContextKeeper(context as never, t)
    context.allowResume = true
    context.setState('interrupted')
    await flush()
    expect(context.state).toBe('running')
    expect(keeper.waiting).toBe(false)
    expect(t.listeners()).toBe(0)
  })

  it('after a phone call, waits for the next gesture and resumes then', async () => {
    const context = new FakeContext()
    const t = targets()
    const keeper = new ContextKeeper(context as never, t)
    context.setState('interrupted')
    await flush()
    expect(context.state).toBe('interrupted')
    expect(keeper.waiting).toBe(true)
    expect(t.listeners()).toBeGreaterThan(0)

    // A tap while iOS still refuses: still waiting.
    t.gestures.dispatchEvent(new Event('pointerdown'))
    await flush()
    expect(keeper.waiting).toBe(true)

    // The next tap is allowed.
    context.allowResume = true
    t.gestures.dispatchEvent(new Event('touchend'))
    await flush()
    expect(context.state).toBe('running')
    expect(keeper.waiting).toBe(false)
    expect(t.listeners()).toBe(0)
  })

  it('resumes when the page becomes visible again, not while it is hidden', async () => {
    const context = new FakeContext()
    const t = targets()
    new ContextKeeper(context as never, t)
    context.setState('suspended')
    await flush()
    const calls = context.resumeCalls
    context.allowResume = true
    t.visibility.visibilityState = 'hidden'
    t.visibility.dispatchEvent(new Event('visibilitychange'))
    await flush()
    expect(context.resumeCalls).toBe(calls)
    expect(context.state).toBe('suspended')
    t.visibility.visibilityState = 'visible'
    t.visibility.dispatchEvent(new Event('visibilitychange'))
    await flush()
    expect(context.state).toBe('running')
  })

  it('does not fight a closed context and stops cleanly', async () => {
    const context = new FakeContext()
    const t = targets()
    const keeper = new ContextKeeper(context as never, t)
    context.setState('suspended')
    await flush()
    keeper.stop()
    expect(t.listeners()).toBe(0)
    expect(context.onstatechange).toBeNull()
    const calls = context.resumeCalls
    t.gestures.dispatchEvent(new Event('pointerdown'))
    await flush()
    expect(context.resumeCalls).toBe(calls)

    const other = new FakeContext()
    const t2 = targets()
    new ContextKeeper(other as never, t2)
    other.setState('closed')
    await flush()
    expect(other.resumeCalls).toBe(0)
    expect(t2.listeners()).toBe(0)
  })

  it('reports every state change', async () => {
    const context = new FakeContext()
    const keeper = new ContextKeeper(context as never, targets())
    let changes = 0
    keeper.onChange = () => {
      changes += 1
    }
    context.setState('interrupted')
    context.allowResume = true
    context.setState('suspended')
    await flush()
    expect(context.state).toBe('running')
    expect(changes).toBeGreaterThanOrEqual(3)
  })
})
