/**
 * CONTRACT-V12-MINI-DESKTOP: the mini player windows the server page opens
 * with `window.open('/mini.html?m=<id>', 'trio-mini-<id>')`. No Electron
 * import: the windows, the screen and the store are injected, so every rule is
 * unit-tested with fakes (`test/miniWindows.test.ts`).
 *
 * The manager owns the decision (`openRequest`, called from the main window's
 * setWindowOpenHandler), the window once Electron has made it (`adopt`, from
 * `did-create-window`), and every later change the page asks for by id. An id
 * addresses only a window this manager created for the page's origin.
 */
import {
  checkMiniOpen,
  clampToWorkArea,
  idClass,
  isMiniId,
  maxMiniSize,
  MINI_MIN,
  miniIdFromName,
  miniWindowOptions,
  normalizeMiniOptions,
  placeMini,
  snapToEdges,
  type DisplayLike,
  type MiniState,
  type Rect,
  type SavedMini,
} from "../shared/mini";

type Listener = (...args: unknown[]) => void;

/** The part of Electron's BrowserWindow the manager uses. */
export interface MiniWindowLike {
  setAlwaysOnTop(flag: boolean, level?: "screen-saver" | "floating" | "normal"): void;
  setVisibleOnAllWorkspaces(visible: boolean, options?: { visibleOnFullScreen?: boolean; skipTransformProcessType?: boolean }): void;
  setIgnoreMouseEvents(ignore: boolean, options?: { forward?: boolean }): void;
  setOpacity(opacity: number): void;
  setContentProtection(enable: boolean): void;
  setAspectRatio(aspectRatio: number): void;
  setBounds(bounds: Partial<Rect>): void;
  getBounds(): Rect;
  setMinimumSize(width: number, height: number): void;
  setMaximumSize(width: number, height: number): void;
  setSkipTaskbar(skip: boolean): void;
  isVisible(): boolean;
  isDestroyed(): boolean;
  showInactive(): void;
  hide(): void;
  close(): void;
  on(event: string, listener: Listener): unknown;
  once(event: string, listener: Listener): unknown;
}

export interface ScreenLike {
  getAllDisplays(): DisplayLike[];
  getDisplayMatching(rect: Rect): DisplayLike;
}

export interface MiniBoundsStoreLike {
  get(cls: string): SavedMini | null;
  set(cls: string, saved: SavedMini): void;
}

