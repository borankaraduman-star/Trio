import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import {
  ListeningTracker,
  PAUSE_HOLD_MS,
  classifyApp,
  musicAppName,
  readSessions,
  shareValue,
  type ListeningState,
} from "../shared/listening";
import { MAX_RESTARTS, MediaWatch, PowerShellSource, buildScript, type NowPlayingSource, type SourceHealth } from "../main/nowPlaying";

const SPOTIFY = "Spotify.exe";
const CHROME = "Chrome";

function reading(sessions: { app: string; status?: string; title?: string; artist?: string }[], extra: Record<string, unknown> = {}) {
  return {
    source: "sessions",
    winrt: true,
    sessions: sessions.map((s) => ({ status: "Playing", title: "", artist: "", ...s })),
    spotify: null,
    ...extra,
  };
}

// ------------------------------------------------------------------ the allowlist

test("known music apps are music; browsers and everything else are not", () => {
  for (const id of [
    "Spotify.exe",
    "SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify",
    "AppleInc.AppleMusicWin_nzyj5cx40ttqa!App",
    "AppleInc.iTunes_nzyj5cx40ttqa!iTunes",
    "TIDAL.exe",
    "com.squirrel.Deezer.Deezer",
    "AmazonMobileLLC.AmazonMusic_kc6t79cpj4tp0!AmazonMusic",
    "com.github.th-ch.youtube-music",
    "foobar2000.exe",
    "AIMP.exe",
    "MusicBee.exe",
    "winamp.exe",
  ]) {
    assert.equal(classifyApp(id), "music", id);
  }
  for (const id of ["Chrome", "MSEdge", "308046B0AF4A39CB", "Opera", "Brave", "Vivaldi", "Chrome._crx_youtubemusic"]) {
    assert.equal(classifyApp(id), "browser", id);
  }
  for (const id of ["Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic", "VideoLAN.VLC_paz6r1rewnh0a!App", "vlc.exe", "", 5, null]) {
    assert.equal(classifyApp(id), "other", String(id));
  }
  assert.equal(musicAppName("AppleInc.AppleMusicWin_nzyj5cx40ttqa!App"), "Apple Music");
  assert.equal(musicAppName("TIDAL.exe"), "TIDAL");
  assert.equal(musicAppName(CHROME), "Chrome");
});

test("a sessions reading is checked; one-element arrays and duplicates handled", () => {
  assert.equal(readSessions(null), null);
  assert.equal(readSessions({ source: "session", title: "x" }), null);
  const one = readSessions({ source: "sessions", winrt: true, sessions: { app: SPOTIFY, status: "Playing", title: "A" }, spotify: null });
  assert.equal(one?.sessions.length, 1);
  const twice = readSessions(reading([{ app: SPOTIFY, title: "A" }, { app: SPOTIFY, title: "A" }]));
  assert.equal(twice?.sessions.length, 1); // the current session is listed twice
  const junk = readSessions({ source: "sessions", sessions: [1, "x", { app: "‮Spot\nify", status: "Playing", title: " Ş " }] });
  assert.deepEqual(junk?.sessions, [{ app: "Spot ify", playing: true, title: "Ş", artist: null }]);
  assert.equal(readSessions({ source: "sessions", winrt: false, sessions: [] })?.winrt, false);
});

test("the V8 share value is the first Playing session of any app, as before", () => {
  const r = readSessions(reading([{ app: CHROME, title: "Video" }, { app: SPOTIFY, title: "Song" }]))!;
  assert.deepEqual(shareValue(r), { title: "Video", app: "Chrome" });
  const paused = readSessions(reading([{ app: SPOTIFY, status: "Paused", title: "Song" }], { spotify: "A - B" }))!;
  assert.deepEqual(shareValue(paused), { artist: "A", title: "B", app: "Spotify" });
});

// ------------------------------------------------------------------ the tracker

test("the status takes the first Playing ALLOWED session; a browser only with the option", () => {
  let now = 0;
  const t = new ListeningTracker(() => now);
  const r = readSessions(reading([{ app: CHROME, title: "Gizli video" }, { app: SPOTIFY, title: "Firuze", artist: "Sezen Aksu" }]))!;
  assert.deepEqual(t.update(r, false), { title: "Firuze", artist: "Sezen Aksu", app: "Spotify" });
  assert.deepEqual(t.lastApp, { name: "Chrome", shown: false });
  assert.deepEqual(t.update(r, true), { title: "Gizli video", app: "Chrome" });
  const onlyChrome = readSessions(reading([{ app: CHROME, title: "Gizli video" }]))!;
  t.reset();
  assert.equal(t.update(onlyChrome, false), null);
  const vlc = readSessions(reading([{ app: "vlc.exe", title: "film.mkv" }]))!;
  assert.equal(t.update(vlc, false), null);
  now += 1;
});

