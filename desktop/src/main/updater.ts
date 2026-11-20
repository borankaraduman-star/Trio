/**
 * CONTRACT-V10-UPDATE: the shell's own update cycle around electron-updater.
 *
 * electron-updater does the network, the sha512 check and the install; this
 * controller decides WHEN (a delay after start, then every few hours, never
 * an automatic check or download while the page says the user is in a voice
 * room, never a restart then), WHAT is acceptable (strictly newer than the
 * running version, metadata naming plain asset files of the pinned release)
 * and what the page is told. The updater is injected, so the tests drive a
 * fake one; `main.ts` passes electron-updater's platform updater.
 *
 * electron-updater's own `autoDownload` is always off: a found update is only
 * downloaded after the checks below, by this controller.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  AFTER_CALL_DELAY_MS,
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
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

/** `<userData>/trio-update.json`: only the "download automatically" switch. */
export class UpdateSettingsStore {
  private readonly file: string;

  constructor(directory: string) {
    this.file = path.join(directory, "trio-update.json");
  }

  getAutoDownload(): boolean {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as { autoDownload?: unknown };
      return raw.autoDownload !== false;
    } catch {
      return true;
    }
  }

  setAutoDownload(on: boolean): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ autoDownload: on }, null, 2), "utf8");
      fs.renameSync(tmp, this.file);
    } catch (error) {
      console.warn("[trio] update settings not saved", error);
    }
  }
}

export interface SettingsLike {
  getAutoDownload(): boolean;
  setAutoDownload(on: boolean): void;
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
  log?: Pick<Console, "info" | "warn">;
}

export class UpdateController {
  private readonly timers: Timers;
  private readonly log: Pick<Console, "info" | "warn">;
  private updater: UpdaterLike | null = null;
  private state: UpdateState;
  private timer: unknown = null;
  /** An automatic check or download came due during a call. */
  private deferred: "check" | "download" | null = null;
  private started = false;
  private busy = false;

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
    this.schedule(FIRST_CHECK_DELAY_MS);
  }

  dispose(): void {
    this.clearTimer();
  }

  /** The page's voice state (`setVoiceState`). Leaving a call runs what was deferred, a minute later. */
  setInVoice(inVoice: boolean): void {
    if (inVoice === this.state.inVoice) return;
    this.set({ inVoice });
    if (!inVoice && this.deferred && this.updater) this.schedule(AFTER_CALL_DELAY_MS);
  }

  setAutoDownload(on: boolean): void {
    if (on === this.state.autoDownload) return;
    this.options.settings.setAutoDownload(on);
    this.set({ autoDownload: on });
    if (on && this.state.status === "available") void this.automaticDownload();
  }

  /** "Güncellemeleri denetle": always allowed, also during a call (the user asked). */
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
    if (this.deferred === "download" && !this.state.inVoice && this.state.status === "available") {
      this.deferred = null;
      await this.automaticDownload();
    } else {
      await this.check(false);
    }
    this.schedule(CHECK_INTERVAL_MS);
  }

  private async check(manual: boolean): Promise<void> {
    const updater = this.updater;
    if (!updater || this.busy) return;
    const status = this.state.status;
    if (status === "downloading" || status === "ready" || status === "installing") return;
    if (!manual && this.state.inVoice) {
      this.deferred = "check";
      return;
    }
    this.deferred = null;
    this.busy = true;
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
    if (this.state.autoDownload) {
      if (manual || !this.state.inVoice) await this.download();
      else this.deferred = "download";
    }
  }

  private async automaticDownload(): Promise<void> {
    if (this.state.inVoice) {
      this.deferred = "download";
      return;
    }
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
    } catch (error) {
      this.set({ status: "error", percent: null, error: errorReason(error) });
    } finally {
      this.busy = false;
    }
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
