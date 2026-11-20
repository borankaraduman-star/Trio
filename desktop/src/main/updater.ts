/**
 * CONTRACT-V10-UPDATE: the shell's own update cycle around electron-updater.
 *
 * electron-updater does the network, the sha512 check and the install; this
 * controller decides WHEN (shortly after start, then about hourly, on waking
 * from sleep and on showing the window again, and whenever the page asks; a
 * check and a download also run during a voice call, a restart never does),
 * WHAT is acceptable (strictly newer than the running version, metadata naming
 * plain asset files of the pinned release) and what the page is told. The updater is injected, so the tests drive a
 * fake one; `main.ts` passes electron-updater's platform updater.
 *
 * electron-updater's own `autoDownload` is always off: a found update is only
 * downloaded after the checks below, by this controller.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  CHECK_INTERVAL_MS,
  CHECK_JITTER_MS,
  FIRST_CHECK_DELAY_MS,
  START_INSTALL_CHECK_DELAY_MS,
  START_INSTALL_WINDOW_MS,
  WAKE_MIN_GAP_MS,
  errorReason,
  isNewer,
  updateFilesAcceptable,
  type Capability,
  type DownloadPlatform,
  type UpdateState,
} from "../shared/update";

/** The part of electron-updater's AppUpdater this controller uses. */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowDowngrade: boolean;
  on(event: "download-progress", listener: (info: { percent?: number }) => void): unknown;
  on(event: "error", listener: (error: unknown) => void): unknown;
  checkForUpdates(): Promise<{ updateInfo?: { version?: unknown; files?: unknown } } | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

const realTimers: Timers = {
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

interface StoredSettings {
  autoDownload: boolean;
  /** A version downloaded and verified in this or an earlier run, not yet installed. */
  readyVersion: string | null;
  /** The version a start already tried to install (never twice: no restart loop). */
  startInstallTried: string | null;
}

/**
 * `<userData>/trio-update.json`: the "download automatically" switch, and which
 * downloaded version is waiting to be installed (so the next start can do it).
 */
export class UpdateSettingsStore {
  private readonly file: string;

  constructor(directory: string) {
    this.file = path.join(directory, "trio-update.json");
  }

  private read(): StoredSettings {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<string, unknown>;
      const text = (value: unknown) => (typeof value === "string" && value.length <= 64 ? value : null);
      return {
        autoDownload: raw.autoDownload !== false,
        readyVersion: text(raw.readyVersion),
        startInstallTried: text(raw.startInstallTried),
      };
    } catch {
      return { autoDownload: true, readyVersion: null, startInstallTried: null };
    }
  }

  private write(patch: Partial<StoredSettings>): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ ...this.read(), ...patch }, null, 2), "utf8");
      fs.renameSync(tmp, this.file);
    } catch (error) {
      console.warn("[trio] update settings not saved", error);
    }
  }

  getAutoDownload(): boolean {
    return this.read().autoDownload;
  }

  setAutoDownload(on: boolean): void {
    this.write({ autoDownload: on });
  }

  getReadyVersion(): string | null {
    return this.read().readyVersion;
  }

  setReadyVersion(version: string | null): void {
    if (this.read().readyVersion !== version) this.write({ readyVersion: version });
  }

  getStartInstallTried(): string | null {
    return this.read().startInstallTried;
  }

  setStartInstallTried(version: string): void {
    this.write({ startInstallTried: version });
  }
}

export interface SettingsLike {
  getAutoDownload(): boolean;
  setAutoDownload(on: boolean): void;
  getReadyVersion(): string | null;
  setReadyVersion(version: string | null): void;
  getStartInstallTried(): string | null;
  setStartInstallTried(version: string): void;
}

export type InstallAnswer = { ok: true } | { ok: false; reason: "not-ready" | "in-voice" | "manual" };

export interface UpdateControllerOptions {
  capability: Capability;
  currentVersion: string;
  platform: DownloadPlatform | null;
  settings: SettingsLike;
  /** Only called when capability is auto (electron-updater is never loaded otherwise). */
  createUpdater: () => UpdaterLike;
  onState: (state: UpdateState) => void;
  /** Called right before quitAndInstall: the shell marks itself as quitting. */
  beforeInstall: () => void;
  timers?: Timers;
  /** 0 ≤ x < 1, for the jitter (Math.random). */
  random?: () => number;
  log?: Pick<Console, "info" | "warn">;
}

