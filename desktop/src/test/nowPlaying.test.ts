import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import {
  APP_MAX,
  TITLE_MAX,
  appLabel,
  cleanText,
  fromSourceRecord,
  parseSpotifyTitle,
  sameNowPlaying,
  sanitiseNowPlaying,
} from "../shared/nowPlaying";
import {
  LineReader,
  MAX_RESTARTS,
  NowPlayingWatcher,
  PowerShellSource,
  RESTART_DELAY_MS,
  buildScript,
  defaultSource,
  encodeCommand,
  powerShellArgs,
  type NowPlayingSource,
} from "../main/nowPlaying";

// ------------------------------------------------------------------ cleaning

test("text is cleaned: controls, bidi overrides, zero-width removed; whitespace collapsed", () => {
  assert.equal(cleanText("  A\u202eB\u0007C\u200b  d\n\te ", 50), "A B C d e");
  assert.equal(cleanText("", 10), null);
  assert.equal(cleanText("   \u200f ", 10), null);
  assert.equal(cleanText(42, 10), null);
});

test("length is capped on code points, never splitting a surrogate pair", () => {
  const long = "😀".repeat(TITLE_MAX + 10);
  const cut = cleanText(long, TITLE_MAX);
  assert.ok(cut);
  assert.equal(Array.from(cut).length, TITLE_MAX);
  assert.ok(!/[\ud800-\udbff]$/.test(cut));
});

test("sanitise keeps only strings, drops empty fields, requires a title", () => {
  assert.deepEqual(sanitiseNowPlaying({ title: " Song ", artist: "", app: "Spotify", extra: "<b>" }), {
    title: "Song",
    app: "Spotify",
  });
  assert.equal(sanitiseNowPlaying({ artist: "x" }), null);
  assert.equal(sanitiseNowPlaying(null), null);
  assert.equal(sanitiseNowPlaying("Song"), null);
  assert.deepEqual(sanitiseNowPlaying({ title: "<script>x</script>" }), { title: "<script>x</script>" }); // text, the page never renders HTML
});

test("app labels from AppUserModelIds, never a path", () => {
  assert.equal(appLabel("Spotify.exe"), "Spotify");
  assert.equal(appLabel("SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify"), "Spotify");
  assert.equal(appLabel("Chrome"), "Chrome");
  assert.equal(appLabel("MSEdge"), "Edge");
  assert.equal(appLabel("308046B0AF4A39CB"), "Firefox");
  assert.equal(appLabel("Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic"), "Medya Oynatıcı");
  assert.equal(appLabel("C:\\Program Files\\Foo\\foobar2000.exe"), "foobar2000");
  assert.equal(appLabel("Vendor.Player_abcdefghijklm!App"), "Player");
  assert.ok((appLabel("x".repeat(500)) ?? "").length <= APP_MAX);
  assert.equal(appLabel(undefined), null);
});

test("Spotify window title: 'Artist - Song', idle titles are nothing", () => {
  assert.deepEqual(parseSpotifyTitle("Sezen Aksu - Firuze"), { artist: "Sezen Aksu", title: "Firuze", app: "Spotify" });
  assert.deepEqual(parseSpotifyTitle("Daft Punk - Harder, Better - Live"), {
    artist: "Daft Punk",
    title: "Harder, Better - Live",
    app: "Spotify",
  });
  assert.equal(parseSpotifyTitle("Spotify"), null);
  assert.equal(parseSpotifyTitle("Spotify Premium"), null);
  assert.equal(parseSpotifyTitle("Spotify Free"), null);
  assert.deepEqual(parseSpotifyTitle("A podcast episode"), { title: "A podcast episode", app: "Spotify" });
});

test("source records → NowPlaying", () => {
  assert.deepEqual(fromSourceRecord({ source: "session", title: "Firuze", artist: "Sezen Aksu", app: "Spotify.exe" }), {
    title: "Firuze",
    artist: "Sezen Aksu",
    app: "Spotify",
  });
  assert.deepEqual(fromSourceRecord({ source: "session", title: "Lofi", artist: "", app: "Chrome" }), {
    title: "Lofi",
    app: "Chrome",
  });
  assert.deepEqual(fromSourceRecord({ source: "spotify-window", title: "A - B" }), { artist: "A", title: "B", app: "Spotify" });
  assert.equal(fromSourceRecord(null), null);
  assert.equal(fromSourceRecord({ source: "other", title: "x" }), null);
  assert.equal(fromSourceRecord({ source: "session", title: "" }), null);
});

