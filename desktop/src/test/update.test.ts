import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { UpdateController, UpdateSettingsStore, type Timers, type UpdaterLike } from "../main/updater";
import {
  AFTER_CALL_DELAY_MS,
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  compareVersions,
  downloadPlatform,
  errorReason,
  isNewer,
  updateCapability,
  updateFilesAcceptable,
  type Capability,
  type UpdateState,
} from "../shared/update";

const SHA = "x".repeat(88);
const files = (version: string) => [{ url: `Trio-${version}-win-x64.exe`, sha512: SHA, size: 1 }];

// ------------------------------------------------------------- capability

test("capability matrix: Windows NSIS and AppImage update themselves; unsigned mac, dev, portable and plain Linux do not", () => {
  const base = { isPackaged: true, env: {}, hasUpdateConfig: true, macSigned: false };
  assert.deepEqual(updateCapability({ ...base, platform: "win32" }), { kind: "auto" });
  assert.deepEqual(updateCapability({ ...base, platform: "win32", env: { PORTABLE_EXECUTABLE_DIR: "C:\\x" } }), {
    kind: "manual",
    reason: "portable",
  });
  assert.deepEqual(updateCapability({ ...base, platform: "linux" }), { kind: "manual", reason: "not-appimage" });
  assert.deepEqual(updateCapability({ ...base, platform: "linux", env: { APPIMAGE: "/home/a/Trio.AppImage" } }), {
    kind: "auto",
  });
  assert.deepEqual(updateCapability({ ...base, platform: "darwin" }), { kind: "manual", reason: "unsigned-mac" });
  assert.deepEqual(updateCapability({ ...base, platform: "darwin", macSigned: true }), { kind: "auto" });
  assert.deepEqual(updateCapability({ ...base, platform: "win32", isPackaged: false }), { kind: "manual", reason: "dev" });
  assert.deepEqual(updateCapability({ ...base, platform: "win32", hasUpdateConfig: false }), {
    kind: "manual",
    reason: "no-config",
  });
  assert.deepEqual(updateCapability({ ...base, platform: "freebsd" }), { kind: "manual", reason: "unsupported" });
});

test("download platform words match /api/downloads", () => {
  assert.equal(downloadPlatform("win32", "x64"), "windows");
  assert.equal(downloadPlatform("darwin", "arm64"), "mac-arm64");
  assert.equal(downloadPlatform("darwin", "x64"), "mac-x64");
  assert.equal(downloadPlatform("linux", "x64"), "linux");
  assert.equal(downloadPlatform("aix", "ppc"), null);
});

// ------------------------------------------------------------- versions

test("versions: only strictly newer is an update", () => {
  assert.equal(isNewer("0.8.0", "0.7.1"), true);
  assert.equal(isNewer("0.7.1", "0.7.1"), false);
  assert.equal(isNewer("0.7.0", "0.7.1"), false);
  assert.equal(isNewer("0.8.0-rc.1", "0.8.0"), false);
  assert.equal(isNewer("0.8.0", "0.8.0-rc.2"), true);
  assert.equal(isNewer("garbage", "0.7.1"), false);
  assert.equal(compareVersions("0.8.0-rc.10", "0.8.0-rc.9")! > 0, true);
});

test("metadata must name plain files of the release with a sha512", () => {
  assert.equal(updateFilesAcceptable(files("0.8.0")), true);
  assert.equal(updateFilesAcceptable([{ url: "Trio-0.8.0-linux-x86_64.AppImage", sha512: SHA }]), true);
  assert.equal(updateFilesAcceptable([{ url: "Trio-0.8.0-mac-arm64.zip", sha512: SHA }]), true);
  assert.equal(updateFilesAcceptable([{ url: "https://evil.example/Trio-0.8.0-win-x64.exe", sha512: SHA }]), false);
  assert.equal(updateFilesAcceptable([{ url: "../Trio-0.8.0-win-x64.exe", sha512: SHA }]), false);
  assert.equal(updateFilesAcceptable([{ url: "Trio-0.8.0-win-x64.exe" }]), false);
  assert.equal(updateFilesAcceptable([]), false);
  assert.equal(updateFilesAcceptable(undefined), false);
});

