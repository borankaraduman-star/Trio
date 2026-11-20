/**
 * CONTRACT-V11-ACTIVITY helpers: a fake desktop app with the V5 game bridge
 * and the V11 listening bridge (what desktop/'s preload exposes), driven by
 * the test the way the main process would; and a raw socket that sets an
 * activity for an account no browser looks at (fifteen people).
 */
import type { BrowserContext, Page } from '@playwright/test'
import { baseUrl } from './server'

export interface FakeDesktopOptions {
  /** Answer the first-run notice before the page loads (most tests). */
  acked?: boolean
  /** A 0.9.x app: the V8 music members, no V11 listening bridge. */
  oldApp?: boolean
  /** macOS/Linux shell: the bridge says it cannot read anything. */
  unsupported?: boolean
}

/**
 * The fake main process filters like the real one (desktop/src/shared/listening.ts,
 * unit-tested there): an app named like a browser is shown only with the
 * page's `browsers` wish on. The test pushes "sessions" as `{title, artist, app}`.
 */
export async function fakeDesktop(context: BrowserContext, options: FakeDesktopOptions = {}): Promise<void> {
  await context.addInitScript((opts: FakeDesktopOptions) => {
    if (opts.acked) localStorage.setItem('trio.v11.listenAck', '1')
    type Song = { title: string; artist?: string; app?: string }
    type State = { playing: Song | null; health: string; message?: string; lastApp?: { name: string; shown: boolean } }
    const w = window as unknown as {
      trioDesktop: unknown
      __game: { cb: ((s: unknown) => void) | null; last: unknown }
      __listen: {
        cbs: Set<(s: State) => void>
        wish: { on: boolean; browsers: boolean }
        wishes: { on: boolean; browsers: boolean }[]
        playing: Song | null
        state: State
        emit: () => void
      }
    }
    w.__game = { cb: null, last: undefined }
    const browserish = (app?: string) => /chrome|edge|firefox|opera|brave/i.test(app ?? '')
    const listen = {
      cbs: new Set<(s: State) => void>(),
      wish: { on: false, browsers: false },
      wishes: [] as { on: boolean; browsers: boolean }[],
      playing: null as Song | null,
      state: { playing: null, health: 'off' } as State,
      emit() {
        let state: State
        if (opts.unsupported) state = { playing: null, health: 'unsupported', message: 'Bu sistemde otomatik algılanamıyor.' }
        else if (!this.wish.on) state = { playing: null, health: 'off' }
        else {
          const p = this.playing
          const shown = p !== null && (!browserish(p.app) || this.wish.browsers)
          state = { playing: shown ? p : null, health: 'ok', ...(p ? { lastApp: { name: p.app ?? '?', shown } } : {}) }
        }
        if (JSON.stringify(state) === JSON.stringify(this.state)) return
        this.state = state
        for (const cb of this.cbs) cb(state)
      },
    }
    w.__listen = listen
    const bridge: Record<string, unknown> = {
      isDesktop: true,
      setPttKey: () => undefined,
      onPtt: () => () => undefined,
      gameStatus: { supported: true },
      onGameStatus(cb: (s: unknown) => void) {
        w.__game.cb = cb
        // The main process answers a subscription with the current status (null when none).
        setTimeout(() => cb(w.__game.last ?? null), 0)
        return () => {
          if (w.__game.cb === cb) w.__game.cb = null
        }
      },
      // V8 (a 0.9.x app has these too).
      setNowPlayingWatch: () => undefined,
      onNowPlaying: () => () => undefined,
    }
    if (!opts.oldApp) {
      bridge.listeningStatus = { supported: !opts.unsupported }
      bridge.setListeningStatus = (wish: { on: boolean; browsers: boolean }) => {
        listen.wish = { on: wish.on === true, browsers: wish.browsers === true }
        listen.wishes.push(listen.wish)
        listen.emit()
      }
      bridge.onListening = (cb: (s: State) => void) => {
        listen.cbs.add(cb)
        setTimeout(() => cb(listen.state), 0)
        return () => listen.cbs.delete(cb)
      }
    }
    w.trioDesktop = bridge
  }, options)
}

/** What the desktop's media session says is playing now (null: nothing). */
export async function play(page: Page, song: { title: string; artist?: string; app?: string } | null): Promise<void> {
  await page.evaluate((s) => {
    const l = (window as unknown as { __listen: { playing: unknown; emit: () => void } }).__listen
    l.playing = s
    l.emit()
  }, song)
}

export async function pushGame(page: Page, status: unknown): Promise<void> {
  await page.evaluate((s) => {
    const g = (window as unknown as { __game: { cb: ((s: unknown) => void) | null; last: unknown } }).__game
    g.last = s
    g.cb?.(s)
  }, status)
}

export async function wishes(page: Page): Promise<{ on: boolean; browsers: boolean }[]> {
  return page.evaluate(() => (window as unknown as { __listen: { wishes: { on: boolean; browsers: boolean }[] } }).__listen.wishes)
}

export function wow(zone: string, level = 37) {
  return {
    game: 'WoW Forever',
    since: Math.floor(Date.now() / 1000) - 80 * 60,
    detail: { character: 'Kahve Kokusu', realm: '', level, class: 'ROGUE', zone, subzone: '', source: 'log' },
  }
}

export const SONG = { title: 'Bir Derdim Var', artist: 'mor ve ötesi', app: 'Spotify' }

/** A socket of `token`'s own that sets an activity and stays open (the account is online). */
export async function activitySocket(token: string, frame: Record<string, unknown>): Promise<() => void> {
  const ws = new WebSocket(`${baseUrl().replace('http', 'ws')}/ws?token=${encodeURIComponent(token)}`)
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('message', () => resolve(), { once: true })
    ws.addEventListener('error', () => reject(new Error('socket')), { once: true })
  })
  ws.send(JSON.stringify({ type: 'activity.set', ...frame }))
  return () => ws.close()
}