test("sameNowPlaying", () => {
  assert.ok(sameNowPlaying(null, null));
  assert.ok(!sameNowPlaying(null, { title: "a" }));
  assert.ok(sameNowPlaying({ title: "a", artist: "b" }, { title: "a", artist: "b" }));
  assert.ok(!sameNowPlaying({ title: "a" }, { title: "a", app: "Chrome" }));
});

// ------------------------------------------------------------------ watcher

class FakeSource implements NowPlayingSource {
  starts = 0;
  stops = 0;
  push: ((raw: unknown) => void) | null = null;
  start(onRaw: (raw: unknown) => void): void {
    this.starts++;
    this.push = onRaw;
  }
  stop(): void {
    this.stops++;
  }
}

test("the watcher reads nothing and sends nothing while off", () => {
  const source = new FakeSource();
  const sent: unknown[] = [];
  const w = new NowPlayingWatcher(source, (i) => sent.push(i));
  assert.equal(source.starts, 0);
  w.setWatch(false);
  assert.equal(source.starts, 0);
  assert.equal(source.stops, 0);
  assert.deepEqual(sent, []);
});

test("the watcher emits on change only, and stops the source when the watch goes off", () => {
  const source = new FakeSource();
  const sent: unknown[] = [];
  const w = new NowPlayingWatcher(source, (i) => sent.push(i));
  w.setWatch(true);
  w.setWatch(true); // idempotent
  assert.equal(source.starts, 1);
  const push = source.push!;
  push(null); // nothing known yet — same as the starting state, no emit
  push({ source: "session", title: "Firuze", artist: "Sezen Aksu", app: "Spotify.exe" });
  push({ source: "session", title: "Firuze", artist: "Sezen Aksu", app: "Spotify.exe" });
  push({ source: "session", title: "  Firuze ", artist: "Sezen Aksu", app: "SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify" });
  push({ source: "spotify-window", title: "Sezen Aksu - Gülümse" });
  push(null);
  assert.deepEqual(sent, [
    { title: "Firuze", artist: "Sezen Aksu", app: "Spotify" },
    { title: "Gülümse", artist: "Sezen Aksu", app: "Spotify" },
    null,
  ]);
  w.setWatch(false);
  assert.equal(source.stops, 1);
  push({ source: "session", title: "Late", app: "Chrome" }); // after off: dropped
  assert.equal(sent.length, 3);
});

test("a record from an earlier watch is dropped after a restart of the watch", () => {
  const source = new FakeSource();
  const sent: unknown[] = [];
  const w = new NowPlayingWatcher(source, (i) => sent.push(i));
  w.setWatch(true);
  const old = source.push!;
  w.setWatch(false);
  w.setWatch(true);
  old({ source: "session", title: "Old" });
  assert.deepEqual(sent, []);
  source.push!({ source: "session", title: "New" });
  assert.deepEqual(sent, [{ title: "New" }]);
  w.dispose();
  assert.ok(!w.watching);
});

test("no source (macOS/Linux): the watch does nothing", () => {
  assert.equal(defaultSource("darwin"), null);
  assert.equal(defaultSource("linux"), null);
  assert.ok(defaultSource("win32") instanceof PowerShellSource);
  const sent: unknown[] = [];
  const w = new NowPlayingWatcher(null, (i) => sent.push(i));
  w.setWatch(true);
  w.setWatch(false);
  assert.deepEqual(sent, []);
});

// --------------------------------------------------------- PowerShell source

test("line reader: JSON per line, BOM, split chunks, junk and overlong lines dropped", () => {
  const got: unknown[] = [];
  const r = new LineReader((x) => got.push(x));
  r.push('\ufeff{"source":"session","ti');
  r.push('tle":"A"}\r\nnot json\n\nnull\n');
  r.push("x".repeat(9000));
  r.push("\n");
  r.push('{"a":1}\n');
  assert.deepEqual(got, [{ source: "session", title: "A" }, null, { a: 1 }]);
});