test("errors become a short Turkish reason, never the raw message", () => {
  assert.equal(errorReason(new Error("getaddrinfo ENOTFOUND github.com")), "internet bağlantısı yok");
  assert.equal(errorReason({ code: "ERR_CHECKSUM_MISMATCH", message: "x" }), "indirilen dosya doğrulanamadı");
  assert.equal(errorReason({ code: "ERR_UPDATER_INVALID_SIGNATURE" }), "yeni sürümün imzası doğrulanamadı");
  assert.equal(errorReason({ code: "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND" }), "sürüm bilgisi bulunamadı");
  assert.equal(errorReason(new Error("C:\\Users\\a\\secret path")), "beklenmeyen bir hata oluştu");
});

// ------------------------------------------------------------- the controller

class FakeTimers implements Timers {
  t = 0;
  private queue: { at: number; cb: () => void; id: number }[] = [];
  private next = 1;
  setTimeout(cb: () => void, ms: number): unknown {
    const id = this.next++;
    this.queue.push({ at: this.t + ms, cb, id });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.queue = this.queue.filter((e) => e.id !== handle);
  }
  now(): number {
    return this.t;
  }
  get pending(): number[] {
    return this.queue.map((e) => e.at - this.t);
  }
  /** Runs every timer due within `ms`, letting promises settle in between. */
  async advance(ms: number): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      this.queue.sort((a, b) => a.at - b.at);
      const first = this.queue[0];
      if (!first || first.at > end) break;
      this.queue.shift();
      this.t = first.at;
      first.cb();
      await flush();
    }
    this.t = end;
    await flush();
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

class FakeUpdater implements UpdaterLike {
  autoDownload = true;
  autoInstallOnAppQuit = false;
  allowDowngrade = true;
  checks = 0;
  downloads = 0;
  installs: [boolean | undefined, boolean | undefined][] = [];
  latest: { version: string; files: unknown } | null = { version: "0.8.0", files: files("0.8.0") };
  checkError: unknown = null;
  downloadError: unknown = null;
  private progress: ((info: { percent?: number }) => void) | null = null;
  /** When set, checkForUpdates waits for it (to join a call mid-check). */
  checkGate: Promise<void> | null = null;
  on(event: string, listener: (arg: never) => void): unknown {
    if (event === "download-progress") this.progress = listener as (info: { percent?: number }) => void;
    return this;
  }
  async checkForUpdates() {
    this.checks++;
    if (this.checkGate) await this.checkGate;
    if (this.checkError) throw this.checkError;
    return this.latest ? { updateInfo: this.latest } : null;
  }
  async downloadUpdate(): Promise<unknown> {
    this.downloads++;
    this.progress?.({ percent: 40.6 });
    await flush();
    if (this.downloadError) throw this.downloadError;
    return [];
  }
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void {
    this.installs.push([isSilent, isForceRunAfter]);
  }
}

function memorySettings(initial = true) {
  let value = initial;
  return { getAutoDownload: () => value, setAutoDownload: (on: boolean) => void (value = on), get value() { return value } };
}

function setup(opts: { capability?: Capability; auto?: boolean; current?: string } = {}) {
  const timers = new FakeTimers();
  const updater = new FakeUpdater();
  const states: UpdateState[] = [];
  const settings = memorySettings(opts.auto ?? true);
  let created = 0;
  let quitting = false;
  const controller = new UpdateController({
    capability: opts.capability ?? { kind: "auto" },
    currentVersion: opts.current ?? "0.7.1",
    platform: "windows",
    settings,
    createUpdater: () => {
      created++;
      return updater;
    },
    onState: (s) => states.push(s),
    beforeInstall: () => {
      quitting = true;
    },
    timers,
    log: { info: () => undefined, warn: () => undefined },
  });
  return { timers, updater, states, controller, settings, created: () => created, quitting: () => quitting };
}

