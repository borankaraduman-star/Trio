import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ARM_TIMEOUT_MS,
  MusicCaptureArm,
  REFUSAL_MESSAGES,
  musicCaptureSupport,
  windowsBuild,
  type DisplayRequestFacts,
  type MusicSupport,
} from "../shared/musicCapture";
import { answerDisplayMedia, type DisplayMediaDeps } from "../main/displayMedia";

const WIN11: MusicSupport = { systemAudio: true };
const WIN10 = musicCaptureSupport("win32", "10.0.19045");

const request = (over: Partial<DisplayRequestFacts> = {}): DisplayRequestFacts => ({
  fromServer: true,
  videoRequested: true,
  audioRequested: true,
  pickerOpen: false,
  ...over,
});

test("Windows build from os.release()", () => {
  assert.equal(windowsBuild("10.0.22631"), 22631);
  assert.equal(windowsBuild("10.0.19045"), 19045);
  assert.equal(windowsBuild("6.1.7601"), 0);
  assert.equal(windowsBuild("garbage"), null);
});

test("system sound without Trio's own: Windows 11 (build 22000+) only", () => {
  assert.deepEqual(musicCaptureSupport("win32", "10.0.22000"), { systemAudio: true });
  assert.deepEqual(musicCaptureSupport("win32", "10.0.26100"), { systemAudio: true });
  for (const release of ["10.0.21999", "10.0.19045", "6.3.9600", "?"]) {
    const s = musicCaptureSupport("win32", release);
    assert.equal(s.systemAudio, false, release);
    if (!s.systemAudio) {
      assert.equal(s.reason, "windows-version");
      assert.match(s.message, /Windows 11/);
      assert.match(s.message, /Chrome/);
    }
  }
  for (const platform of ["darwin", "linux"]) {
    const s = musicCaptureSupport(platform, "24.0.0");
    assert.equal(s.systemAudio, false);
    if (!s.systemAudio) assert.equal(s.reason, "unsupported-platform");
  }
});

test("every refusal has a Turkish sentence", () => {
  for (const message of Object.values(REFUSAL_MESSAGES)) assert.ok(message.length > 5);
});

test("unprepared requests go to the screen-share picker, as before V8", () => {
  const arm = new MusicCaptureArm(() => WIN11);
  assert.deepEqual(arm.decide(request()), { kind: "picker" });
  assert.deepEqual(arm.decide(request({ audioRequested: false })), { kind: "picker" });
  assert.deepEqual(arm.decide(request({ fromServer: false })), { kind: "deny" });
  assert.deepEqual(arm.decide(request({ videoRequested: false })), { kind: "deny" });
  assert.deepEqual(arm.decide(request({ pickerOpen: true })), { kind: "deny" });
});

test("a prepared request is a music share, once", () => {
  const arm = new MusicCaptureArm(() => WIN11);
  assert.deepEqual(arm.prepare(true, false), { ok: true });
  assert.ok(arm.armed);
  assert.deepEqual(arm.decide(request()), { kind: "music" });
  // One-shot: the next getDisplayMedia is a screen share again.
  assert.deepEqual(arm.decide(request()), { kind: "picker" });
});

test("a prepared request without audio is refused, and the arm is spent", () => {
  const arm = new MusicCaptureArm(() => WIN11);
  arm.prepare(true, false);
  assert.deepEqual(arm.decide(request({ audioRequested: false })), { kind: "deny" });
  assert.deepEqual(arm.decide(request()), { kind: "picker" });
});

test("a prepared request from elsewhere is denied and spends the arm", () => {
  const arm = new MusicCaptureArm(() => WIN11);
  arm.prepare(true, false);
  assert.deepEqual(arm.decide(request({ fromServer: false })), { kind: "deny" });
  assert.ok(!arm.armed);
});

test("the arm expires", () => {
  let now = 1000;
  const arm = new MusicCaptureArm(() => WIN11, () => now);
  arm.prepare(true, false);
  now += ARM_TIMEOUT_MS + 1;
  assert.ok(!arm.armed);
  assert.deepEqual(arm.decide(request()), { kind: "picker" });
});

