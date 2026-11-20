import { test } from "node:test";
import assert from "node:assert/strict";
import { WindowStateReporter, windowStateOf, type WindowState } from "../main/windowState";

test("window state: debounced, sent only on change, never guesses fullscreenAppInFront", () => {
  let state: WindowState = { focused: true, minimized: false, hiddenToTray: false };
  const sent: WindowState[] = [];
  const timers: Array<() => void> = [];
  const r = new WindowStateReporter(
    () => state,
    (s) => sent.push(s),
    (fn) => timers.push(fn),
    () => undefined,
  );
  r.poke();
  r.poke();
  timers.splice(0).at(-1)?.();
  assert.equal(sent.length, 1);
  r.poke();
  timers.splice(0).at(-1)?.();
  assert.equal(sent.length, 1, "unchanged: not sent again");
  state = { focused: false, minimized: false, hiddenToTray: true };
  r.poke();
  timers.splice(0).at(-1)?.();
  assert.deepEqual(sent.at(-1), state);
  assert.equal("fullscreenAppInFront" in (sent.at(-1) as object), false);
  r.reset();
  r.poke();
  timers.splice(0).at(-1)?.();
  assert.equal(sent.length, 3, "a new document hears the state again");
});

test("windowStateOf: hidden but not minimized is the tray", () => {
  const w = (focused: boolean, minimized: boolean, visible: boolean) =>
    windowStateOf({ isFocused: () => focused, isMinimized: () => minimized, isVisible: () => visible });
  assert.deepEqual(w(false, false, false), { focused: false, minimized: false, hiddenToTray: true });
  assert.deepEqual(w(false, true, false), { focused: false, minimized: true, hiddenToTray: false });
  assert.deepEqual(w(true, false, true), { focused: true, minimized: false, hiddenToTray: false });
});
