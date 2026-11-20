import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PttController, type KeyHook } from "../main/ptt";
import { parseWatchKey, watchConflicts, WATCH_REASONS, type WatchAction } from "../shared/watchHotkeys";

class FakeHook extends EventEmitter {
  started = 0;
  stopped = 0;
  start(): void {
    this.started++;
  }
  stop(): void {
    this.stopped++;
  }
}

const quiet = { warn: () => undefined, info: () => undefined };

function setup() {
  const hook = new FakeHook();
  const watch: WatchAction[] = [];
  const hotkeys: string[] = [];
  const states: boolean[] = [];
  const ptt = new PttController(
    (d) => states.push(d),
    () => hook as unknown as KeyHook,
    quiet,
    (a) => hotkeys.push(a),
    (a) => watch.push(a),
  );
  return { hook, ptt, watch, hotkeys, states };
}

// libuiohook: F9 67, F10 68, KeyM 50, KeyV 47, KeyN 49.

test("parse: plain codes, chords in the page shortcut format, mouse buttons without modifiers", () => {
  assert.deepEqual(parseWatchKey("F9"), { binding: { kind: "key", keycode: 67 }, mods: { ctrl: false, alt: false, shift: false, meta: false } });
  assert.deepEqual(parseWatchKey("Alt+Ctrl+KeyM")?.mods, { ctrl: true, alt: true, shift: false, meta: false });
  assert.equal(parseWatchKey("MouseBack")?.binding.kind, "mouse");
  for (const bad of ["Ctrl+MouseBack", "Ctrl+ShiftLeft", "Hyper+KeyM", "Ctrl+Ctrl+KeyM", "Bogus", "", 7, "Ctrl+"]) {
    assert.equal(parseWatchKey(bad), null, String(bad));
  }
});

test("conflicts: the PTT, mute and deafen keys are refused (chord or not); duplicates go to the first", () => {
  const refused = watchConflicts(
    {
      toggleMini: "KeyV",
      nextShare: "Ctrl+Alt+F9",
      clickThrough: "F10",
      muteShare: "Ctrl+Alt+KeyM",
      shareVolumeUp: "Ctrl+Alt+KeyM",
      shareVolumeDown: "Bogus",
      theatre: "Ctrl+Alt+KeyT",
    },
    { ptt: "KeyV", mute: "F9", deafen: "F10" },
  );
  assert.deepEqual(refused, {
    toggleMini: "ptt",
    nextShare: "mute",
    clickThrough: "deafen",
    shareVolumeUp: "duplicate",
    shareVolumeDown: "unsupported",
  });
  for (const why of Object.values(refused)) assert.ok(WATCH_REASONS[why].length > 0);
  // Same physical key, different modifiers: two keys.
  assert.deepEqual(watchConflicts({ muteShare: "F11", theatre: "Ctrl+F11" }, { ptt: null, mute: null, deafen: null }), {});
});

test("the one hook runs for watch keys alone; a chord fires with exactly its modifiers, once per press", () => {
  const { hook, ptt, watch } = setup();
  ptt.setWatchHotkeys({ clickThrough: "Ctrl+Alt+KeyM", nextShare: "F9" });
  assert.equal(hook.started, 1);
  hook.emit("keydown", { keycode: 50 }); // M alone
  hook.emit("keydown", { keycode: 50, ctrlKey: true }); // Ctrl+M
  hook.emit("keydown", { keycode: 50, ctrlKey: true, altKey: true }); // the chord
  hook.emit("keydown", { keycode: 50, ctrlKey: true, altKey: true }); // auto-repeat
  hook.emit("keyup", { keycode: 50 });
  hook.emit("keydown", { keycode: 50, ctrlKey: true, altKey: true, shiftKey: true }); // too many modifiers
  hook.emit("keydown", { keycode: 67, ctrlKey: true }); // F9 with Ctrl is not F9
  hook.emit("keydown", { keycode: 67 });
  assert.deepEqual(watch, ["clickThrough", "nextShare"]);
  ptt.setWatchHotkeys({});
  assert.equal(hook.stopped, 1);
});

test("a watch key equal to the PTT key is not registered, and returns when PTT moves away", () => {
  const { hook, ptt, watch, states } = setup();
  ptt.setKey("KeyV");
  const refused = ptt.setWatchHotkeys({ toggleMini: "KeyV", theatre: "Ctrl+KeyV" });
  assert.deepEqual(refused, { toggleMini: "ptt", theatre: "ptt" });
  hook.emit("keydown", { keycode: 47 });
  hook.emit("keyup", { keycode: 47 });
  assert.deepEqual(watch, []);
  assert.deepEqual(states, [true, false]);
  ptt.setKey("F8");
  assert.deepEqual(ptt.activeWatchHotkeys.sort(), ["theatre", "toggleMini"]);
  hook.emit("keydown", { keycode: 47 });
  assert.deepEqual(watch, ["toggleMini"]);
});

test("a watch key on the mute or deafen key is not registered", () => {
  const { hook, ptt, watch, hotkeys } = setup();
  ptt.setHotkeys({ mute: "F9", deafen: "F10" });
  ptt.setWatchHotkeys({ muteShare: "F9", shareVolumeUp: "Shift+F10", shareVolumeDown: "F11" });
  assert.deepEqual(ptt.activeWatchHotkeys, ["shareVolumeDown"]);
  hook.emit("keydown", { keycode: 67 });
  assert.deepEqual(hotkeys, ["mute"]);
  assert.deepEqual(watch, []);
  ptt.setHotkeys({ mute: null, deafen: null });
  assert.deepEqual(ptt.activeWatchHotkeys.sort(), ["muteShare", "shareVolumeDown", "shareVolumeUp"]);
});

test("mouse side buttons work as watch keys", () => {
  const { hook, ptt, watch } = setup();
  ptt.setWatchHotkeys({ toggleMini: "MouseForward" });
  hook.emit("mousedown", { button: 5 });
  hook.emit("mousedown", { button: 5 });
  hook.emit("mouseup", { button: 5 });
  hook.emit("mousedown", { button: 5 });
  assert.deepEqual(watch, ["toggleMini", "toggleMini"]);
});