const statuses = (states: UpdateState[]) => states.map((s) => s.status).filter((s, i, a) => s !== a[i - 1]);

test("checking → available → downloading → ready → installing, after a delay at start", async () => {
  const { timers, updater, states, controller, quitting } = setup();
  controller.start();
  assert.equal(updater.autoDownload, false, "electron-updater never downloads on its own");
  assert.equal(updater.autoInstallOnAppQuit, true);
  assert.equal(updater.allowDowngrade, false);
  assert.equal(updater.checks, 0);
  await timers.advance(FIRST_CHECK_DELAY_MS - 1);
  assert.equal(updater.checks, 0, "not right at start");
  await timers.advance(1);
  assert.equal(updater.checks, 1);
  assert.deepEqual(statuses(states), ["checking", "available", "downloading", "ready"]);
  assert.ok(states.some((s) => s.status === "downloading" && s.percent === 40), "progress is shown");
  assert.equal(controller.snapshot.version, "0.8.0");
  assert.deepEqual(controller.install(), { ok: true });
  assert.equal(controller.snapshot.status, "installing");
  assert.deepEqual(updater.installs, [[true, true]]);
  assert.equal(quitting(), true);
});

test("checks again every few hours; up to date says so", async () => {
  const { timers, updater, controller } = setup();
  updater.latest = { version: "0.7.1", files: files("0.7.1") };
  controller.start();
  await timers.advance(FIRST_CHECK_DELAY_MS);
  assert.equal(controller.snapshot.status, "up-to-date");
  assert.equal(controller.snapshot.checkedAt, FIRST_CHECK_DELAY_MS);
  await timers.advance(CHECK_INTERVAL_MS);
  assert.equal(updater.checks, 2);
});

test("a downgrade or the same version is refused, and never downloaded", async () => {
  const { updater, controller } = setup({ current: "0.9.0" });
  controller.start();
  updater.latest = { version: "0.8.0", files: files("0.8.0") };
  await controller.checkNow();
  assert.equal(controller.snapshot.status, "up-to-date");
  assert.equal(updater.downloads, 0);
  assert.deepEqual(controller.install(), { ok: false, reason: "not-ready" });
});

test("metadata pointing outside the release is refused", async () => {
  const { updater, controller } = setup();
  controller.start();
  updater.latest = { version: "0.8.0", files: [{ url: "https://elsewhere.example/x.exe", sha512: SHA }] };
  await controller.checkNow();
  assert.equal(controller.snapshot.status, "error");
  assert.equal(controller.snapshot.error, "sürüm bilgisi kabul edilmedi");
  assert.equal(updater.downloads, 0);
});

test("a check that fails is an error with a reason; the next check can succeed", async () => {
  const { updater, controller } = setup();
  controller.start();
  updater.checkError = new Error("net::ERR_INTERNET_DISCONNECTED");
  await controller.checkNow();
  assert.equal(controller.snapshot.status, "error");
  assert.equal(controller.snapshot.error, "internet bağlantısı yok");
  updater.checkError = null;
  await controller.checkNow();
  assert.equal(controller.snapshot.status, "ready");
});

test("a download whose hash does not match never becomes ready; it can be retried", async () => {
  const { updater, controller } = setup();
  controller.start();
  updater.downloadError = Object.assign(new Error("sha512 checksum mismatch"), { code: "ERR_CHECKSUM_MISMATCH" });
  await controller.checkNow();
  assert.equal(controller.snapshot.status, "error");
  assert.equal(controller.snapshot.error, "indirilen dosya doğrulanamadı");
  assert.deepEqual(controller.install(), { ok: false, reason: "not-ready" });
  assert.equal(updater.installs.length, 0);
  updater.downloadError = null;
  await controller.downloadNow();
  assert.equal(controller.snapshot.status, "ready");
});

