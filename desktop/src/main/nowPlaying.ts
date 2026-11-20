/**
 * CONTRACT-V8-MUSIC §5: "Şu an çalıyor" in the main process.
 *
 * Windows: one hidden PowerShell process (Windows PowerShell 5.1, part of
 * every Windows 10/11) runs ONLY while the page has the watch on. It reads the
 * system media session (WinRT
 * `Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager`:
 * Spotify, browsers, the Media Player app all publish to it), falling back to
 * Spotify's main window title ("Artist - Song"), every 3 s, and prints one
 * JSON line only when the answer changed. No native module, no npm package,
 * no file on disk (the script goes in `-EncodedCommand`), `windowsHide` so no
 * console window flashes, and it exits by itself if Trio's process is gone.
 *
 * Why not a native addon: every maintained GSMTC binding needs prebuilt
 * binaries per Electron ABI, which is exactly the fragility the game watcher
 * avoided by spawning `tasklist`. The cost here is a PowerShell process
 * (~40–60 MB) for as long as a music share runs.
 *
 * macOS/Linux: no source; the watcher never emits (the page treats that as
 * "no title" and offers the editable text instead).
 *
 * No Electron import: main.ts wires it; tests drive the watcher with a fake
 * source and the PowerShell source with a fake spawn.
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { fromSourceRecord, sameNowPlaying, type NowPlaying } from "../shared/nowPlaying";
import {
  FAILED_PREFIX,
  ListeningTracker,
  readSessions,
  sameState,
  shareValue,
  type ListeningHealth,
  type ListeningState,
} from "../shared/listening";

export interface SourceHealth {
  /** "failed": the reader is not running and will not come back by itself. */
  state: "failed";
  message: string;
}

export interface NowPlayingSource {
  /** Begin reporting raw records (`fromSourceRecord`'s input) to `onRaw`. */
  start(onRaw: (raw: unknown) => void, onHealth?: (health: SourceHealth) => void): void;
  /** Stop and forget; nothing is reported after this returns. */
  stop(): void;
}

export interface StatusWish {
  on: boolean;
  browsers: boolean;
}

export interface MediaWatchOptions {
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * CONTRACT-V11-ACTIVITY §5: ONE reader for two wishes — the V8 share watch
 * (`setShare`) and the status (`setStatus`). The source runs while either is
 * on. The last reading is kept, so a wish that turns on while the reader
 * already runs gets its answer at once (the reader prints only on change).
 */
export class MediaWatch {
  private share = false;
  private status: StatusWish = { on: false, browsers: false };
  private running = false;
  private generation = 0;
  private lastRaw: unknown = undefined;
  private shareValue: NowPlaying | null = null;
  private state: ListeningState = { playing: null, health: "off" };
  private failure: string | null = null;
  private readonly tracker: ListeningTracker;
  private holdTimer: unknown = null;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(
    private readonly source: NowPlayingSource | null,
    private readonly emitShare: (info: NowPlaying | null) => void,
    private readonly emitStatus: (state: ListeningState) => void,
    options: MediaWatchOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
    this.tracker = new ListeningTracker(this.now);
  }

  get sharing(): boolean {
    return this.share;
  }

  get statusState(): ListeningState {
    return this.state;
  }

  setShare(on: boolean): void {
    if (on === this.share) return;
    this.share = on;
    this.shareValue = null;
    this.reconcile();
    // A wish joining a running reader: answer from the last reading.
    if (on && this.running && this.lastRaw !== undefined) this.evaluate();
  }

  setStatus(wish: StatusWish): void {
    const next = { on: wish.on === true, browsers: wish.browsers === true };
    if (next.on === this.status.on && next.browsers === this.status.browsers) return;
    const wasOn = this.status.on;
    this.status = next;
    if (!next.on) {
      this.tracker.reset();
      this.publish({ playing: null, health: "off" });
    } else if (!wasOn) {
      this.tracker.reset();
      this.failure = null;
    }
    this.reconcile();
    if (next.on) this.evaluate();
  }

  stopAll(): void {
    this.share = false;
    this.shareValue = null;
    this.status = { on: false, browsers: false };
    this.tracker.reset();
    this.state = { playing: null, health: "off" };
    this.reconcile();
  }

  dispose(): void {
    this.stopAll();
  }

  private reconcile(): void {
    const want = this.share || this.status.on;
    if (want === this.running) return;
    this.running = want;
    const generation = ++this.generation;
    this.lastRaw = undefined;
    this.failure = null;
    if (!this.source) return;
    if (!want) {
      if (this.holdTimer !== null) this.clearTimer(this.holdTimer);
      this.holdTimer = null;
      this.source.stop();
      return;
    }
    this.source.start(
      (raw) => {
        if (!this.running || generation !== this.generation) return;
        this.lastRaw = raw;
        this.failure = null;
        this.evaluate();
      },
      (health) => {
        if (!this.running || generation !== this.generation) return;
        this.failure = health.message;
        this.lastRaw = null;
        this.evaluate();
      },
    );
  }

