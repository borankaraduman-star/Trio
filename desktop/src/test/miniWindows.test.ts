import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { MiniWindowManager, type MiniWindowLike, type OpenAnswer } from "../main/miniWindows";
import type { DisplayLike, MiniState, Rect, SavedMini } from "../shared/mini";

const ORIGIN = "https://trio.example";

class FakeWin extends EventEmitter implements MiniWindowLike {
  bounds: Rect = { x: 0, y: 0, width: 800, height: 600 };
  visible = false;
  destroyed = false;
  calls: string[] = [];
  onTop: { flag: boolean; level?: string } = { flag: false };
  ignore: { ignore: boolean; forward?: boolean } = { ignore: false };
  opacity = 1;
  aspect = 0;
  max = { width: 0, height: 0 };
  protection = false;
  workspaces: unknown[] = [];
  setAlwaysOnTop(flag: boolean, level?: string): void {
    this.onTop = { flag, level };
  }
  setVisibleOnAllWorkspaces(visible: boolean, options?: unknown): void {
    this.workspaces.push([visible, options]);
  }
  setIgnoreMouseEvents(ignore: boolean, options?: { forward?: boolean }): void {
    this.ignore = { ignore, forward: options?.forward };
  }
  setOpacity(o: number): void {
    this.opacity = o;
  }
  setContentProtection(b: boolean): void {
    this.protection = b;
  }
  setAspectRatio(a: number): void {
    this.aspect = a;
  }
  setBounds(b: Partial<Rect>): void {
    this.bounds = { ...this.bounds, ...b };
    this.calls.push("setBounds");
  }
  getBounds(): Rect {
    return { ...this.bounds };
  }
  setMinimumSize(): void {}
  setMaximumSize(w: number, h: number): void {
    this.max = { width: w, height: h };
  }
  setSkipTaskbar(): void {}
  isVisible(): boolean {
    return this.visible;
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  showInactive(): void {
    this.visible = true;
    this.calls.push("showInactive");
    this.emit("show");
  }
  hide(): void {
    this.visible = false;
    this.emit("hide");
  }
  close(): void {
    if (this.destroyed) return;
    this.calls.push("close");
    this.destroyed = true;
    this.emit("closed");
  }
}

const PRIMARY: DisplayLike = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } };

function setup(platform = "win32") {
  let displays: DisplayLike[] = [PRIMARY];
  const saved = new Map<string, SavedMini>();
  const states: MiniState[] = [];
  let changes = 0;
  const timers: Array<() => void> = [];
  let now = 1000;
  const manager = new MiniWindowManager({
    screen: {
      getAllDisplays: () => displays,
      getDisplayMatching: (rect: Rect) =>
        displays.find(
          (d) => rect.x + rect.width / 2 >= d.workArea.x && rect.x + rect.width / 2 < d.workArea.x + d.workArea.width,
        ) ?? (displays[0] as DisplayLike),
    },
    store: { get: (c) => saved.get(c) ?? null, set: (c, s) => saved.set(c, s) },
    preload: "/x/mini-preload.js",
    platform,
    fallbackDisplay: () => displays[0] as DisplayLike,
    onState: (s) => states.push(s),
    onChange: () => changes++,
    now: () => now,
    setTimer: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimer: () => undefined,
  });
  const open = (id: string, origin = ORIGIN, features = "popup"): { answer: OpenAnswer; win: FakeWin; adopted: boolean } => {
    const answer = manager.openRequest({ url: `${ORIGIN}/mini.html?m=${id}`, frameName: `trio-mini-${id}`, features }, origin);
    const win = new FakeWin();
    let adopted = false;
    if (answer.action === "allow") {
      adopted = manager.adopt(win, `trio-mini-${id}`, origin);
      win.emit("ready-to-show");
    }
    return { answer, win, adopted };
  };
  return {
    manager,
    open,
    saved,
    states,
    changes: () => changes,
    runTimers: () => timers.splice(0).forEach((t) => t()),
    setDisplays: (d: DisplayLike[]) => (displays = d),
    advance: (ms: number) => (now += ms),
  };
}

test("an allowed mini window is always on top at the screen-saver level, shown without focus", () => {
  const { open } = setup();
  const { answer, win, adopted } = open("screen-u1");
  assert.equal(answer.action, "allow");
  assert.ok(adopted);
  assert.deepEqual(win.onTop, { flag: true, level: "screen-saver" });
  assert.ok(win.calls.includes("showInactive"));
  assert.ok(win.visible);
  assert.deepEqual(win.max, { width: 1152, height: 624 });
  // Windows: no workspaces call (it does not exist there).
  assert.equal(win.workspaces.length, 0);
});