export interface MiniManagerDeps {
  screen: ScreenLike;
  store: MiniBoundsStoreLike;
  /** The mini page's preload (exposes no IPC). */
  preload: string;
  platform: NodeJS.Platform | string;
  /** The display the main window is on (where a new mini window opens). */
  fallbackDisplay(): DisplayLike;
  onState(state: MiniState): void;
  /** Something the tray shows changed (a window came or went, visibility, click-through). */
  onChange(): void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface Entry {
  id: string;
  origin: string;
  win: MiniWindowLike;
  clickThrough: boolean;
  alwaysOnTop: boolean;
  aspect: number;
  moveTimer: unknown;
  closed: boolean;
  /** The URL the window was allowed to load, until its first navigation has used it. */
  initialUrl: string | null;
  /** The last bounds reported (a closed window has none to ask). */
  lastBounds: Rect;
}

interface Pending {
  origin: string;
  url: string;
  bounds: Rect;
  displayId: number;
  focusable: boolean;
  at: number;
}

/** An allowed open that never became a window stops counting after this. */
const PENDING_TTL_MS = 10_000;
/** `move` events (Linux has no `moved`; a page's moveTo has none either) settle after this. */
const MOVE_SETTLE_MS = 500;
const DEFAULT_ASPECT = 16 / 9;

export type OpenAnswer =
  | { action: "deny" }
  | { action: "allow"; overrideBrowserWindowOptions: Record<string, unknown> };

export class MiniWindowManager {
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Map<string, Pending>();
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly deps: MiniManagerDeps) {
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  /**
   * The main window's setWindowOpenHandler, for a request that is a mini
   * player (`isMiniRequest`). Anything not exactly a mini window is denied.
   */
  openRequest(details: { url: string; frameName: string; features?: string }, serverOrigin: string | null): OpenAnswer {
    this.expirePending();
    const ids = new Set<string>([...this.entries.keys(), ...this.pending.keys()]);
    const check = checkMiniOpen(details, serverOrigin, ids);
    if (!check.ok || !serverOrigin) {
      if (!check.ok && check.reason === "open") {
        // Asked again for one that is open: show it (without focus) instead.
        const entry = this.entries.get(miniIdFromName(details.frameName) ?? "");
        if (entry && !entry.win.isDestroyed()) entry.win.showInactive();
      }
      return { action: "deny" };
    }
    const fallback = this.deps.fallbackDisplay();
    const others = [...this.entries.values()].filter((e) => !e.win.isDestroyed()).map((e) => e.win.getBounds());
    const place = placeMini(this.deps.store.get(idClass(check.id)), this.deps.screen.getAllDisplays(), fallback, check.size, others);
    const display = this.deps.screen.getAllDisplays().find((d) => d.id === place.displayId) ?? fallback;
    this.pending.set(check.id, {
      origin: serverOrigin,
      url: details.url,
      bounds: place.bounds,
      displayId: place.displayId,
      focusable: check.focusable,
      at: this.now(),
    });
    return {
      action: "allow",
      overrideBrowserWindowOptions: miniWindowOptions({
        bounds: place.bounds,
        max: maxMiniSize(display.workArea),
        focusable: check.focusable,
        preload: this.deps.preload,
        macOS: this.deps.platform === "darwin",
      }),
    };
  }

  /**
   * `did-create-window` on the main window: take over a window this manager
   * allowed. Returns false (and closes it) for a window it did not allow.
   */
  adopt(win: MiniWindowLike, frameName: string, serverOrigin: string | null): boolean {
    const id = miniIdFromName(frameName);
    const pending = id !== null ? this.pending.get(id) : undefined;
    if (id === null || !pending || pending.origin !== serverOrigin || this.entries.has(id)) {
      try {
        win.close();
      } catch {
        /* already gone */
      }
      return false;
    }
    this.pending.delete(id);
    const entry: Entry = {
      id,
      origin: pending.origin,
      win,
      clickThrough: false,
      alwaysOnTop: true,
      aspect: aspectOf(pending.bounds),
      moveTimer: null,
      closed: false,
      initialUrl: pending.url || null,
      lastBounds: pending.bounds,
    };
    this.entries.set(id, entry);
    // Applied again after creation: the features string may have set other values.
    const display = this.displayFor(pending.bounds);
    const max = maxMiniSize(display.workArea);
    win.setMinimumSize(MINI_MIN.width, MINI_MIN.height);
    win.setMaximumSize(max.width, max.height);
    win.setBounds(clampToWorkArea(pending.bounds, display.workArea));
    win.setAspectRatio(entry.aspect);
    win.setOpacity(1);
    win.setSkipTaskbar(true);
    win.setIgnoreMouseEvents(false);
    win.setContentProtection(false);
    this.applyOnTop(entry);
    win.once("ready-to-show", () => {
      if (!entry.closed && !win.isDestroyed()) win.showInactive();
    });
    win.on("show", () => this.changed(entry));
    win.on("hide", () => this.changed(entry));
    win.on("moved", () => this.settle(entry, true));
    win.on("move", () => this.moveSoon(entry));
    win.on("resize", () => this.enforceMax(entry));
    win.on("resized", () => this.settle(entry, false));
    win.on("closed", () => this.forget(entry));
    this.deps.onChange();
    return true;
  }

  /**
   * Electron reports a child window's FIRST load as a navigation, which the
   * app's guard refuses for every window but the main one. This allows exactly
   * one: the URL a mini window was allowed to open, once, into a window that
   * has loaded nothing yet (the caller checks that).
   */
  takeInitialLoad(url: string): boolean {
    for (const entry of this.entries.values()) {
      if (!entry.closed && entry.initialUrl !== null && entry.initialUrl === url) {
        entry.initialUrl = null;
        return true;
      }
    }
    for (const [id, p] of this.pending) {
      if (p.url === url && !this.entries.has(id)) {
        p.url = "";
        return true;
      }
    }
    return false;
  }

  /** The page's `setOptions(id, …)`; unknown ids and other origins do nothing. */
  setOptions(id: unknown, raw: unknown, origin: string | null): void {
    const entry = this.lookup(id, origin);
    if (!entry) return;
    const options = normalizeMiniOptions(raw);
    const { win } = entry;
    if (options.opacity !== undefined) win.setOpacity(options.opacity);
    if (options.contentProtection !== undefined) win.setContentProtection(options.contentProtection);
    if (options.alwaysOnTop !== undefined) {
      entry.alwaysOnTop = options.alwaysOnTop;
      this.applyOnTop(entry);
    }
    if (options.aspect !== undefined) this.applyAspect(entry, options.aspect);
    if (options.clickThrough !== undefined) this.applyClickThrough(entry, options.clickThrough);
    this.changed(entry);
  }

  show(id: unknown, origin: string | null): void {
    const entry = this.lookup(id, origin);
    if (entry) entry.win.showInactive();
  }

  hide(id: unknown, origin: string | null): void {
    const entry = this.lookup(id, origin);
    if (entry) entry.win.hide();
  }

  close(id: unknown, origin: string | null): void {
    const entry = this.lookup(id, origin);
    if (entry) entry.win.close();
  }

  /** The main window closed or left the page: every mini window goes with it. */
  closeAll(): void {
    this.pending.clear();
    for (const entry of [...this.entries.values()]) {
      try {
        if (!entry.win.isDestroyed()) entry.win.close();
      } catch {
        /* already gone */
      }
      this.forget(entry);
    }
  }

  /**
   * The click-through RESCUE: a click-through window cannot be clicked, so the
   * hotkey (and the tray) toggles it here. Any visible window click-through →
   * all back to clickable; otherwise every visible one becomes click-through.
   * Returns whether anything changed.
   */
  toggleClickThrough(): boolean {
    const visible = this.live().filter((e) => e.win.isVisible());
    if (visible.length === 0) return false;
    const next = !visible.some((e) => e.clickThrough);
    for (const entry of visible) {
      this.applyClickThrough(entry, next);
      this.changed(entry);
    }
    return true;
  }

  /** Every window clickable again (the tray's rescue item). */
  clearClickThrough(): void {
    for (const entry of this.live()) {
      if (!entry.clickThrough) continue;
      this.applyClickThrough(entry, false);
      this.changed(entry);
    }
  }

  /** The tray's "show/hide": hide all when any is visible, else show all. */
  toggleAllVisible(): void {
    const live = this.live();
    const anyVisible = live.some((e) => e.win.isVisible());
    for (const entry of live) {
      if (anyVisible) entry.win.hide();
      else entry.win.showInactive();
    }
  }

  /** Displays changed: every window back inside a work area, under the size cap. */
  reclampAll(): void {
    for (const entry of this.live()) this.settle(entry, false);
  }

  states(origin: string | null): MiniState[] {
    return this.live()
      .filter((e) => e.origin === origin)
      .map((e) => this.stateOf(e));
  }

  get count(): number {
    return this.live().length;
  }

  get anyVisible(): boolean {
    return this.live().some((e) => e.win.isVisible());
  }

  get anyClickThrough(): boolean {
    return this.live().some((e) => e.clickThrough);
  }

  // ------------------------------------------------------------- internals

  private live(): Entry[] {
    return [...this.entries.values()].filter((e) => !e.closed && !e.win.isDestroyed());
  }

  private lookup(id: unknown, origin: string | null): Entry | null {
    if (!isMiniId(id) || origin === null) return null;
    const entry = this.entries.get(id);
    if (!entry || entry.closed || entry.origin !== origin || entry.win.isDestroyed()) return null;
    return entry;
  }

  private expirePending(): void {
    const now = this.now();
    for (const [id, p] of this.pending) if (now - p.at > PENDING_TTL_MS) this.pending.delete(id);
  }

  private displayFor(bounds: Rect): DisplayLike {
    try {
      return this.deps.screen.getDisplayMatching(bounds);
    } catch {
      return this.deps.fallbackDisplay();
    }
  }

  private applyOnTop(entry: Entry): void {
    const { win } = entry;
    if (entry.alwaysOnTop) {
      // The level that stays above borderless-fullscreen games (and the macOS menu bar/dock).
      win.setAlwaysOnTop(true, "screen-saver");
      if (this.deps.platform === "darwin" || this.deps.platform === "linux") {
        try {
          win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
        } catch {
          /* not supported by this window manager */
        }
      }
    } else {
      win.setAlwaysOnTop(false);
      if (this.deps.platform === "darwin" || this.deps.platform === "linux") {
        try {
          win.setVisibleOnAllWorkspaces(false, { skipTransformProcessType: true });
        } catch {
          /* not supported */
        }
      }
    }
  }

  private applyClickThrough(entry: Entry, on: boolean): void {
    entry.clickThrough = on;
    if (on) entry.win.setIgnoreMouseEvents(true, { forward: true });
    else entry.win.setIgnoreMouseEvents(false);
    this.deps.onChange();
  }

  /** Lock a new aspect ratio and bring the window to it (keeping its width when it fits). */
  private applyAspect(entry: Entry, aspect: number): void {
    entry.aspect = aspect;
    entry.win.setAspectRatio(aspect);
    if (aspect === 0) return;
    const b = entry.win.getBounds();
    const wa = this.displayFor(b).workArea;
    const max = maxMiniSize(wa);
    let width = b.width;
    let height = Math.round(width / aspect);
    if (height > max.height) {
      height = max.height;
      width = Math.round(height * aspect);
    }
    if (height < MINI_MIN.height) {
      height = MINI_MIN.height;
      width = Math.round(height * aspect);
    }
    // Grow towards the corner it is in, so a window snapped bottom-right stays there.
    const right = b.x + b.width;
    const bottom = b.y + b.height;
    const inRight = b.x + b.width / 2 > wa.x + wa.width / 2;
    const inBottom = b.y + b.height / 2 > wa.y + wa.height / 2;
    const next = clampToWorkArea(
      { x: inRight ? right - width : b.x, y: inBottom ? bottom - height : b.y, width, height },
      wa,
    );
    entry.win.setBounds(next);
  }

  private moveSoon(entry: Entry): void {
    if (entry.moveTimer !== null) this.clearTimer(entry.moveTimer);
    entry.moveTimer = this.setTimer(() => {
      entry.moveTimer = null;
      // Windows/macOS report the end of a drag as `moved` (which snaps); this
      // path only catches Linux drags and a page's moveTo off the screen.
      this.settle(entry, this.deps.platform === "linux", this.deps.platform !== "linux");
    }, MOVE_SETTLE_MS);
  }

  private enforceMax(entry: Entry): void {
    if (entry.closed || entry.win.isDestroyed()) return;
    const b = entry.win.getBounds();
    const max = maxMiniSize(this.displayFor(b).workArea);
    if (b.width > max.width || b.height > max.height) this.settle(entry, false);
  }

  /**
   * After a move or resize: inside the work area and under the cap, snapped to
   * an edge when `snap`; remembered. `outsideOnly` leaves a window that is
   * already inside alone (a `move` mid-drag on Windows/macOS must not jump).
   */
  private settle(entry: Entry, snap: boolean, outsideOnly = false): void {
    if (entry.closed || entry.win.isDestroyed()) return;
    const b = entry.win.getBounds();
    const display = this.displayFor(b);
    const wa = display.workArea;
    const max = maxMiniSize(wa);
    entry.win.setMaximumSize(max.width, max.height);
    const inside = b.x >= wa.x && b.y >= wa.y && b.x + b.width <= wa.x + wa.width && b.y + b.height <= wa.y + wa.height;
    const tooBig = b.width > max.width || b.height > max.height;
    let next = b;
    if (!outsideOnly || !inside || tooBig) {
      next = clampToWorkArea(b, wa);
      if (snap) next = snapToEdges(next, wa);
    }
    if (next.x !== b.x || next.y !== b.y || next.width !== b.width || next.height !== b.height) entry.win.setBounds(next);
    this.deps.store.set(idClass(entry.id), { bounds: next, displayId: display.id });
    this.changed(entry);
  }

  private forget(entry: Entry): void {
    if (entry.closed) return;
    entry.closed = true;
    if (entry.moveTimer !== null) this.clearTimer(entry.moveTimer);
    if (this.entries.get(entry.id) === entry) this.entries.delete(entry.id);
    this.deps.onState({ id: entry.id, visible: false, clickThrough: false, bounds: entry.lastBounds, closed: true });
    this.deps.onChange();
  }

  private stateOf(entry: Entry): MiniState {
    entry.lastBounds = entry.win.getBounds();
    return { id: entry.id, visible: entry.win.isVisible(), clickThrough: entry.clickThrough, bounds: entry.lastBounds };
  }

  private changed(entry: Entry): void {
    if (entry.closed || entry.win.isDestroyed()) return;
    this.deps.onState(this.stateOf(entry));
    this.deps.onChange();
  }
}

function aspectOf(b: Rect): number {
  const a = b.height > 0 ? b.width / b.height : DEFAULT_ASPECT;
  return Number.isFinite(a) && a >= 0.2 && a <= 5 ? a : DEFAULT_ASPECT;
}