  private evaluate(): void {
    const raw = this.lastRaw;
    const reading = readSessions(raw);
    if (this.share) {
      const next = reading ? shareValue(reading) : fromSourceRecord(raw);
      if (!sameNowPlaying(next, this.shareValue)) {
        this.shareValue = next;
        this.emitShare(next);
      }
    }
    if (!this.status.on) return;
    if (!this.source) {
      this.publish({ playing: null, health: "unsupported", message: "Bu sistemde otomatik algılanamıyor." });
      return;
    }
    const playing = this.tracker.update(reading, this.status.browsers);
    let health: ListeningHealth = "ok";
    let message: string | undefined;
    if (this.failure) {
      health = "failed";
      message = `${FAILED_PREFIX}: ${this.failure}`;
    } else if (raw === undefined) {
      health = "starting";
    } else if (reading && !reading.winrt) {
      health = "limited";
      message = `Windows medya oturumu okunamadı; yalnızca Spotify penceresi okunuyor${reading.error ? ` (${reading.error})` : ""}.`;
    } else if (raw !== null && !reading) {
      health = "limited";
      message = `${FAILED_PREFIX}: okuyucu beklenmeyen bir yanıt verdi.`;
    }
    const state: ListeningState = { playing, health };
    if (message) state.message = message;
    if (this.tracker.lastApp) state.lastApp = { ...this.tracker.lastApp };
    this.publish(state);
    // A held (paused) song ends after PAUSE_HOLD_MS even if the reader stays quiet.
    if (this.holdTimer !== null) this.clearTimer(this.holdTimer);
    this.holdTimer = null;
    const ends = this.tracker.holdEndsAt();
    if (ends !== null) {
      this.holdTimer = this.setTimer(() => {
        this.holdTimer = null;
        if (this.status.on) this.evaluate();
      }, Math.max(0, ends - this.now()) + 10);
    }
  }

  private publish(state: ListeningState): void {
    if (sameState(state, this.state)) return;
    this.state = state;
    this.emitStatus(state);
  }
}

/** V8's page-facing half, now one wish of MediaWatch: watch on/off, emit on change only. */
export class NowPlayingWatcher {
  private readonly watch: MediaWatch;

  constructor(source: NowPlayingSource | null, emit: (info: NowPlaying | null) => void) {
    this.watch = new MediaWatch(source, emit, () => undefined);
  }

  get watching(): boolean {
    return this.watch.sharing;
  }

  setWatch(on: boolean): void {
    this.watch.setShare(on);
  }