test("macOS and Linux: visible on all workspaces and over fullscreen spaces", () => {
  for (const platform of ["darwin", "linux"]) {
    const { win } = setup(platform).open("a");
    assert.deepEqual(win.workspaces[0], [true, { visibleOnFullScreen: true, skipTransformProcessType: true }], platform);
  }
});

test("options: opacity clamp, always-on-top off/on, aspect resizes, content protection", () => {
  const { manager, open } = setup();
  const { win } = open("a");
  manager.setOptions("a", { opacity: 0.05 }, ORIGIN);
  assert.equal(win.opacity, 0.4);
  manager.setOptions("a", { alwaysOnTop: false }, ORIGIN);
  assert.deepEqual(win.onTop, { flag: false, level: undefined });
  manager.setOptions("a", { alwaysOnTop: true }, ORIGIN);
  assert.deepEqual(win.onTop, { flag: true, level: "screen-saver" });
  manager.setOptions("a", { aspect: 4 / 3 }, ORIGIN);
  assert.equal(win.aspect, 4 / 3);
  assert.equal(Math.round(win.bounds.width / win.bounds.height * 100), 133);
  manager.setOptions("a", { contentProtection: true }, ORIGIN);
  assert.equal(win.protection, true);
});

test("click-through: ignore with forward; the rescue toggle turns it back off", () => {
  const { manager, open, states } = setup();
  const { win } = open("a");
  manager.setOptions("a", { clickThrough: true }, ORIGIN);
  const ignore = () => ({ ...win.ignore });
  assert.deepEqual(ignore(), { ignore: true, forward: true });
  assert.ok(manager.anyClickThrough);
  assert.equal(states.at(-1)?.clickThrough, true);
  // The hotkey, handled in the main process: back to clickable.
  assert.ok(manager.toggleClickThrough());
  assert.deepEqual(ignore(), { ignore: false, forward: undefined });
  assert.equal(states.at(-1)?.clickThrough, false);
  // And on again.
  assert.ok(manager.toggleClickThrough());
  assert.equal(ignore().ignore, true);
  manager.clearClickThrough();
  assert.equal(ignore().ignore, false);
  // Nothing visible: nothing to toggle.
  win.hide();
  assert.equal(manager.toggleClickThrough(), false);
});

test("ids: only windows this manager made, for the calling origin", () => {
  const { manager, open } = setup();
  const { win } = open("a");
  manager.setOptions("a", { opacity: 0.5 }, "https://other.example");
  manager.setOptions("../a", { opacity: 0.5 }, ORIGIN);
  manager.setOptions("b", { opacity: 0.5 }, ORIGIN);
  manager.hide({ toString: () => "a" }, ORIGIN);
  manager.close("a", null);
  assert.equal(win.opacity, 1);
  assert.ok(win.visible);
  assert.ok(!win.destroyed);
  assert.deepEqual(manager.states("https://other.example"), []);
  manager.hide("a", ORIGIN);
  assert.ok(!win.visible);
  manager.show("a", ORIGIN);
  assert.ok(win.visible);
});

test("a window the manager did not allow is closed, not adopted", () => {
  const { manager } = setup();
  const stray = new FakeWin();
  assert.equal(manager.adopt(stray, "trio-mini-x", ORIGIN), false);
  assert.ok(stray.destroyed);
  // Allowed for one origin, created after the page moved to another.
  manager.openRequest({ url: `${ORIGIN}/mini.html?m=y`, frameName: "trio-mini-y" }, ORIGIN);
  const late = new FakeWin();
  assert.equal(manager.adopt(late, "trio-mini-y", "https://other.example"), false);
  assert.ok(late.destroyed);
});

test("the cap counts windows being created; an abandoned allow stops counting after 10 s", () => {
  const { manager, open, advance } = setup();
  for (const id of ["a", "b", "c", "d"]) {
    assert.equal(manager.openRequest({ url: `${ORIGIN}/mini.html?m=${id}`, frameName: `trio-mini-${id}` }, ORIGIN).action, "allow");
  }
  assert.equal(open("e").answer.action, "deny");
  advance(11_000);
  assert.equal(open("e").answer.action, "allow");
});

test("asking again for an open id shows it instead of opening a second one", () => {
  const { manager, open } = setup();
  const { win } = open("a");
  win.hide();
  assert.equal(manager.openRequest({ url: `${ORIGIN}/mini.html?m=a`, frameName: "trio-mini-a" }, ORIGIN).action, "deny");
  assert.ok(win.visible);
});