test("prepare refuses off the server page, while the picker is open, and on Windows 10", () => {
  const arm = new MusicCaptureArm(() => WIN11);
  assert.deepEqual(arm.prepare(false, false), { ok: false, reason: "not-allowed", message: REFUSAL_MESSAGES["not-allowed"] });
  const busy = arm.prepare(true, true);
  assert.equal(busy.ok, false);
  if (!busy.ok) assert.equal(busy.reason, "busy");
  assert.ok(!arm.armed);

  const old = new MusicCaptureArm(() => WIN10);
  const refused = old.prepare(true, false);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.reason, "windows-version");
  // Never armed: a getDisplayMedia that follows anyway gets the normal picker,
  // where nothing is shared without the person picking it.
  assert.deepEqual(old.decide(request()), { kind: "picker" });
});

// ------------------------------------------------------- answerDisplayMedia

function deps(over: Partial<DisplayMediaDeps<string>> = {}) {
  const calls = { picker: 0, screen: 0 };
  const d: DisplayMediaDeps<string> = {
    pickSource: async () => {
      calls.picker++;
      return { source: "window:1", audio: true };
    },
    primaryScreen: async () => {
      calls.screen++;
      return "screen:0";
    },
    loopbackSupported: true,
    ...over,
  };
  return { d, calls };
}

test("screen share: picker answer and loopback exactly as before", async () => {
  {
    const { d, calls } = deps();
    assert.deepEqual(await answerDisplayMedia({ kind: "picker" }, true, d), { video: "window:1", audio: "loopback" });
    assert.equal(calls.picker, 1);
    assert.equal(calls.screen, 0);
  }
  {
    const { d } = deps({ loopbackSupported: false });
    assert.deepEqual(await answerDisplayMedia({ kind: "picker" }, true, d), { video: "window:1" });
  }
  {
    const { d } = deps({ pickSource: async () => ({ source: "screen:1", audio: false }) });
    assert.deepEqual(await answerDisplayMedia({ kind: "picker" }, true, d), { video: "screen:1" });
  }
  {
    const { d } = deps({ pickSource: async () => null });
    assert.equal(await answerDisplayMedia({ kind: "picker" }, true, d), null);
  }
});

test("music: no picker, a screen as the throwaway video, plain loopback (never loopbackWithMute)", async () => {
  const { d, calls } = deps();
  const answer = await answerDisplayMedia({ kind: "music" }, true, d);
  assert.deepEqual(answer, { video: "screen:0", audio: "loopback" });
  assert.equal(calls.picker, 0);
});

test("music without a screen source, or with getSources failing, is denied", async () => {
  assert.equal(await answerDisplayMedia({ kind: "music" }, true, deps({ primaryScreen: async () => null }).d), null);
  const failing = deps({
    primaryScreen: async () => {
      throw new Error("no");
    },
  }).d;
  assert.equal(await answerDisplayMedia({ kind: "music" }, true, failing), null);
});

test("deny is null and touches nothing", async () => {
  const { d, calls } = deps();
  assert.equal(await answerDisplayMedia({ kind: "deny" }, true, d), null);
  assert.deepEqual(calls, { picker: 0, screen: 0 });
});

// --------------------------------------------------------- wiring checks

const SRC = path.join(__dirname, "..", "..", "src");
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), "utf8");

test("main.ts: the music IPC checks the sender like every other channel", () => {
  const main = read("main/main.ts");
  for (const channel of ["trio:music-support", "trio:music-prepare", "trio:now-playing-watch"]) {
    const at = main.indexOf(`"${channel}"`);
    assert.ok(at > 0, channel);
    assert.match(main.slice(at, at + 200), /fromServerPage\(event\)/, channel);
  }
  // The handler never answers with the mute variant.
  assert.ok(!/audio:\s*"loopbackWithMute"/.test(main));
});

test("the sandboxed preload requires nothing but electron", () => {
  const built = fs.readFileSync(path.join(__dirname, "..", "preload", "app-preload.js"), "utf8");
  const requires = [...built.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]);
  assert.deepEqual(requires, ["electron"]);
  for (const name of ["musicCaptureSupport", "prepareMusicCapture", "setNowPlayingWatch", "onNowPlaying"]) {
    assert.ok(built.includes(name), name);
  }
});