test("in a voice room: no automatic check, no restart; leaving runs the check a minute later", async () => {
  const { timers, updater, controller } = setup();
  controller.start();
  controller.setInVoice(true);
  await timers.advance(FIRST_CHECK_DELAY_MS);
  assert.equal(updater.checks, 0, "deferred during the call");
  controller.setInVoice(false);
  await timers.advance(AFTER_CALL_DELAY_MS - 1);
  assert.equal(updater.checks, 0);
  await timers.advance(1);
  assert.equal(updater.checks, 1);
  assert.equal(controller.snapshot.status, "ready");
  controller.setInVoice(true);
  assert.deepEqual(controller.install(), { ok: false, reason: "in-voice" });
  assert.equal(updater.installs.length, 0, "never restarts during a call");
  controller.setInVoice(false);
  assert.deepEqual(controller.install(), { ok: true });
});

test("a manual check during a call is honoured (the user asked)", async () => {
  const { updater, controller } = setup();
  controller.start();
  controller.setInVoice(true);
  await controller.checkNow();
  assert.equal(updater.checks, 1);
  assert.equal(controller.snapshot.status, "ready");
});

test("an automatic check that finds an update as a call starts downloads only after the call", async () => {
  const { timers, updater, controller } = setup();
  controller.start();
  let open!: () => void;
  updater.checkGate = new Promise((resolve) => (open = resolve));
  await timers.advance(FIRST_CHECK_DELAY_MS);
  controller.setInVoice(true); // joins while the check is on its way
  open();
  await flush();
  assert.equal(controller.snapshot.status, "available");
  assert.equal(updater.downloads, 0, "no download during the call");
  controller.setInVoice(false);
  await timers.advance(AFTER_CALL_DELAY_MS);
  assert.equal(updater.downloads, 1);
  assert.equal(controller.snapshot.status, "ready");
});

test("automatic download off: available, the user downloads; switching it on downloads", async () => {
  const { updater, controller, settings } = setup({ auto: false });
  controller.start();
  await controller.checkNow();
  assert.equal(controller.snapshot.status, "available");
  assert.equal(controller.snapshot.autoDownload, false);
  assert.equal(updater.downloads, 0);
  controller.setAutoDownload(true);
  assert.equal(settings.value, true, "the switch is saved");
  await flush();
  assert.equal(controller.snapshot.status, "ready");
  assert.equal(updater.downloads, 1);
});

test("where self-update is impossible nothing is loaded or scheduled", async () => {
  const { timers, controller, created, states } = setup({ capability: { kind: "manual", reason: "unsigned-mac" } });
  controller.start();
  await timers.advance(CHECK_INTERVAL_MS * 2);
  assert.equal(created(), 0);
  assert.equal(states.length, 0);
  assert.equal(controller.snapshot.status, "manual");
  assert.equal(controller.snapshot.reason, "unsigned-mac");
  assert.deepEqual(controller.install(), { ok: false, reason: "manual" });
  assert.equal((await controller.checkNow()).status, "manual");
});

test("an updater that cannot be created falls back to the manual path", () => {
  const timers = new FakeTimers();
  const controller = new UpdateController({
    capability: { kind: "auto" },
    currentVersion: "0.7.1",
    platform: "linux",
    settings: memorySettings(),
    createUpdater: () => {
      throw new Error("no app-update.yml");
    },
    onState: () => undefined,
    beforeInstall: () => undefined,
    timers,
    log: { info: () => undefined, warn: () => undefined },
  });
  controller.start();
  assert.equal(controller.snapshot.status, "manual");
  assert.equal(controller.snapshot.reason, "no-config");
  assert.deepEqual(timers.pending, []);
});

test("the settings file keeps the switch; default on", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trio-update-"));
  const store = new UpdateSettingsStore(dir);
  assert.equal(store.getAutoDownload(), true);
  store.setAutoDownload(false);
  assert.equal(new UpdateSettingsStore(dir).getAutoDownload(), false);
  fs.writeFileSync(path.join(dir, "trio-update.json"), "not json");
  assert.equal(store.getAutoDownload(), true);
});