test("the first load is let through once, for the allowed URL only", () => {
  const { manager } = setup();
  manager.openRequest({ url: `${ORIGIN}/mini.html?m=a`, frameName: "trio-mini-a" }, ORIGIN);
  assert.equal(manager.takeInitialLoad(`${ORIGIN}/mini.html?m=b`), false);
  assert.equal(manager.takeInitialLoad(`${ORIGIN}/mini.html?m=a`), true);
  assert.equal(manager.takeInitialLoad(`${ORIGIN}/mini.html?m=a`), false);
  // Adopted before its first load: still exactly once.
  manager.openRequest({ url: `${ORIGIN}/mini.html?m=c`, frameName: "trio-mini-c" }, ORIGIN);
  manager.adopt(new FakeWin(), "trio-mini-c", ORIGIN);
  assert.equal(manager.takeInitialLoad(`${ORIGIN}/mini.html?m=c`), true);
  assert.equal(manager.takeInitialLoad(`${ORIGIN}/mini.html?m=c`), false);
});

test("closeAll (main window closed or navigated) closes every window and reports each closed", () => {
  const { manager, open, states } = setup();
  const a = open("a").win;
  const b = open("b").win;
  manager.closeAll();
  assert.ok(a.destroyed && b.destroyed);
  assert.equal(manager.count, 0);
  const closed = states.filter((s) => s.closed);
  assert.deepEqual(closed.map((s) => s.id).sort(), ["a", "b"]);
  // The ids are free again, and the cap with them.
  assert.equal(open("a").answer.action, "allow");
});

test("the opener closing a window cleans up and reports it once", () => {
  const { manager, open, states } = setup();
  const { win } = open("a");
  win.close();
  assert.equal(manager.count, 0);
  assert.equal(states.filter((s) => s.closed).length, 1);
  manager.setOptions("a", { opacity: 0.5 }, ORIGIN); // nothing to address
});

test("bounds: remembered per id class and display, clamped when the display changes", () => {
  const { open, saved, setDisplays } = setup();
  const second: DisplayLike = { id: 2, workArea: { x: 1920, y: 0, width: 1280, height: 984 } };
  setDisplays([PRIMARY, second]);
  const { win } = open("screen-u1");
  win.bounds = { x: 2100, y: 100, width: 480, height: 270 };
  win.emit("moved");
  assert.deepEqual(saved.get("screen"), { bounds: { x: 2100, y: 100, width: 480, height: 270 }, displayId: 2 });
  win.close();
  // Another share of the same class opens where the last one was.
  const again = open("screen-u7").win;
  assert.deepEqual(again.bounds, { x: 2100, y: 100, width: 480, height: 270 });
  again.close();
  // The second display is gone: the main display's corner.
  setDisplays([PRIMARY]);
  const third = open("screen-u9").win;
  assert.ok(third.bounds.x + third.bounds.width <= 1920);
});

test("a drag that ends near a corner snaps; a resize past the cap is pulled back", () => {
  const { open } = setup();
  const { win } = open("a");
  win.bounds = { x: 1920 - 400 - 10, y: 1040 - 225 - 5, width: 400, height: 225 };
  win.emit("moved");
  assert.deepEqual(win.bounds, { x: 1920 - 400 - 8, y: 1040 - 225 - 8, width: 400, height: 225 });
  win.bounds = { x: 0, y: 0, width: 1900, height: 1000 }; // a page's resizeTo, say
  win.emit("resize");
  assert.ok(win.bounds.width <= 1152 && win.bounds.height <= 624);
});

test("Windows: a move mid-drag does not jump; off-screen it is pulled back. Linux: the settled move snaps", () => {
  const w = setup("win32");
  const a = w.open("a").win;
  a.bounds = { x: 500, y: 500, width: 400, height: 225 };
  a.calls = [];
  a.emit("move");
  w.runTimers();
  assert.ok(!a.calls.includes("setBounds"));
  a.bounds = { x: -3000, y: -3000, width: 400, height: 225 };
  a.emit("move");
  w.runTimers();
  assert.deepEqual([a.bounds.x, a.bounds.y], [0, 0]);
  const l = setup("linux");
  const b = l.open("b").win;
  b.bounds = { x: 5, y: 300, width: 400, height: 225 };
  b.emit("move");
  l.runTimers();
  assert.equal(b.bounds.x, 8);
});

test("display changes re-clamp every window", () => {
  const { manager, open, setDisplays } = setup();
  const { win } = open("a");
  win.bounds = { x: 1500, y: 800, width: 400, height: 225 };
  setDisplays([{ id: 1, workArea: { x: 0, y: 0, width: 1280, height: 720 } }]);
  manager.reclampAll();
  assert.ok(win.bounds.x + win.bounds.width <= 1280 && win.bounds.y + win.bounds.height <= 720);
  assert.deepEqual(win.max, { width: 768, height: 432 });
});

test("tray: show/hide all, and the counts the tray reads", () => {
  const { manager, open } = setup();
  const a = open("a").win;
  const b = open("b").win;
  assert.ok(manager.anyVisible);
  manager.toggleAllVisible();
  assert.ok(!a.visible && !b.visible);
  manager.toggleAllVisible();
  assert.ok(a.visible && b.visible);
  assert.equal(manager.count, 2);
});
