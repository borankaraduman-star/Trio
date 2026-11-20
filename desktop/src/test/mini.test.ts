import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkMiniOpen,
  clampOpacity,
  clampToWorkArea,
  idClass,
  maxMiniSize,
  MAX_MINI_WINDOWS,
  MINI_MARGIN,
  miniWindowOptions,
  normalizeMiniOptions,
  parseFeatures,
  placeMini,
  snapToEdges,
} from "../shared/mini";

const ORIGIN = "https://trio.example";
const ok = (url: string, name: string, open: string[] = [], features = "popup") =>
  checkMiniOpen({ url, frameName: name, features }, ORIGIN, new Set(open));

test("the window-open rule accepts exactly the mini route, name and origin", () => {
  const r = ok(`${ORIGIN}/mini.html?m=screen-u1`, "trio-mini-screen-u1");
  assert.deepEqual(r, { ok: true, id: "screen-u1", size: null, focusable: true });
  // Not a mini at all: left to the ordinary rules (external links, deny).
  assert.deepEqual(ok("https://example.com/page", ""), { ok: false, reason: "not-mini" });
  // Looks like one, is not exactly one.
  for (const [url, name] of [
    [`${ORIGIN}/mini.html?m=a`, "other"],
    [`${ORIGIN}/other.html?m=a`, "trio-mini-a"],
    [`${ORIGIN}/mini.html?m=b`, "trio-mini-a"],
    [`${ORIGIN}/mini.html?m=a&x=1`, "trio-mini-a"],
    [`${ORIGIN}/mini.html`, "trio-mini-a"],
    [`${ORIGIN}/mini.html?m=a#x`, "trio-mini-a"],
    [`${ORIGIN}/mini.html?m=a`, "trio-mini-a/b"],
    [`${ORIGIN}/mini.html?m=${"a".repeat(65)}`, `trio-mini-${"a".repeat(65)}`],
  ]) {
    const result = ok(url as string, name as string);
    assert.equal(result.ok, false, `${url} ${name}`);
    assert.notEqual(result.ok === false && result.reason, "not-mini", `${url} is handled by the mini rules`);
  }
  for (const url of ["https://evil.example/mini.html?m=a", "http://trio.example/mini.html?m=a", "https://trio.example:444/mini.html?m=a", "file:///mini.html?m=a"]) {
    assert.deepEqual(ok(url, "trio-mini-a"), { ok: false, reason: "origin" }, url);
  }
  assert.deepEqual(checkMiniOpen({ url: `${ORIGIN}/mini.html?m=a`, frameName: "trio-mini-a" }, null, new Set()), { ok: false, reason: "origin" });
});

test("at most four mini windows, and an open id is not opened twice", () => {
  const open = ["a", "b", "c"];
  assert.equal(ok(`${ORIGIN}/mini.html?m=d`, "trio-mini-d", open).ok, true);
  assert.deepEqual(ok(`${ORIGIN}/mini.html?m=e`, "trio-mini-e", [...open, "d"]), { ok: false, reason: "limit" });
  assert.equal(MAX_MINI_WINDOWS, 4);
  assert.deepEqual(ok(`${ORIGIN}/mini.html?m=a`, "trio-mini-a", open), { ok: false, reason: "open" });
});

test("features: only a first size and focusable=no are read", () => {
  assert.deepEqual(parseFeatures("popup,width=480,height=270"), { size: { width: 480, height: 270 }, focusable: true });
  assert.deepEqual(parseFeatures("popup, Focusable = NO"), { size: null, focusable: false });
  assert.deepEqual(parseFeatures("width=-5,height=1e9"), { size: null, focusable: true });
  assert.deepEqual(parseFeatures("width=400"), { size: null, focusable: true });
});

test("every option a hostile features string could set is overridden", () => {
  // What Electron 45 passed through from a window.open features string (measured under xvfb).
  const passedThrough = [
    "show", "width", "height", "x", "y", "alwaysOnTop", "frame", "transparent", "movable", "focusable",
    "skipTaskbar", "opacity", "titleBarStyle", "minWidth", "maxWidth", "enableLargerThanScreen",
    "backgroundColor", "hasShadow", "thickFrame", "modal", "center",
  ];
  const options = miniWindowOptions({
    bounds: { x: 10, y: 20, width: 400, height: 225 },
    max: { width: 1152, height: 648 },
    focusable: true,
    preload: "/p/mini-preload.js",
    macOS: false,
  });
  for (const key of passedThrough) assert.ok(key in options, `${key} is set by the shell`);
  assert.equal(options.transparent, false);
  assert.equal(options.modal, false);
  assert.equal(options.enableLargerThanScreen, false);
  assert.equal(options.opacity, 1);
  assert.equal(options.fullscreen, false);
  assert.equal(options.fullscreenable, false);
  assert.equal(options.kiosk, false);
  assert.equal(options.frame, false);
  assert.equal(options.alwaysOnTop, true);
  assert.equal(options.skipTaskbar, true);
  assert.equal(options.show, false);
  assert.equal(options.maxWidth, 1152);
  const prefs = options.webPreferences as Record<string, unknown>;
  assert.equal(prefs.preload, "/p/mini-preload.js");
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.webSecurity, true);
  assert.equal(prefs.webviewTag, false);
  assert.equal(prefs.zoomFactor, 1);
  assert.equal("type" in options, false);
  assert.equal(miniWindowOptions({ bounds: { x: 0, y: 0, width: 1, height: 1 }, max: { width: 1, height: 1 }, focusable: false, preload: "", macOS: true }).type, "panel");
});

