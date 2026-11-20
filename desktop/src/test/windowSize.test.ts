import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_WINDOW, initialWindowSize, showsMemberColumn } from "../shared/windowSize";

test("a large work area gets the default 1280×820", () => {
  assert.deepEqual(initialWindowSize({ width: 1920, height: 1040 }), DEFAULT_WINDOW);
  // 1920×1080 at 125 %: 1536×835 DIP of work area.
  assert.deepEqual(initialWindowSize({ width: 1536, height: 824 }), { width: 1280, height: 820 });
});

test("a scaled laptop screen: the window fits the work area and still shows the member column", () => {
  // 1366×768 at 150 % → 911×488 DIP (taskbar off the height).
  const size = initialWindowSize({ width: 911, height: 488 });
  assert.deepEqual(size, { width: 911, height: 488 });
  assert.equal(showsMemberColumn(size.width), true);
  // 1280×720 at 150 % → 853 DIP: the column does not fit; "Üyeler" opens the panel.
  assert.equal(showsMemberColumn(initialWindowSize({ width: 853, height: 440 }).width), false);
});

test("a nonsense work area keeps the default", () => {
  assert.deepEqual(initialWindowSize({ width: 0, height: Number.NaN }), DEFAULT_WINDOW);
});

test("the default window shows the member column", () => {
  assert.equal(showsMemberColumn(DEFAULT_WINDOW.width), true);
});
