import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PttController, type HotkeyAction, type KeyHook } from "../main/ptt";
import { drawTrayMark, trayTooltip, trayVoiceState } from "../main/trayState";

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
  const states: boolean[] = [];
  const hotkeys: HotkeyAction[] = [];
  let loads = 0;
  const ptt = new PttController(
    (d) => states.push(d),
    () => {
      loads++;
      return hook as unknown as KeyHook;
    },
    quiet,
    (action) => hotkeys.push(action),
  );
  return { hook, states, hotkeys, ptt, loads: () => loads };
}

// libuiohook codes: F9 67, F10 68, KeyV 47, Backquote 41.

test("hotkeys run the one hook without a PTT key, and stop it when cleared", () => {
  const { hook, ptt, hotkeys, loads } = setup();
  ptt.setHotkeys({ mute: "F9", deafen: "F10" });
  assert.equal(loads(), 1);
  assert.equal(hook.started, 1);
  assert.ok(ptt.isListening);
  hook.emit("keydown", { keycode: 67 });
  hook.emit("keydown", { keycode: 67 }); // auto-repeat: one toggle per press
  hook.emit("keyup", { keycode: 67 });
  hook.emit("keydown", { keycode: 68 });
  hook.emit("keyup", { keycode: 68 });
  hook.emit("keydown", { keycode: 67 });
  assert.deepEqual(hotkeys, ["mute", "deafen", "mute"]);
  ptt.setHotkeys({ mute: null, deafen: null });
  assert.equal(hook.stopped, 1);
  assert.ok(!ptt.isListening);
});

test("PTT and hotkeys share ONE hook instance; clearing one keeps the hook for the other", () => {
  const { hook, ptt, states, hotkeys, loads } = setup();
  ptt.setKey("KeyV");
  ptt.setHotkeys({ mute: "F9" });
  assert.equal(loads(), 1);
  assert.equal(hook.started, 1);
  hook.emit("keydown", { keycode: 47 });
  hook.emit("keyup", { keycode: 47 });
  hook.emit("keydown", { keycode: 67 });
  assert.deepEqual(states, [true, false]);
  assert.deepEqual(hotkeys, ["mute"]);
  ptt.setKey(null);
  assert.ok(ptt.isListening, "the hotkey still needs the hook");
  assert.equal(hook.stopped, 0);
  ptt.setHotkeys({});
  assert.equal(hook.stopped, 1);
});

test("a hotkey on the PTT key is not registered: PTT wins", () => {
  const { hook, ptt, states, hotkeys } = setup();
  ptt.setKey("Backquote");
  ptt.setHotkeys({ mute: "Backquote", deafen: "F10" });
  assert.deepEqual(ptt.activeHotkeys, ["deafen"]);
  hook.emit("keydown", { keycode: 41 });
  hook.emit("keyup", { keycode: 41 });
  assert.deepEqual(states, [true, false]);
  assert.deepEqual(hotkeys, []);
  // A different PTT key frees it.
  ptt.setKey("KeyV");
  assert.deepEqual(ptt.activeHotkeys, ["mute", "deafen"]);
});

test("mute and deafen on one key keep only mute; unknown codes are dropped", () => {
  const { ptt } = setup();
  ptt.setHotkeys({ mute: "F9", deafen: "F9" });
  assert.deepEqual(ptt.activeHotkeys, ["mute"]);
  ptt.setHotkeys({ mute: "NotAKey", deafen: "F10" });
  assert.deepEqual(ptt.activeHotkeys, ["deafen"]);
});

test("dispose clears hotkeys and stops the hook", () => {
  const { hook, ptt } = setup();
  ptt.setHotkeys({ mute: "F9" });
  ptt.dispose();
  assert.equal(hook.stopped, 1);
  assert.deepEqual(ptt.activeHotkeys, []);
});

test("tray state and tooltip", () => {
  assert.equal(trayVoiceState({ inVoice: false, muted: true, deafened: true }), "none");
  assert.equal(trayVoiceState({ inVoice: true, muted: true, deafened: false }), "muted");
  assert.equal(trayVoiceState({ inVoice: true, muted: true, deafened: true }), "deafened");
  assert.equal(trayVoiceState({ inVoice: true, muted: false, deafened: false }), "none");
  assert.equal(trayTooltip("muted", "Trio"), "Trio — sessizde");
  assert.equal(trayTooltip("none", "Trio"), "Trio");
});

test("the tray mark is drawn bottom-right and leaves the rest of the icon alone", () => {
  const w = 16;
  const h = 16;
  const base = Buffer.alloc(w * h * 4, 0);
  for (let i = 0; i < w * h; i++) base[i * 4 + 3] = 0x80;
  const none = drawTrayMark(base, w, h, "none");
  assert.deepEqual(none, base);
  assert.notEqual(none, base, "a copy, never the original");
  const muted = drawTrayMark(base, w, h, "muted");
  const at = (buf: Buffer, x: number, y: number) => [...buf.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)];
  // Top-left untouched.
  assert.deepEqual(at(muted, 0, 0), at(base, 0, 0));
  // Centre of the mark (cx = cy = 16 - 4.8 - .5 ≈ 10.7): the white bar for muted.
  assert.deepEqual(at(muted, 11, 11), [0xff, 0xff, 0xff, 0xff]);
  // A red pixel on the disc away from the bar (BGRA).
  assert.deepEqual(at(muted, 11, 8), [0x7f, 0x77, 0xe4, 0xff]);
  const deaf = drawTrayMark(base, w, h, "deafened");
  assert.notDeepEqual(deaf, muted);
  assert.deepEqual(at(base, 11, 11), [0, 0, 0, 0x80], "the input is not modified");
});

import * as fs from "node:fs";
import * as path from "node:path";
import { VERSION_ARG_PREFIX, versionArgument, versionFromArgv, versionLabel } from "../shared/appVersion";

test("the app version travels to the preload through argv and back", () => {
  const argv = ["electron", "--type=renderer", ...versionArgument("0.4.0")];
  assert.deepEqual(versionArgument("0.4.0"), ["--trio-app-version=0.4.0"]);
  assert.equal(versionFromArgv(argv), "0.4.0");
  assert.equal(versionFromArgv(["x", ...versionArgument("1.2.3-beta.1")]), "1.2.3-beta.1");
  assert.equal(versionFromArgv(["x"]), null);
  assert.equal(versionFromArgv(["--trio-app-version=<script>"]), null);
  assert.deepEqual(versionArgument("not a version"), []);
  assert.equal(versionLabel("0.4.0"), "Trio 0.4.0");
});

test("the preload reads the same argument and exposes appVersion on the bridge", () => {
  // The sandboxed preload cannot import shared/appVersion; hold its copy to the same prefix.
  const source = fs.readFileSync(path.join(__dirname, "..", "preload", "app-preload.js"), "utf8");
  assert.ok(source.includes(JSON.stringify(VERSION_ARG_PREFIX)), "same prefix");
  assert.ok(/appVersion: APP_VERSION/.test(source), "exposed as trioDesktop.appVersion");
  // And it runs: evaluate the parse against a fake process.argv.
  const fn = source.match(/function appVersionFromArgv\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(fn, "parse function present");
  const run = (argv: string[]) => new Function("process", `const VERSION_ARG_PREFIX = ${JSON.stringify(VERSION_ARG_PREFIX)}; ${fn}; return appVersionFromArgv()`)({ argv }) as string | null;
  assert.equal(run(["a", "--trio-app-version=0.5.1"]), "0.5.1");
  assert.equal(run(["a", "--trio-app-version=0.5"]), null);
  assert.equal(run(["a"]), null);
});