test("a pause holds the song for 30 s; the app gone clears it at once", () => {
  let now = 1_000;
  const t = new ListeningTracker(() => now);
  const playing = readSessions(reading([{ app: SPOTIFY, title: "Firuze" }]))!;
  const paused = readSessions(reading([{ app: SPOTIFY, status: "Paused", title: "Firuze" }]))!;
  const gone = readSessions(reading([]))!;
  assert.equal(t.update(playing, false)?.title, "Firuze");
  now += 10_000;
  assert.equal(t.update(paused, false)?.title, "Firuze");
  assert.equal(t.holdEndsAt(), 1_000 + 10_000 - 10_000 + PAUSE_HOLD_MS);
  now = 1_000 + PAUSE_HOLD_MS - 1;
  assert.equal(t.update(paused, false)?.title, "Firuze");
  now = 1_000 + PAUSE_HOLD_MS;
  assert.equal(t.update(paused, false), null);
  // Playing again, then Spotify closes: nothing at once.
  assert.equal(t.update(playing, false)?.title, "Firuze");
  now += 1_000;
  assert.equal(t.update(gone, false), null);
  // The reader stopping: nothing.
  t.update(playing, false);
  assert.equal(t.update(null, false), null);
});

test("Spotify's window title when its session is not listed; idle window holds like a pause", () => {
  let now = 0;
  const t = new ListeningTracker(() => now);
  const window = readSessions({ source: "sessions", winrt: false, sessions: [], spotify: "Sezen Aksu - Gülümse" })!;
  assert.deepEqual(t.update(window, false), { artist: "Sezen Aksu", title: "Gülümse", app: "Spotify" });
  const idle = readSessions({ source: "sessions", winrt: false, sessions: [], spotify: "Spotify Premium" })!;
  now += 5_000;
  assert.equal(t.update(idle, false)?.title, "Gülümse");
  now += PAUSE_HOLD_MS;
  assert.equal(t.update(idle, false), null);
  const closed = readSessions({ source: "sessions", winrt: false, sessions: [], spotify: null })!;
  t.update(window, false);
  assert.equal(t.update(closed, false), null);
});

// ------------------------------------------------------------------ the watch (both wishes, one reader)

class FakeSource implements NowPlayingSource {
  starts = 0;
  stops = 0;
  push: ((raw: unknown) => void) | null = null;
  fail: ((h: SourceHealth) => void) | null = null;
  start(onRaw: (raw: unknown) => void, onHealth?: (h: SourceHealth) => void): void {
    this.starts++;
    this.push = onRaw;
    this.fail = onHealth ?? null;
  }
  stop(): void {
    this.stops++;
  }
}

function watch(source: NowPlayingSource | null = new FakeSource()) {
  let now = 0;
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const share: unknown[] = [];
  const status: ListeningState[] = [];
  const w = new MediaWatch(source, (i) => share.push(i), (s) => status.push(s), {
    now: () => now,
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      (h as { cleared: boolean }).cleared = true;
    },
  });
  return { w, share, status, timers, advance: (ms: number) => (now += ms) };
}

test("the status starts and stops the reader by itself, with no music share", () => {
  const source = new FakeSource();
  const { w, status } = watch(source);
  w.setStatus({ on: true, browsers: false });
  assert.equal(source.starts, 1);
  assert.equal(status.at(-1)?.health, "starting");
  source.push!(reading([{ app: SPOTIFY, title: "Firuze" }]));
  assert.deepEqual(status.at(-1), {
    playing: { title: "Firuze", app: "Spotify" },
    health: "ok",
    lastApp: { name: "Spotify.exe", shown: true },
  });
  w.setStatus({ on: false, browsers: false });
  assert.equal(source.stops, 1);
  assert.deepEqual(status.at(-1), { playing: null, health: "off" });
  source.push!(reading([{ app: SPOTIFY, title: "Late" }]));
  assert.equal(status.at(-1)?.health, "off");
});

test("share and status share ONE reader; each wish gets the last reading at once", () => {
  const source = new FakeSource();
  const { w, share, status } = watch(source);
  w.setStatus({ on: true, browsers: false });
  source.push!(reading([{ app: CHROME, title: "Video" }, { app: SPOTIFY, title: "Firuze" }]));
  assert.equal(status.at(-1)?.playing?.title, "Firuze");
  w.setShare(true); // the reader already runs and prints only on change
  assert.equal(source.starts, 1);
  assert.deepEqual(share, [{ title: "Video", app: "Chrome" }]);
  w.setShare(false);
  assert.equal(source.stops, 0); // the status still wants it
  w.setStatus({ on: false, browsers: false });
  assert.equal(source.stops, 1);
});