export class UpdateController {
  private readonly timers: Timers;
  private readonly log: Pick<Console, "info" | "warn">;
  private updater: UpdaterLike | null = null;
  private state: UpdateState;
  private timer: unknown = null;
  private started = false;
  private startedAt = 0;
  private busy = false;
  /** When the last check started (finished or not): wake-ups are measured from it. */
  private lastCheckAt: number | null = null;
  /** A version downloaded in an earlier run that this start may install (§4, "next start"). */
  private installOnStart: string | null = null;

  constructor(private readonly options: UpdateControllerOptions) {
    this.timers = options.timers ?? realTimers;
    this.log = options.log ?? console;
    const auto = options.capability.kind === "auto";
    this.state = {
      capability: auto ? "auto" : "manual",
      reason: options.capability.kind === "manual" ? options.capability.reason : null,
      platform: options.platform,
      currentVersion: options.currentVersion,
      autoDownload: options.settings.getAutoDownload(),
      status: auto ? "idle" : "manual",
      version: null,
      percent: null,
      error: null,
      checkedAt: null,
      inVoice: false,
    };
  }

  get snapshot(): UpdateState {
    return { ...this.state };
  }

  /** Starts the schedule (first check after a short delay). No-op where self-update is impossible. */
  start(): void {
    if (this.started || this.state.capability !== "auto") return;
    this.started = true;
    try {
      const updater = this.options.createUpdater();
      updater.autoDownload = false; // this controller downloads, after its own checks
      updater.autoInstallOnAppQuit = true; // a ready update is applied when the app quits
      updater.allowDowngrade = false;
      updater.on("download-progress", (info) => this.progress(info?.percent));
      // An EventEmitter "error" without a listener would throw; the promises carry the errors.
      updater.on("error", (error) => this.log.warn(`[trio] updater: ${errorReason(error)}`));
      this.updater = updater;
    } catch (error) {
      this.log.warn("[trio] updater unavailable", error);
      this.set({ capability: "manual", reason: "no-config", status: "manual" });
      return;
    }
    this.startedAt = this.timers.now();
    const waiting = this.options.settings.getReadyVersion();
    if (waiting && !isNewer(waiting, this.state.currentVersion)) {
      // Installed meanwhile (on quit, or by hand): nothing waits any more.
      this.options.settings.setReadyVersion(null);
    } else if (waiting && this.options.settings.getStartInstallTried() !== waiting) {
      this.installOnStart = waiting;
    }
    this.schedule(this.installOnStart ? START_INSTALL_CHECK_DELAY_MS : FIRST_CHECK_DELAY_MS);
  }

  dispose(): void {
    this.clearTimer();
  }

  /**
   * The page's voice state (`setVoiceState`). It only governs the restart:
   * checks and downloads go on during a call (a download competes with the
   * call's incoming media only on a saturated line, and Windows usually
   * fetches only the changed blocks).
   */
  setInVoice(inVoice: boolean): void {
    if (inVoice === this.state.inVoice) return;
    this.set({ inVoice });
  }

  /**
   * Woken from sleep, or the window shown again from the tray: check now when
   * the last check is older than `WAKE_MIN_GAP_MS` (a laptop asleep all night
   * has missed the hourly ones).
   */
  wake(): void {
    if (!this.updater || this.busy) return;
    const now = this.timers.now();
    if (this.lastCheckAt !== null && now - this.lastCheckAt >= 0 && now - this.lastCheckAt < WAKE_MIN_GAP_MS) return;
    this.schedule(0);
  }

  setAutoDownload(on: boolean): void {
    if (on === this.state.autoDownload) return;
    this.options.settings.setAutoDownload(on);
    this.set({ autoDownload: on });
    if (on && this.state.status === "available") void this.automaticDownload();
  }

  /** "Güncellemeleri denetle", and the page's "look now" (§4a): always allowed, also during a call. */
  async checkNow(): Promise<UpdateState> {
    await this.check(true);
    return this.snapshot;
  }

  /** "İndir" with automatic download off (or after a failed download). */
  async downloadNow(): Promise<UpdateState> {
    if (this.state.status === "available" || (this.state.status === "error" && this.state.version)) {
      await this.download();
    }
    return this.snapshot;
  }