  dispose(): void {
    this.watch.dispose();
  }
}

export const POLL_SECONDS = 3;
/** A single line longer than this is junk, not a record. */
export const MAX_LINE = 8 * 1024;
/** Restarts after an unexpected exit, before giving up until the next watch. */
export const MAX_RESTARTS = 3;
export const RESTART_DELAY_MS = 10_000;

/** The helper script. `$parentPid` is substituted by `buildScript`. */
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$parentPid = __PARENT_PID__
$manager = $null
$asTask = $null
$initError = $null
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation${"`"}1'
  } | Select-Object -First 1
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties,Windows.Media.Control,ContentType=WindowsRuntime]
} catch { $asTask = $null; $initError = [string]$_.Exception.Message }
function Wait-Op($op, [Type]$type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  if ($task.Wait(2000)) { return $task.Result }
  return $null
}
if ($asTask) {
  try {
    $manager = Wait-Op ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  } catch { $manager = $null; $initError = [string]$_.Exception.Message }
}
$last = ''
while ($true) {
  if (-not (Get-Process -Id $parentPid -ErrorAction SilentlyContinue)) { exit 0 }
  $list = @()
  $err = $initError
  if ($manager) {
    try {
      $sessions = @()
      $current = $manager.GetCurrentSession()
      if ($current) { $sessions += $current }
      $sessions += @($manager.GetSessions())
      $n = 0
      foreach ($s in $sessions) {
        if ($n -ge 8) { break }
        $n++
        $status = [string]$s.GetPlaybackInfo().PlaybackStatus
        $title = ''
        $artist = ''
        if ($status -eq 'Playing' -or $status -eq 'Paused') {
          $p = Wait-Op ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
          if ($p) { $title = [string]$p.Title; $artist = [string]$p.Artist }
        }
        $list += [ordered]@{ app = [string]$s.SourceAppUserModelId; status = $status; title = $title; artist = $artist }
      }
    } catch { $err = [string]$_.Exception.Message }
  }
  $spotify = $null
  try {
    $w = Get-Process -Name Spotify -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | Select-Object -First 1 -ExpandProperty MainWindowTitle
    if ($w) { $spotify = [string]$w }
  } catch { $spotify = $null }
  $out = [ordered]@{ source = 'sessions'; winrt = [bool]$manager; sessions = @($list); spotify = $spotify }
  if ($err) { $out.error = $err.Substring(0, [Math]::Min(200, $err.Length)) }
  $json = ConvertTo-Json -InputObject $out -Compress -Depth 4
  if ($json -ne $last) {
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
    $last = $json
  }
  Start-Sleep -Seconds __POLL_SECONDS__
}
`;

export function buildScript(parentPid: number): string {
  if (!Number.isInteger(parentPid) || parentPid <= 0) throw new Error("bad pid");
  return SCRIPT.replace("__PARENT_PID__", String(parentPid)).replace("__POLL_SECONDS__", String(POLL_SECONDS));
}

/** PowerShell's -EncodedCommand: base64 of UTF-16LE. */
export function encodeCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

export function powerShellArgs(parentPid: number): string[] {
  return [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-WindowStyle",
    "Hidden",
    "-EncodedCommand",
    encodeCommand(buildScript(parentPid)),
  ];
}

/** Splits stdout into lines and parses each as JSON; junk is dropped. */
export class LineReader {
  private buffer = "";
  constructor(private readonly onRecord: (raw: unknown) => void) {}

  push(chunk: string): void {
    this.buffer += chunk;
    let cut: number;
    while ((cut = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, cut).replace(/^﻿/, "").trim();
      this.buffer = this.buffer.slice(cut + 1);
      if (line.length === 0 || line.length > MAX_LINE) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      this.onRecord(parsed);
    }
    if (this.buffer.length > MAX_LINE) this.buffer = "";
  }
}

export type SpawnFn = (file: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface PowerShellSourceOptions {
  spawn?: SpawnFn;
  parentPid?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  log?: (message: string) => void;
}

export class PowerShellSource implements NowPlayingSource {
  private child: ChildProcess | null = null;
  private onRaw: ((raw: unknown) => void) | null = null;
  private onHealth: ((health: SourceHealth) => void) | null = null;
  private restarts = 0;
  /** The tail of the helper's stderr, for the failure message. */
  private stderrTail = "";
  private timer: unknown = null;
  private readonly spawnFn: SpawnFn;
  private readonly parentPid: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly log: (message: string) => void;

  constructor(options: PowerShellSourceOptions = {}) {
    this.spawnFn = options.spawn ?? nodeSpawn;
    this.parentPid = options.parentPid ?? process.pid;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
    this.log = options.log ?? ((m) => console.warn(m));
  }

  get running(): boolean {
    return this.child !== null;
  }

  start(onRaw: (raw: unknown) => void, onHealth?: (health: SourceHealth) => void): void {
    this.stop();
    this.onRaw = onRaw;
    this.onHealth = onHealth ?? null;
    this.restarts = 0;
    this.stderrTail = "";
    this.launch();
  }

  stop(): void {
    this.onRaw = null;
    this.onHealth = null;
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null && !child.killed) child.kill();
  }

  private launch(): void {
    if (!this.onRaw) return;
    let child: ChildProcess;
    try {
      child = this.spawnFn("powershell.exe", powerShellArgs(this.parentPid), {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      this.log(`[trio] now playing: powershell did not start: ${String(error)}`);
      this.child = null;
      this.onHealth?.({ state: "failed", message: `PowerShell başlatılamadı (${shortError(error)})` });
      return;
    }
    this.child = child;
    const reader = new LineReader((raw) => {
      if (this.child !== child || !this.onRaw) return;
      this.restarts = 0;
      this.onRaw(raw);
    });
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string | Buffer) => reader.push(String(chunk)));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string | Buffer) => {
      this.stderrTail = (this.stderrTail + String(chunk)).slice(-400);
    });
    child.on("error", (error) => {
      this.log(`[trio] now playing: ${String(error)}`);
      if (this.child !== child) return;
      this.child = null;
      this.onHealth?.({ state: "failed", message: `PowerShell başlatılamadı (${shortError(error)})` });
    });
    child.on("exit", (code: number | null) => {
      if (this.child !== child) return; // stopped on purpose
      this.child = null;
      // Whatever it said last is no longer known.
      this.onRaw?.(null);
      if (!this.onRaw) return;
      if (this.restarts >= MAX_RESTARTS) {
        const tail = this.stderrTail.replace(/\s+/g, " ").trim().slice(-160);
        this.onHealth?.({
          state: "failed",
          message: `okuyucu ${MAX_RESTARTS + 1} kez kapandı (çıkış kodu ${code ?? "?"})${tail ? `: ${tail}` : ""}`,
        });
        return;
      }
      this.restarts++;
      this.timer = this.setTimer(() => {
        this.timer = null;
        this.launch();
      }, RESTART_DELAY_MS);
    });
  }
}

function shortError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, " ").trim().slice(0, 120) || "bilinmeyen hata";
}

/** The source for this platform: PowerShell on Windows, none elsewhere. */
export function defaultSource(platform: string = process.platform): NowPlayingSource | null {
  return platform === "win32" ? new PowerShellSource() : null;
}