test("the browsers option re-evaluates the last reading at once", () => {
  const source = new FakeSource();
  const { w, status } = watch(source);
  w.setStatus({ on: true, browsers: false });
  source.push!(reading([{ app: CHROME, title: "Video" }]));
  assert.equal(status.at(-1)?.playing, null);
  assert.deepEqual(status.at(-1)?.lastApp, { name: "Chrome", shown: false });
  w.setStatus({ on: true, browsers: true });
  assert.equal(status.at(-1)?.playing?.title, "Video");
  w.setStatus({ on: true, browsers: false });
  assert.equal(status.at(-1)?.playing, null);
});

test("a paused song ends after 30 s even though the reader stays quiet", () => {
  const source = new FakeSource();
  const { w, status, timers, advance } = watch(source);
  w.setStatus({ on: true, browsers: false });
  source.push!(reading([{ app: SPOTIFY, title: "Firuze" }]));
  advance(3_000);
  source.push!(reading([{ app: SPOTIFY, status: "Paused", title: "Firuze" }]));
  assert.equal(status.at(-1)?.playing?.title, "Firuze");
  const timer = timers.filter((t) => !t.cleared).at(-1)!;
  assert.ok(timer.ms >= PAUSE_HOLD_MS - 3_000);
  advance(timer.ms);
  timer.fn();
  assert.equal(status.at(-1)?.playing, null);
});

test("health: limited without the media session API, failed with the reason, unsupported without a source", () => {
  const source = new FakeSource();
  const { w, status } = watch(source);
  w.setStatus({ on: true, browsers: false });
  source.push!({ source: "sessions", winrt: false, sessions: [], spotify: null, error: "Class not registered" });
  assert.equal(status.at(-1)?.health, "limited");
  assert.match(status.at(-1)?.message ?? "", /Spotify penceresi.*Class not registered/);
  source.fail!({ state: "failed", message: "PowerShell başlatılamadı (ENOENT)" });
  assert.equal(status.at(-1)?.health, "failed");
  assert.equal(status.at(-1)?.message, "Müzik durumu okunamadı: PowerShell başlatılamadı (ENOENT)");
  assert.equal(status.at(-1)?.playing, null);

  const none = watch(null);
  none.w.setStatus({ on: true, browsers: false });
  assert.deepEqual(none.status.at(-1), { playing: null, health: "unsupported", message: "Bu sistemde otomatik algılanamıyor." });
});

test("stopAll (a navigation) turns both wishes off", () => {
  const source = new FakeSource();
  const { w } = watch(source);
  w.setShare(true);
  w.setStatus({ on: true, browsers: true });
  w.stopAll();
  assert.equal(source.stops, 1);
  assert.equal(w.sharing, false);
  assert.equal(w.statusState.health, "off");
});

// ------------------------------------------------------------------ the PowerShell side

test("the script lists every session with its status, Spotify's window, JSON deep enough", () => {
  const script = buildScript(5);
  assert.match(script, /source = 'sessions'/);
  assert.match(script, /PlaybackStatus/);
  assert.match(script, /SourceAppUserModelId/);
  assert.match(script, /-Depth 4/);
  assert.match(script, /\$initError/);
});

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

test("PowerShell source: failures are reported, with stderr's tail, instead of silence", async () => {
  const children: FakeChild[] = [];
  const timers: (() => void)[] = [];
  const source = new PowerShellSource({
    spawn: () => {
      const c = new FakeChild();
      children.push(c);
      return c as unknown as ChildProcess;
    },
    setTimer: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimer: () => undefined,
    log: () => undefined,
  });
  const health: SourceHealth[] = [];
  source.start(
    () => undefined,
    (h) => health.push(h),
  );
  for (let i = 0; i <= MAX_RESTARTS; i++) {
    const child = children.at(-1)!;
    child.stderr.write("Add-Type : Cannot add type.\r\n");
    await new Promise((r) => setImmediate(r));
    child.exitCode = 1;
    child.emit("exit", 1);
    if (i < MAX_RESTARTS) timers.at(-1)!();
  }
  assert.equal(health.length, 1);
  assert.match(health[0]!.message, /okuyucu 4 kez kapandı \(çıkış kodu 1\): .*Cannot add type/);

  const throwing = new PowerShellSource({
    spawn: () => {
      throw new Error("spawn powershell.exe ENOENT");
    },
    log: () => undefined,
  });
  const got: SourceHealth[] = [];
  throwing.start(
    () => undefined,
    (h) => got.push(h),
  );
  assert.equal(got[0]?.message, "PowerShell başlatılamadı (spawn powershell.exe ENOENT)");
});
