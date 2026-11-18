import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PttController, type KeyHook } from "../main/ptt";

class FakeHook extends EventEmitter {
  started = 0;
  stopped = 0;
  failStart = false;
  start(): void {
    if (this.failStart) throw new Error("no permission");
    this.started++;
  }
  stop(): void {
    this.stopped++;
  }
}

const quiet = { warn: () => undefined, info: () => undefined };

function setup() {
  const hook = new FakeHook();
  const states: boolean[] = [];
  let loads = 0;
  const ptt = new PttController(
    (d) => states.push(d),
    () => {
      loads++;
      return hook as unknown as KeyHook;
    },
    quiet,
  );
  return { hook, states, ptt, loads: () => loads };
}

test("the hook is not loaded or started until a key is set", () => {
  const { hook, ptt, loads } = setup();
  assert.equal(loads(), 0);
  ptt.setKey("Backquote");
  assert.equal(loads(), 1);
  assert.equal(hook.started, 1);
  assert.ok(ptt.isListening);
  ptt.setKey(null);
  assert.equal(hook.stopped, 1);
  assert.ok(!ptt.isListening);
});

test("down and up are reported once each; repeat and other keys are ignored", () => {
  const { hook, states, ptt } = setup();
  ptt.setKey("KeyV");
  hook.emit("keydown", { keycode: 47 });
  hook.emit("keydown", { keycode: 47 }); // auto-repeat
  hook.emit("keydown", { keycode: 30 }); // KeyA
  hook.emit("keyup", { keycode: 30 });
  hook.emit("keyup", { keycode: 47 });
  assert.deepEqual(states, [true, false]);
});

test("changing or clearing the key while held releases it first", () => {
  const { hook, states, ptt } = setup();
  ptt.setKey("F8");
  hook.emit("keydown", { keycode: 66 });
  ptt.setKey("F9");
  assert.deepEqual(states, [true, false]);
  hook.emit("keyup", { keycode: 66 });
  assert.deepEqual(states, [true, false]);
  hook.emit("keydown", { keycode: 67 });
  ptt.setKey(null);
  assert.deepEqual(states, [true, false, true, false]);
  hook.emit("keydown", { keycode: 67 });
  assert.equal(states.length, 4);
});

test("mouse side button", () => {
  const { hook, states, ptt } = setup();
  ptt.setKey("MouseBack");
  hook.emit("mousedown", { button: 1 });
  hook.emit("mousedown", { button: 4 });
  hook.emit("mouseup", { button: 4 });
  assert.deepEqual(states, [true, false]);
});

test("an unknown code turns PTT off", () => {
  const { hook, ptt } = setup();
  ptt.setKey("Backquote");
  ptt.setKey("Bogus");
  assert.ok(!ptt.isListening);
  assert.equal(hook.stopped, 1);
});

test("a module that fails to load is logged once and nothing fires", () => {
  const warnings: string[] = [];
  const states: boolean[] = [];
  let attempts = 0;
  const ptt = new PttController(
    (d) => states.push(d),
    () => {
      attempts++;
      throw new Error("cannot find module");
    },
    { warn: (m) => warnings.push(m), info: () => undefined },
  );
  ptt.setKey("Backquote");
  ptt.setKey("KeyV");
  ptt.setKey(null);
  ptt.setKey("F8");
  assert.equal(attempts, 1);
  assert.equal(warnings.length, 1);
  assert.ok(!ptt.isListening);
  assert.deepEqual(states, []);
});

test("a hook that fails to start (no OS permission) is logged once", () => {
  const hook = new FakeHook();
  hook.failStart = true;
  const warnings: string[] = [];
  const ptt = new PttController(() => undefined, () => hook as unknown as KeyHook, {
    warn: (m) => warnings.push(m),
    info: () => undefined,
  });
  ptt.setKey("Backquote");
  ptt.setKey("KeyV");
  assert.equal(warnings.length, 1);
  assert.ok(!ptt.isListening);
});