test("opacity is clamped to 0.4–1; options from the page are filtered", () => {
  assert.equal(clampOpacity(0.1), 0.4);
  assert.equal(clampOpacity(2), 1);
  assert.equal(clampOpacity(0.7), 0.7);
  assert.equal(clampOpacity(Number.NaN), 1);
  assert.deepEqual(normalizeMiniOptions({ opacity: 0, clickThrough: true, alwaysOnTop: false, aspect: 16 / 9, contentProtection: true, x: 1 }), {
    opacity: 0.4,
    clickThrough: true,
    alwaysOnTop: false,
    aspect: 16 / 9,
    contentProtection: true,
  });
  assert.deepEqual(normalizeMiniOptions({ opacity: "1", clickThrough: 1, aspect: 99 }), {});
  assert.deepEqual(normalizeMiniOptions({ aspect: 0 }), { aspect: 0 });
  assert.deepEqual(normalizeMiniOptions(null), {});
});

const WA = { x: 0, y: 0, width: 1920, height: 1040 };

test("size cap: never more than 60 % of the work area, never off it", () => {
  assert.deepEqual(maxMiniSize(WA), { width: 1152, height: 624 });
  assert.deepEqual(clampToWorkArea({ x: -5000, y: -5000, width: 9000, height: 9000 }, WA), { x: 0, y: 0, width: 1152, height: 624 });
  assert.deepEqual(clampToWorkArea({ x: 1900, y: 1000, width: 400, height: 225 }, WA), { x: 1520, y: 815, width: 400, height: 225 });
  assert.deepEqual(clampToWorkArea({ x: 10, y: 10, width: 10, height: 10 }, WA), { x: 10, y: 10, width: 160, height: 90 });
  // A second display left of the primary (negative coordinates).
  const left = { x: -1280, y: 0, width: 1280, height: 984 };
  assert.deepEqual(clampToWorkArea({ x: -100, y: 0, width: 400, height: 225 }, left), { x: -400, y: 0, width: 400, height: 225 });
});

test("snapping: near an edge or a corner, to the margin; elsewhere untouched", () => {
  const near = snapToEdges({ x: 1920 - 400 - 15, y: 1040 - 225 - 3, width: 400, height: 225 }, WA);
  assert.deepEqual(near, { x: 1920 - 400 - MINI_MARGIN, y: 1040 - 225 - MINI_MARGIN, width: 400, height: 225 });
  assert.deepEqual(snapToEdges({ x: 20, y: 300, width: 400, height: 225 }, WA), { x: MINI_MARGIN, y: 300, width: 400, height: 225 });
  assert.deepEqual(snapToEdges({ x: 600, y: 300, width: 400, height: 225 }, WA), { x: 600, y: 300, width: 400, height: 225 });
});

test("placement: remembered place on its display, clamped; gone display → bottom-right of the main one", () => {
  const primary = { id: 1, workArea: WA };
  const second = { id: 2, workArea: { x: 1920, y: 0, width: 1280, height: 984 } };
  const saved = { bounds: { x: 2000, y: 100, width: 480, height: 270 }, displayId: 2 };
  assert.deepEqual(placeMini(saved, [primary, second], primary, null), { bounds: saved.bounds, displayId: 2 });
  // The second display was unplugged: the main window's display, default corner.
  const gone = placeMini(saved, [primary], primary, null);
  assert.equal(gone.displayId, 1);
  assert.deepEqual(gone.bounds, { x: 1920 - 400 - MINI_MARGIN, y: 1040 - 225 - MINI_MARGIN, width: 400, height: 225 });
  // The display came back smaller (resolution change): clamped into it.
  const smaller = { id: 2, workArea: { x: 1920, y: 0, width: 800, height: 600 } };
  const clamped = placeMini({ bounds: { x: 2900, y: 500, width: 700, height: 400 }, displayId: 2 }, [primary, smaller], primary, null).bounds;
  assert.deepEqual(clamped, { x: 1920 + 800 - 480, y: 600 - 360, width: 480, height: 360 });
  // A page's huge first size is capped.
  assert.deepEqual(placeMini(null, [primary], primary, { width: 5000, height: 5000 }).bounds.width, 1152);
  // A second window does not land on the first.
  const first = placeMini(null, [primary], primary, null).bounds;
  const next = placeMini(null, [primary], primary, null, [first]).bounds;
  assert.ok(next.y + next.height <= first.y, "stacked above");
});

test("id class: the id up to its first separator", () => {
  assert.equal(idClass("screen-u12"), "screen");
  assert.equal(idClass("camera_7"), "camera");
  assert.equal(idClass("solo"), "solo");
});