  /** "Yeniden başlat ve güncelle". Refused during a voice call. */
  install(): InstallAnswer {
    if (this.state.capability !== "auto" || !this.updater) return { ok: false, reason: "manual" };
    if (this.state.status !== "ready") return { ok: false, reason: "not-ready" };
    if (this.state.inVoice) return { ok: false, reason: "in-voice" };
    this.set({ status: "installing" });
    this.options.beforeInstall();
    // Silent (no installer pages on Windows) and start the new version afterwards.
    this.updater.quitAndInstall(true, true);
    return { ok: true };
  }

  // ------------------------------------------------------------ internals

  private schedule(ms: number): void {
    this.clearTimer();
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, ms);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    this.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    await this.check(false);
    const random = this.options.random ?? Math.random;
    this.schedule(CHECK_INTERVAL_MS + Math.floor(Math.max(0, Math.min(0.999, random())) * CHECK_JITTER_MS));
  }

  private async check(manual: boolean): Promise<void> {
    const updater = this.updater;
    if (!updater || this.busy) return;
    const status = this.state.status;
    if (status === "downloading" || status === "ready" || status === "installing") return;
    this.busy = true;
    this.lastCheckAt = this.timers.now();
    this.set({ status: "checking", error: null, percent: null });
    try {
      const result = await updater.checkForUpdates();
      const info = result?.updateInfo;
      const version = typeof info?.version === "string" ? info.version : null;
      const checkedAt = this.timers.now();
      if (!version || !isNewer(version, this.state.currentVersion)) {
        // Older or the same: never a downgrade, never the same build again.
        this.set({ status: "up-to-date", version: null, checkedAt });
        return;
      }
      if (!updateFilesAcceptable(info?.files)) {
        this.log.warn(`[trio] update ${version} refused: its metadata names files outside the release`);
        this.set({ status: "error", version: null, error: errorReason({ code: "TRIO_REFUSED_METADATA" }), checkedAt });
        return;
      }
      this.set({ status: "available", version, checkedAt });
    } catch (error) {
      this.set({ status: "error", error: errorReason(error), checkedAt: this.timers.now() });
      return;
    } finally {
      this.busy = false;
    }
    // Manual or automatic, in a call or not: a found update downloads (§4).
    void manual;
    if (this.state.autoDownload) await this.download();
  }

  private async automaticDownload(): Promise<void> {
    await this.download();
  }

  private async download(): Promise<void> {
    const updater = this.updater;
    const version = this.state.version;
    if (!updater || !version || this.busy) return;
    this.busy = true;
    this.set({ status: "downloading", percent: 0, error: null });
    try {
      // electron-updater compares the file's sha512 with latest*.yml and
      // throws on a mismatch; nothing unverified becomes "ready".
      await updater.downloadUpdate();
      this.set({ status: "ready", percent: 100 });
      this.options.settings.setReadyVersion(version);
      this.maybeInstallOnStart(version);
    } catch (error) {
      this.set({ status: "error", percent: null, error: errorReason(error) });
    } finally {
      this.busy = false;
    }
  }

  /**
   * An update downloaded in an earlier run (the app was never quit: Windows
   * shut down, or it was killed) is installed by the next start, once: right
   * after start, before the user is in a call. Tried once per version, so an
   * installer that fails cannot loop the app.
   */
  private maybeInstallOnStart(version: string): void {
    const wanted = this.installOnStart;
    this.installOnStart = null;
    if (!wanted || !(version === wanted || isNewer(version, wanted)) || this.state.inVoice) return;
    if (this.timers.now() - this.startedAt > START_INSTALL_WINDOW_MS) return;
    this.options.settings.setStartInstallTried(version);
    this.log.info(`[trio] installing ${version}, downloaded in an earlier run`);
    this.install();
  }

  private progress(percent: unknown): void {
    if (this.state.status !== "downloading" || typeof percent !== "number" || !Number.isFinite(percent)) return;
    const rounded = Math.max(0, Math.min(99, Math.floor(percent)));
    if (rounded !== this.state.percent) this.set({ percent: rounded });
  }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch };
    try {
      this.options.onState(this.snapshot);
    } catch (error) {
      this.log.warn("[trio] update state not sent", error);
    }
  }
}
