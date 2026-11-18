import { test } from "node:test";
import assert from "node:assert/strict";
import { bindingForCode, keyboardTable, uiohookNameFor } from "../shared/keymap";

test("common PTT keys map to libuiohook codes", () => {
  assert.deepEqual(bindingForCode("Backquote"), { kind: "key", keycode: 41 });
  assert.deepEqual(bindingForCode("KeyV"), { kind: "key", keycode: 47 });
  assert.deepEqual(bindingForCode("F8"), { kind: "key", keycode: 66 });
  assert.deepEqual(bindingForCode("CapsLock"), { kind: "key", keycode: 58 });
  assert.deepEqual(bindingForCode("Space"), { kind: "key", keycode: 57 });
  assert.deepEqual(bindingForCode("ControlRight"), { kind: "key", keycode: 3613 });
  assert.deepEqual(bindingForCode("ArrowUp"), { kind: "key", keycode: 57416 });
  assert.deepEqual(bindingForCode("NumpadEnter"), { kind: "key", keycode: 3612 });
});

test("mouse side buttons are an optional extension", () => {
  assert.deepEqual(bindingForCode("MouseBack"), { kind: "mouse", button: 4 });
  assert.deepEqual(bindingForCode("MouseForward"), { kind: "mouse", button: 5 });
  assert.deepEqual(bindingForCode("MouseMiddle"), { kind: "mouse", button: 3 });
});

test("unknown or prototype names are not keys", () => {
  assert.equal(bindingForCode(""), null);
  assert.equal(bindingForCode("Unidentified"), null);
  assert.equal(bindingForCode("keyv"), null);
  assert.equal(bindingForCode("toString"), null);
  assert.equal(bindingForCode("__proto__"), null);
  assert.equal(bindingForCode("MouseLeft"), null);
});

test("every code is distinct", () => {
  const values = Object.values(keyboardTable());
  assert.equal(new Set(values).size, values.length);
});

test("table agrees with uiohook-napi's UiohookKey where the module loads", (t) => {
  if (process.platform === "linux" && !process.env.DISPLAY) {
    // libuiohook's X11 backend exits the process when it loads with no display.
    t.skip("no X11 display (run under xvfb-run to include this check)");
    return;
  }
  let UiohookKey: Record<string, number>;
  try {
    UiohookKey = (require("uiohook-napi") as { UiohookKey: Record<string, number> }).UiohookKey;
  } catch (error) {
    t.skip(`uiohook-napi not loadable here: ${String(error)}`);
    return;
  }
  let compared = 0;
  for (const [code, value] of Object.entries(keyboardTable())) {
    const name = uiohookNameFor(code);
    if (name === null || !(name in UiohookKey)) continue;
    assert.equal(value, UiohookKey[name], `${code} (${name})`);
    compared++;
  }
  assert.ok(compared >= 90, `compared only ${compared} keys`);
});