test("the script: parent pid substituted, polls, reads the media session and Spotify's window", () => {
  const script = buildScript(4242);
  assert.match(script, /\$parentPid = 4242/);
  assert.ok(!script.includes("__"));
  assert.match(script, /GlobalSystemMediaTransportControlsSessionManager/);
  assert.match(script, /IAsyncOperation`1/);
  assert.match(script, /Get-Process -Name Spotify/);
  assert.match(script, /Get-Process -Id \$parentPid/);
  assert.match(script, /Start-Sleep -Seconds 3/);
  assert.throws(() => buildScript(0));
  assert.throws(() => buildScript(1.5));
});

test("arguments: hidden, no profile, the script encoded as UTF-16LE base64", () => {
  const args = powerShellArgs(7);
  for (const flag of ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand"]) {
    assert.ok(args.includes(flag), flag);
  }
  const encoded = args[args.length - 1]!;
  assert.equal(encoded, encodeCommand(buildScript(7)));
  assert.equal(Buffer.from(encoded, "base64").toString("utf16le"), buildScript(7));
});

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  exitCode: number | null = null;
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
  exit(code = 1): void {
    this.exitCode = code;
    this.emit("exit", code);
  }
}

function fakePowerShell() {
  const children: FakeChild[] = [];
  const spawns: { file: string; args: string[]; options: Record<string, unknown> }[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const source = new PowerShellSource({
    spawn: (file, args, options) => {
      spawns.push({ file, args, options: options as Record<string, unknown> });
      const child = new FakeChild();
      children.push(child);
      return child as unknown as ChildProcess;
    },
    parentPid: 99,
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimer: () => undefined,
    log: () => undefined,
  });
  return { source, children, spawns, timers };
}

const tick = () => new Promise((r) => setImmediate(r));

test("PowerShell source: one hidden process per watch, records forwarded, killed on stop", async () => {
  const { source, children, spawns } = fakePowerShell();
  const got: unknown[] = [];
  source.start((raw) => got.push(raw));
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0]!.file, "powershell.exe");
  assert.equal(spawns[0]!.options.windowsHide, true);
  assert.deepEqual(spawns[0]!.options.stdio, ["ignore", "pipe", "pipe"]); // stderr: the reason when it fails (V11)
  children[0]!.stdout.write('{"source":"session","title":"A"}\n');
  await tick();
  assert.deepEqual(got, [{ source: "session", title: "A" }]);
  source.stop();
  assert.ok(children[0]!.killed);
  assert.ok(!source.running);
  children[0]!.stdout.write('{"source":"session","title":"B"}\n');
  children[0]!.exit(0);
  await tick();
  assert.equal(got.length, 1); // nothing after stop, and a killed child is not restarted
  assert.equal(spawns.length, 1);
});

test("PowerShell source: an unexpected exit reports null and restarts a few times, then gives up", async () => {
  const { source, children, spawns, timers } = fakePowerShell();
  const got: unknown[] = [];
  source.start((raw) => got.push(raw));
  for (let i = 0; i < MAX_RESTARTS; i++) {
    children[children.length - 1]!.exit(1);
    assert.equal(timers.length, i + 1);
    assert.equal(timers[i]!.ms, RESTART_DELAY_MS);
    timers[i]!.fn();
    assert.equal(spawns.length, i + 2);
  }
  children[children.length - 1]!.exit(1);
  assert.equal(timers.length, MAX_RESTARTS); // gave up
  assert.deepEqual(got, Array(MAX_RESTARTS + 1).fill(null));
  // A new watch starts afresh.
  source.start((raw) => got.push(raw));
  assert.equal(spawns.length, MAX_RESTARTS + 2);
  source.stop();
});

test("PowerShell source: a spawn that throws leaves nothing running", () => {
  const source = new PowerShellSource({
    spawn: () => {
      throw new Error("ENOENT");
    },
    log: () => undefined,
  });
  source.start(() => undefined);
  assert.ok(!source.running);
  source.stop();
});
