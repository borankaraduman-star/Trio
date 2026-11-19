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

export interface NowPlayingSource {
  /** Begin reporting raw records (`fromSourceRecord`'s input) to `onRaw`. */
  start(onRaw: (raw: unknown) => void): void;
  /** Stop and forget; nothing is reported after this returns. */
  stop(): void;
}

/** The page-facing half: watch on/off, emit cleaned values on change only. */
export class NowPlayingWatcher {
  private on = false;
  private current: NowPlaying | null = null;
  /** Bumped on every start/stop: a late record from an old run is dropped. */
  private generation = 0;

  constructor(
    private readonly source: NowPlayingSource | null,
    private readonly emit: (info: NowPlaying | null) => void,
  ) {}

  get watching(): boolean {
    return this.on;
  }

  setWatch(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    this.current = null;
    const generation = ++this.generation;
    if (!this.source) return;
    if (!on) {
      this.source.stop();
      return;
    }
    this.source.start((raw) => {
      if (!this.on || generation !== this.generation) return;
      const next = fromSourceRecord(raw);
      if (sameNowPlaying(next, this.current)) return;
      this.current = next;
      this.emit(next);
    });
  }

  dispose(): void {
    this.setWatch(false);
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
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation${"`"}1'
  } | Select-Object -First 1
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties,Windows.Media.Control,ContentType=WindowsRuntime]
} catch { $asTask = $null }
function Wait-Op($op, [Type]$type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  if ($task.Wait(2000)) { return $task.Result }
  return $null
}
if ($asTask) {
  try {
    $manager = Wait-Op ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  } catch { $manager = $null }
}
$last = ''
while ($true) {
  if (-not (Get-Process -Id $parentPid -ErrorAction SilentlyContinue)) { exit 0 }
  $out = $null
  if ($manager) {
    try {
      $sessions = @()
      $current = $manager.GetCurrentSession()
      if ($current) { $sessions += $current }
      $sessions += @($manager.GetSessions())
      foreach ($s in $sessions) {
        if ($s.GetPlaybackInfo().PlaybackStatus -ne 'Playing') { continue }
        $p = Wait-Op ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
        if ($p -and $p.Title) {
          $out = [ordered]@{ source = 'session'; title = [string]$p.Title; artist = [string]$p.Artist; app = [string]$s.SourceAppUserModelId }
          break
        }
      }
    } catch { $out = $null }
  }
  if (-not $out) {
    try {
      $w = Get-Process -Name Spotify -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | Select-Object -First 1 -ExpandProperty MainWindowTitle
      if ($w) { $out = [ordered]@{ source = 'spotify-window'; title = [string]$w } }
    } catch { $out = $null }
  }
  if ($out) { $json = ConvertTo-Json -InputObject $out -Compress } else { $json = 'null' }
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
  private restarts = 0;
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

  start(onRaw: (raw: unknown) => void): void {
    this.stop();
    this.onRaw = onRaw;
    this.restarts = 0;
    this.launch();
  }

  stop(): void {
    this.onRaw = null;
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
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch (error) {
      this.log(`[trio] now playing: powershell did not start: ${String(error)}`);
      this.child = null;
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
    child.on("error", (error) => this.log(`[trio] now playing: ${String(error)}`));
    child.on("exit", () => {
      if (this.child !== child) return; // stopped on purpose
      this.child = null;
      // Whatever it said last is no longer known.
      this.onRaw?.(null);
      if (!this.onRaw || this.restarts >= MAX_RESTARTS) return;
      this.restarts++;
      this.timer = this.setTimer(() => {
        this.timer = null;
        this.launch();
      }, RESTART_DELAY_MS);
    });
  }
}

/** The source for this platform: PowerShell on Windows, none elsewhere. */
export function defaultSource(platform: string = process.platform): NowPlayingSource | null {
  return platform === "win32" ? new PowerShellSource() : null;
}
